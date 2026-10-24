import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/app.js';
import { openDatabase } from '../src/sqlite.js';
import { accounts, normalizeReceived, validateSend, loadAccounts, insertMessage } from '../src/core.js';
import {safeMessageHtml} from '../src/format.js';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const configured = [{id:'studio',name:'Studio',mailbox:'hello@studio.example',apiKey:'re_test_only',webhookSecret:`whsec_${Buffer.from('test-secret-with-enough-entropy').toString('base64')}`}];
async function fixture() {
  const DB = openDatabase(':memory:',new URL('../migrations/',import.meta.url));
  const env = { DB, LOCAL_APP:'true', CREDENTIALS_KEY:'test-encryption-key-32-characters-long', MAIL_ACCOUNTS_JSON:JSON.stringify(configured) };
  return {env,close:()=>DB.close()};
}
function request(path,method='GET',body,cookie) {
  return new Request(`http://localhost:8787${path}`,{method,headers:{Origin:'http://localhost:8787','Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},...(body?{body:JSON.stringify(body)}:{})});
}
test('local-only host validation and same-origin writes block remote websites',async()=>{
  const f=await fixture();try {
    assert.equal((await worker.fetch(new Request('https://attacker.example/api/session'),f.env)).status,403);
    assert.equal((await worker.fetch(request('/api/session'),{})).status,403);
    const cross=new Request('http://localhost:8787/api/send',{method:'POST',headers:{Origin:'https://attacker.example','Content-Type':'application/json'},body:'{}'});
    assert.equal((await worker.fetch(cross,f.env)).status,403);
    const noOrigin=new Request('http://localhost:8787/api/accounts',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
    assert.equal((await worker.fetch(noOrigin,f.env)).status,403);
  }finally{f.close();}
});
test('account keys are encrypted, tamper-evident, and absent from session responses',async()=>{
  const f=await fixture();try {
    const cookie='';
    const response=await worker.fetch(request('/api/accounts','POST',{id:'workshop',name:'Workshop',mailbox:'hello@workshop.example',apiKey:'re_new_test_key'},cookie),f.env);
    assert.equal(response.status,200);
    const row=await f.env.DB.prepare('SELECT * FROM mail_accounts WHERE id=?').bind('workshop').first();
    assert.ok(!row.encrypted_credentials.includes('re_new_test_key'));
    assert.equal((await loadAccounts(f.env)).find(a=>a.id==='workshop').apiKey,'re_new_test_key');
    const session=await (await worker.fetch(request('/api/session','GET',null,cookie),f.env)).text();
    assert.ok(!session.includes('re_new_test_key'));assert.ok(!session.includes('webhookSecret'));
    await assert.rejects(loadAccounts({...f.env,CREDENTIALS_KEY:'different-encryption-key-32-chars-long'}));
    const changed=JSON.parse(row.encrypted_credentials);changed.data=changed.data.slice(0,-4)+'AAAA';
    await f.env.DB.prepare('UPDATE mail_accounts SET encrypted_credentials=?').bind(JSON.stringify(changed)).run();
    await assert.rejects(loadAccounts(f.env));
  }finally{f.close();}
});
test('mailbox identity and recipient validation prevent cross-account or header injection',()=>{
  assert.throws(()=>normalizeReceived(configured[0],{id:'1',to:['other@example.com']}),{status:422});
  assert.throws(()=>accounts({MAIL_ACCOUNTS_JSON:JSON.stringify([...configured,...configured])}));
  assert.throws(()=>validateSend({accountId:'studio',to:'bad',subject:'a',text:'b',requestId:crypto.randomUUID()},configured),{status:400});
  assert.throws(()=>validateSend({accountId:'studio',to:'person@example.com',subject:'a\r\nBcc: x',text:'b',requestId:crypto.randomUUID()},configured),{status:400});
});
test('polling backfills without webhooks and fetches bodies on demand without resetting read state',async()=>{
  const f=await fixture();const originalFetch=globalThis.fetch;const paths=[];
  globalThis.fetch=async url=>{paths.push(url);return Response.json(url.includes('/emails?')?{data:[],has_more:false}:url.includes('?')?{data:[{id:'sync-1',from:'maya@example.com',to:['hello@studio.example'],subject:'Synced',created_at:new Date().toISOString()}],has_more:false}:{id:'sync-1',from:'maya@example.com',to:['hello@studio.example'],subject:'Synced',text:'Fetched body',message_id:'<sync@example.com>'});};
  try {
    const cookie='';
    assert.equal((await worker.fetch(request('/api/sync','POST',{accountId:'studio'},cookie),f.env)).status,200);
    const id='studio:in:sync-1';
    await worker.fetch(request(`/api/messages/${encodeURIComponent(id)}`,'PATCH',{read:true},cookie),f.env);
    const full=await (await worker.fetch(request(`/api/messages/${encodeURIComponent(id)}`,'GET',null,cookie),f.env)).json();
    assert.equal(full.body_text,'Fetched body');assert.equal(full.is_read,1);
    await worker.fetch(request('/api/sync','POST',{accountId:'studio'},cookie),f.env);
    assert.equal((await f.env.DB.prepare('SELECT count(*) AS n FROM messages').first()).n,1);
    assert.equal(paths.length,5);
  }finally{globalThis.fetch=originalFetch;f.close();}
});
test('send is idempotent and from identity comes from the chosen account',async()=>{
  const f=await fixture();const originalFetch=globalThis.fetch;let calls=0;let sent;
  globalThis.fetch=async(_url,options)=>{calls++;sent=JSON.parse(options.body);return Response.json({id:'sent-1'});};
  try {
    const cookie='';const payload={accountId:'studio',to:'reader@example.com',subject:'A message',text:'Hello',requestId:crypto.randomUUID(),from:'attacker@example.com'};
    for(let i=0;i<2;i++) assert.equal((await worker.fetch(request('/api/send','POST',payload,cookie),f.env)).status,200);
    assert.equal(calls,1);assert.equal(sent.from,'Studio <hello@studio.example>');
    assert.equal((await worker.fetch(request('/api/send','POST',{...payload,text:'Changed'},cookie),f.env)).status,409);
    assert.equal((await f.env.DB.prepare('SELECT count(*) AS n FROM messages').first()).n,1);
  }finally{globalThis.fetch=originalFetch;f.close();}
});
test('draft composition never sends, validates account and recipients, and sends idempotently',async()=>{
  const f=await fixture();const originalFetch=globalThis.fetch;let calls=0;let sent;
  globalThis.fetch=async(_url,options)=>{calls++;sent=JSON.parse(options.body);return Response.json({id:'draft-send-1'});};
  try {
    const payload={accountId:'studio',to:['reader@example.com'],subject:'Draft',text:'Hello'};
    assert.equal((await worker.fetch(request('/api/drafts','POST',{...payload,to:['bad']}),f.env)).status,400);
    assert.equal((await worker.fetch(request('/api/drafts','POST',{...payload,replyToId:'other-account-message'}),f.env)).status,400);
    const response=await worker.fetch(request('/api/drafts','POST',payload),f.env);
    assert.equal(response.status,201);
    const draft=await response.json();assert.equal(draft.status,'draft');assert.equal(calls,0);
    const drafts=await (await worker.fetch(request('/api/drafts'),f.env)).json();assert.equal(drafts.drafts.length,1);
    for(let i=0;i<2;i++) assert.equal((await worker.fetch(request(`/api/drafts/${draft.id}/send`,'POST',{}),f.env)).status,200);
    assert.equal(calls,1);assert.deepEqual(sent.to,payload.to);assert.equal(sent.from,'Studio <hello@studio.example>');
    assert.equal((await (await worker.fetch(request(`/api/drafts/${draft.id}`),f.env)).json()).status,'sent');
  } finally {globalThis.fetch=originalFetch;f.close();}
});
test('rich mail preserves formatting while stripping executable and remote content',()=>{
  const clean=safeMessageHtml('<p><span style="font-family: Georgia; font-weight: bold">Hello</span><script>alert(1)</script><img src="https://tracker.example/pixel"><a href="javascript:alert(1)" onclick="evil()">bad</a><a href="https://example.com">good</a></p>');
  assert.match(clean,/font-family:Georgia/);assert.match(clean,/font-weight:bold/);
  assert.ok(!clean.includes('<script'));assert.ok(!clean.includes('<img'));assert.ok(!clean.includes('javascript:'));assert.ok(!clean.includes('onclick'));
  assert.match(clean,/href="https:\/\/example.com"/);
});
test('encrypted accounts survive database reopen',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'project-inbox-test-'));
  const migrations=new URL('../migrations/',import.meta.url);
  let db=openDatabase(join(dir,'inbox.sqlite'),migrations);
  const env={DB:db,LOCAL_APP:'true',CREDENTIALS_KEY:'persistent-test-key-32-characters-long'};
  try {
    assert.equal((await worker.fetch(request('/api/accounts','POST',{id:'persist',name:'Persist',mailbox:'hello@persist.example',apiKey:'re_persistence_test'}),env)).status,200);
    db.close();db=openDatabase(join(dir,'inbox.sqlite'),migrations);env.DB=db;
    const loaded=await loadAccounts(env);
    assert.equal(loaded[0].apiKey,'re_persistence_test');
  }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
test('Trash restores messages and permanent deletion removes content without resurrection',async()=>{
  const f=await fixture();try {
    const message=normalizeReceived(configured[0],{id:'trash-test',from:'reader@example.com',to:['hello@studio.example'],subject:'Temporary',text:'Body to delete'});
    await insertMessage(f.env.DB,message).run();
    const path=`/api/messages/${encodeURIComponent(message.id)}`;
    assert.equal((await worker.fetch(request(path,'DELETE',{confirm:true}),f.env)).status,404);
    await worker.fetch(request(path,'PATCH',{trashed:true}),f.env);
    assert.equal((await (await worker.fetch(request('/api/messages?folder=inbox'),f.env)).json()).messages.length,0);
    assert.equal((await (await worker.fetch(request('/api/messages?folder=trash'),f.env)).json()).messages.length,1);
    await worker.fetch(request(path,'PATCH',{trashed:false}),f.env);
    assert.equal((await (await worker.fetch(request('/api/messages'),f.env)).json()).messages.length,1);
    await worker.fetch(request(path,'PATCH',{trashed:true}),f.env);
    assert.equal((await worker.fetch(request(path,'DELETE',{confirm:false}),f.env)).status,400);
    assert.equal((await worker.fetch(request(path,'DELETE',{confirm:true}),f.env)).status,200);
    assert.equal((await worker.fetch(request(path),f.env)).status,404);
    await insertMessage(f.env.DB,message).run();
    assert.equal((await f.env.DB.prepare('SELECT count(*) AS n FROM messages').first()).n,0);
    assert.equal((await f.env.DB.prepare('SELECT count(*) AS n FROM deleted_messages').first()).n,1);
  }finally{f.close();}
});
test('feedback remains local and exports only explicitly entered text',async()=>{
  const f=await fixture();try {
    const response=await worker.fetch(request('/api/feedback','POST',{message:'Please improve keyboard navigation.'}),f.env);
    assert.equal(response.status,200);
    const data=await (await worker.fetch(request('/api/feedback'),f.env)).json();
    assert.equal(data.feedback[0].message,'Please improve keyboard navigation.');
    const exported=await (await worker.fetch(request('/api/feedback/export'),f.env)).text();
    assert.ok(!exported.includes('apiKey'));assert.ok(!exported.includes('re_test_only'));
    assert.equal((await worker.fetch(request('/api/feedback','POST',{message:''}),f.env)).status,400);
  }finally{f.close();}
});
