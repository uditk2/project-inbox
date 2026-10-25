import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/app.js';
import { openDatabase } from '../src/sqlite.js';
import { accounts, normalizeReceived, validateSend, loadAccounts, insertMessage } from '../src/core.js';
import {safeMessageHtml} from '../src/format.js';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync} from 'node:fs';
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

test('task calendar stores, upserts, filters and validates tasks locally',async()=>{
  const f=await fixture();try {
    const base={task_date:'2026-10-25',project:'studio',kind:'listing',title:'Paizix submission',destination:'paizix.com',status:'sent',external_ref:'paizix-1'};
    const created=await worker.fetch(request('/api/tasks','POST',base),f.env);assert.equal(created.status,201);
    const id=(await created.json()).tasks[0].id;
    // same external_ref updates the existing row and keeps unspecified fields
    const again=await (await worker.fetch(request('/api/tasks','POST',{external_ref:'paizix-1',status:'published',result_url:'https://paizix.com/yantra'}),f.env)).json();
    assert.equal(again.tasks[0].id,id);assert.equal(again.tasks[0].title,'Paizix submission');assert.equal(again.tasks[0].status,'published');
    await worker.fetch(request('/api/tasks','POST',{tasks:[{...base,task_date:'2026-09-02',external_ref:'old',title:'Older'},{...base,task_date:'2026-10-26',project:'workshop',external_ref:'other',title:'Other project'}]}),f.env);
    const month=await (await worker.fetch(request('/api/tasks?from=2026-10-01&to=2026-10-31'),f.env)).json();
    assert.deepEqual(month.tasks.map(t=>t.title),['Other project','Paizix submission']);
    assert.equal((await (await worker.fetch(request('/api/tasks?project=studio'),f.env)).json()).tasks.length,2);
    // a batch with one bad row writes nothing
    const before=(await (await worker.fetch(request('/api/tasks'),f.env)).json()).tasks.length;
    assert.equal((await worker.fetch(request('/api/tasks','POST',{tasks:[{...base,external_ref:'ok-row',title:'Fine'},{...base,external_ref:'bad-row',status:'done'}]}),f.env)).status,400);
    assert.equal((await (await worker.fetch(request('/api/tasks'),f.env)).json()).tasks.length,before);
    for(const bad of [{...base,task_date:'2026-02-30'},{...base,title:'  '},{...base,result_url:'javascript:alert(1)'},{...base,project:'Bad Project'},{...base,kind:'spam'}])
      assert.equal((await worker.fetch(request('/api/tasks','POST',bad),f.env)).status,400);
    assert.equal((await worker.fetch(request('/api/tasks?from=nope'),f.env)).status,400);
    const cross=new Request('http://localhost:8787/api/tasks',{method:'POST',headers:{Origin:'https://attacker.example','Content-Type':'application/json'},body:JSON.stringify(base)});
    assert.equal((await worker.fetch(cross,f.env)).status,403);
  }finally{f.close();}
});

test('schedules are saved, updated in place and validated; Codex scan reads only schedule fields',async()=>{
  const f=await fixture();const home=mkdtempSync(join(tmpdir(),'codex-'));try {
    const claude={source:'claude',external_id:'trig_1',name:'News queue',cadence_type:'cron',cadence:'CRON_TZ=Asia/Calcutta 0 9 * * *'};
    assert.equal((await worker.fetch(request('/api/schedules','POST',{schedules:[claude]}),f.env)).status,201);
    await worker.fetch(request('/api/schedules','POST',{...claude,name:'News queue v2',enabled:false}),f.env);
    const list=await (await worker.fetch(request('/api/schedules'),f.env)).json();
    assert.equal(list.schedules.length,1);assert.equal(list.schedules[0].name,'News queue v2');assert.equal(list.schedules[0].enabled,false);
    for(const bad of [{...claude,source:'unknown'},{...claude,cadence_type:'weird'},{...claude,cadence:'; DROP TABLE'},{...claude,cadence:'FREQ=DAILY',cadence_type:'cron'},{...claude,name:' '},{...claude,starts_at:'nope'}])
      assert.equal((await worker.fetch(request('/api/schedules','POST',bad),f.env)).status,400);
    // Codex scan: schedule fields only; the prompt, even a multi-line one containing field-like lines, is never read
    mkdirSync(join(home,'automations','daily-post'),{recursive:true});mkdirSync(join(home,'automations','broken'),{recursive:true});
    writeFileSync(join(home,'automations','daily-post','automation.toml'),['id = "daily-post"','name = "Daily post"','prompt = """','name = "injected"','secret instructions','"""','status = "PAUSED"','rrule = "FREQ=DAILY;BYHOUR=10;BYMINUTE=0"','created_at = 1791046480768','[target]','name = "not-this-one"',''].join('\n'));
    writeFileSync(join(home,'automations','broken','automation.toml'),'id = "broken"\n');
    const env={...f.env,CODEX_HOME:home};
    assert.equal((await worker.fetch(request('/api/schedules/scan','POST',{sources:['gmail']}),env)).status,400);
    const scan=await (await worker.fetch(request('/api/schedules/scan','POST',{sources:['codex']}),env)).json();
    assert.deepEqual([scan.found,scan.imported],[true,1]);
    const codex=(await (await worker.fetch(request('/api/schedules'),f.env)).json()).schedules.find(s=>s.source==='codex');
    assert.equal(codex.name,'Daily post');assert.equal(codex.enabled,false);assert.equal(codex.cadence,'FREQ=DAILY;BYHOUR=10;BYMINUTE=0');
    assert.ok(!JSON.stringify(codex).includes('secret instructions'));
    const missing=await (await worker.fetch(request('/api/schedules/scan','POST',{sources:['codex']}),{...f.env,CODEX_HOME:join(home,'nope')})).json();
    assert.deepEqual([missing.found,missing.imported],[false,0]);
  }finally{rmSync(home,{recursive:true,force:true});f.close();}
});
test('recurrence expands daily, hourly, weekly, once-only and cron schedules into calendar days',async()=>{
  const R=await import('../public/calendar/recurrence.js');
  const from=new Date(2026,9,1),to=new Date(2026,9,31);const days=s=>[...R.project(s,from,to).keys()];
  const daily=days({cadence_type:'rrule',cadence:'FREQ=DAILY;BYHOUR=10;BYMINUTE=0',starts_at:new Date(2026,9,20,8,0).toISOString()});
  assert.equal(daily[0],'2026-10-20');assert.equal(daily.length,12);
  assert.deepEqual(days({cadence_type:'rrule',cadence:'FREQ=DAILY;COUNT=1;BYHOUR=19;BYMINUTE=47',starts_at:new Date(2026,9,24,19,44).toISOString()}),['2026-10-24']);
  assert.equal(R.project({cadence_type:'rrule',cadence:'FREQ=HOURLY;INTERVAL=1',starts_at:new Date(2026,9,29,1,0).toISOString()},from,to).get('2026-10-30').label,'Hourly');
  assert.deepEqual(days({cadence_type:'rrule',cadence:'FREQ=WEEKLY;BYDAY=MO,WE;BYHOUR=9;BYMINUTE=30',starts_at:new Date(2026,9,1,0,0).toISOString()}).slice(0,3),['2026-10-05','2026-10-07','2026-10-12']);
  assert.equal(days({cadence_type:'cron',cadence:'CRON_TZ=Asia/Calcutta 0 9 * * *'}).length,31);
  assert.equal(days({cadence_type:'cron',cadence:'30 8 * * 1-5'}).length,22);
  assert.equal(R.project({cadence_type:'rrule',cadence:'FREQ=MONTHLY;BYMONTHDAY=3'},from,to),null);
  assert.equal(R.describe({cadence_type:'rrule',cadence:'FREQ=DAILY;BYHOUR=10;BYMINUTE=0'}),'Daily at 10:00');
});

test('tasks keep a history, accept PATCH updates, and link to the schedule that triggered them',async()=>{
  const f=await fixture();try {
    const start=await (await worker.fetch(request('/api/tasks','POST',{task_date:'2026-10-26',title:'Directory submission',project:'studio',status:'in_progress',external_ref:'dir-1',schedule_source:'codex',schedule_external_id:'daily-post',note:'Started'}),f.env)).json();
    const id=start.tasks[0].id;
    // an upsert with no status change and no note adds no history line
    await worker.fetch(request('/api/tasks','POST',{external_ref:'dir-1',destination:'example.com'}),f.env);
    const patched=await worker.fetch(request(`/api/tasks/${id}`,'PATCH',{status:'published',result_url:'https://example.com/listing',note:'Verified live'}),f.env);
    assert.equal(patched.status,200);assert.equal((await patched.json()).task.status,'published');
    const detail=await (await worker.fetch(request(`/api/tasks/${id}`),f.env)).json();
    assert.deepEqual(detail.events.map(e=>[e.status,e.note]),[['in_progress','Started'],['published','Verified live']]);
    assert.equal(detail.task.schedule_external_id,'daily-post');assert.equal(detail.task.destination,'example.com');
    assert.equal((await worker.fetch(request('/api/tasks/missing','PATCH',{status:'sent'}),f.env)).status,404);
    assert.equal((await worker.fetch(request(`/api/tasks/${id}`,'PATCH',{status:'done'}),f.env)).status,400);
    assert.equal((await worker.fetch(request(`/api/tasks/${id}`,'PATCH',{schedule_source:'cron-job'}),f.env)).status,400);
    // schedules can be paused and removed through the API
    await worker.fetch(request('/api/schedules','POST',{source:'codex',external_id:'daily-post',name:'Daily post',cadence_type:'rrule',cadence:'FREQ=DAILY;BYHOUR=10;BYMINUTE=0'}),f.env);
    const sid=(await (await worker.fetch(request('/api/schedules'),f.env)).json()).schedules[0].id;
    const paused=await (await worker.fetch(request(`/api/schedules/${sid}`,'PATCH',{enabled:false}),f.env)).json();
    assert.equal(paused.schedule.enabled,false);assert.equal(paused.schedule.name,'Daily post');
    assert.equal((await worker.fetch(request(`/api/schedules/${sid}`,'PATCH',{cadence:'; DROP'}),f.env)).status,400);
    assert.equal((await worker.fetch(request(`/api/schedules/${sid}`,'DELETE',{}),f.env)).status,200);
    assert.equal((await (await worker.fetch(request('/api/schedules'),f.env)).json()).schedules.length,0);
  }finally{f.close();}
});

test('calendar helpers: month grid, CSV backfill and grouping stay pure and predictable',async()=>{
  const {monthGrid,groupBy,plural,ymd}=await import('../public/calendar/format.js');
  const {postLogToTasks,parseCsv}=await import('../public/calendar/csv.js');
  const grid=monthGrid(new Date(2026,9,1));
  assert.deepEqual([ymd(grid.start),grid.weeks,ymd(grid.end)],['2026-09-28',5,'2026-11-01']);
  assert.equal(plural(1,'task'),'1 task');assert.equal(plural(2,'task'),'2 tasks');
  assert.deepEqual([...groupBy([{d:'a'},{d:'b'},{d:'a'}],x=>x.d).keys()],['a','b']);
  assert.deepEqual(parseCsv('a,"b, c","say ""hi"""\r\n1,2,3\n'),[['a','b, c','say "hi"'],['1','2','3']]);
  const csv='date,game,destination,status,result_url,account,notes\n2026-10-23,Puliya,r/WebGames,published,https://reddit.com/x,me,"Posted, verified"\n2026-10-24,Yantra,Paizix,sent,,me,Pending\nnot-a-date,Bad,Row,sent,,,\n2026-10-25,Odd,Somewhere,unknown,,,';
  const {tasks,skipped}=postLogToTasks(csv,'slayfit');
  assert.equal(tasks.length,2);assert.equal(skipped.length,2);
  assert.deepEqual([tasks[0].kind,tasks[0].notes,tasks[0].project],['post','Posted, verified','slayfit']);
  assert.equal(tasks[1].external_ref,'csv|2026-10-24|Paizix|Yantra');
  assert.throws(()=>postLogToTasks('a,b\n1,2','x'),/post-log/);
});

test('setup adds the MCP server to a desktop config without touching other entries', async () => {
  const { withServer, desktopConfigPath } = await import('../src/setup.js');
  const added = JSON.parse(withServer('{"theme":"dark","mcpServers":{"other":{"command":"x"}}}'));
  assert.deepEqual(added.mcpServers['project-inbox'], { command: 'npx', args: ['--yes', 'project-inbox-mcp'] });
  assert.equal(added.mcpServers.other.command, 'x');
  assert.equal(added.theme, 'dark');
  assert.ok(JSON.parse(withServer('')).mcpServers['project-inbox']);
  assert.equal(withServer(JSON.stringify(added)), null);
  assert.throws(() => withServer('[]'));
  assert.throws(() => withServer('{"mcpServers":[]}'));
  assert.throws(() => withServer('not json'));
  assert.match(desktopConfigPath({ platform: 'darwin', home: '/h' }), /Library\/Application Support\/Claude/);
  assert.match(desktopConfigPath({ platform: 'win32', home: '/h', env: { APPDATA: '/a' } }), /Claude/);
});

test('setup registers each tool once, asks first, and reports what it did', async () => {
  const { runSetup } = await import('../src/setup.js');
  const { mkdtempSync, readFileSync, existsSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'pi-setup-'));
  const desktop = join(dir, 'claude_desktop_config.json');
  writeFileSync(desktop, '{"mcpServers":{"keep":{"command":"y"}}}');
  const calls = [];
  const exec = async (bin, args) => {
    calls.push([bin, ...args].join(' '));
    if (bin === 'codex') throw Object.assign(new Error('not installed'), { code: 'ENOENT' });
    return { stdout: args[0] === 'mcp' && args[1] === 'list' ? 'other: npx x' : 'ok' };
  };
  const asked = [];
  const log = () => {};
  let results = await runSetup({ exec, files: { desktop }, log, ask: async q => { asked.push(q); return !q.includes('Desktop'); } });
  assert.deepEqual(results, { 'Claude Code': 'added', Codex: 'missing', 'Claude Desktop': 'skipped' });
  assert.ok(calls.includes('claude mcp add --scope user project-inbox -- npx --yes project-inbox-mcp'));
  assert.ok(!existsSync(`${desktop}.bak`));
  results = await runSetup({ yes: true, exec, files: { desktop }, log, ask: async () => { throw new Error('should not ask'); } });
  assert.equal(results['Claude Desktop'], 'added');
  const saved = JSON.parse(readFileSync(desktop, 'utf8'));
  assert.ok(saved.mcpServers['project-inbox'] && saved.mcpServers.keep);
  assert.ok(existsSync(`${desktop}.bak`));
  results = await runSetup({ yes: true, exec, files: { desktop }, log });
  assert.equal(results['Claude Desktop'], 'done');
  const listed = async (bin, args) => ({ stdout: args[1] === 'list' ? 'project-inbox: npx --yes project-inbox-mcp' : '' });
  assert.equal((await runSetup({ yes: true, exec: listed, files: { desktop }, log }))['Claude Code'], 'done');
});

test('setup can be limited to chosen tools', async () => {
  const { runSetup, parseTargets } = await import('../src/setup.js');
  assert.equal(parseTargets(''), null);
  assert.deepEqual(parseTargets('codex'), ['codex']);
  assert.deepEqual(parseTargets('claude').sort(), ['claude-code', 'claude-desktop']);
  assert.equal(parseTargets('all').length, 3);
  assert.throws(() => parseTargets('cursor'), /Unknown tool/);
  const calls = [];
  const exec = async (bin, args) => { calls.push(bin); return { stdout: '' }; };
  const results = await runSetup({ only: ['codex'], exec, log: () => {}, files: { desktop: '/nonexistent/dir/x.json' }, ask: async () => { throw new Error('should not ask'); } });
  assert.deepEqual(results, { Codex: 'added' });
  assert.ok(calls.every(bin => bin === 'codex'));
});
