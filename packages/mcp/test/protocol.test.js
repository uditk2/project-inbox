import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import app from '../../../src/app.js';
import {openDatabase} from '../../../src/sqlite.js';
import {insertMessage} from '../../../src/core.js';
import {fileURLToPath} from 'node:url';

test('MCP handshake and seven tools work through real local APIs; draft retries send once',async()=>{
  const DB=openDatabase(':memory:',new URL('../../../migrations/',import.meta.url));
  const env={DB,LOCAL_APP:'true',MAIL_ACCOUNTS_JSON:JSON.stringify([{id:'test',name:'Test project',mailbox:'hello@example.com',apiKey:'re_test_key_not_for_agents'}])};
  await insertMessage(DB,{id:'test:in:original',account_id:'test',provider_id:'original',direction:'inbound',sender:'reader@example.com',recipients:'["hello@example.com"]',subject:'Hello',body_text:'This is a test message.',body_loaded:1,message_id:'<original@example.com>',received_at:new Date().toISOString()}).run();
  const originalFetch=globalThis.fetch;let sends=0;let sentPayload;
  globalThis.fetch=async(url,options)=>{
    if(options?.method==='POST') {sends++;sentPayload=JSON.parse(options.body);return Response.json({id:'test-sent'});}
    return Response.json({data:[],has_more:false});
  };
  const http=createServer(async(req,res)=>{
    try {
      const chunks=[];for await(const chunk of req) chunks.push(chunk);
      const request=new Request(`http://${req.headers.host}${req.url}`,{method:req.method,headers:req.headers,...(chunks.length?{body:Buffer.concat(chunks)}:{})});
      const result=await app.fetch(request,env);
      res.writeHead(result.status,Object.fromEntries(result.headers));res.end(Buffer.from(await result.arrayBuffer()));
    } catch {res.writeHead(500);res.end();}
  });
  await new Promise(resolve=>http.listen(0,'127.0.0.1',resolve));
  const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../bin/cli.js',import.meta.url))],env:{...process.env,PROJECT_INBOX_URL:`http://127.0.0.1:${http.address().port}`},stderr:'pipe'});
  const client=new Client({name:'project-inbox-test',version:'1.0.0'});
  const call=async(name,args={})=>{
    const result=await client.callTool({name,arguments:args});assert.equal(result.isError,undefined,JSON.stringify(result));
    assert.ok(!JSON.stringify(result).includes('re_test_key_not_for_agents'));
    return JSON.parse(result.content[0].text);
  };
  try {
    await client.connect(transport);
    const tools=await client.listTools();assert.equal(tools.tools.length,7);
    assert.equal(tools.tools.find(t=>t.name==='send_draft').annotations.readOnlyHint,false);
    assert.equal((await call('list_accounts')).accounts[0].id,'test');
    assert.equal((await call('sync_mail',{accountId:'test'})).hasMore,false);
    assert.equal((await call('list_messages',{query:'Hello'})).messages.length,1);
    assert.equal((await call('read_message',{messageId:'test:in:original'})).text,'This is a test message.');
    const invalid=await client.callTool({name:'compose_message',arguments:{accountId:'test',to:['invalid'],subject:'Test',text:'Hi'}});
    assert.equal(invalid.isError,true);assert.equal(sends,0);
    const draft=await call('compose_message',{accountId:'test',to:['reader@example.com'],subject:'Re: Hello',text:'Reply from the test account.',replyToId:'test:in:original'});
    assert.equal(sends,0);assert.equal(draft.status,'draft');
    assert.equal((await call('list_drafts')).drafts[0].id,draft.id);
    const first=await call('send_draft',{draftId:draft.id});
    assert.deepEqual(await call('send_draft',{draftId:draft.id}),first);
    assert.equal(sends,1);assert.equal(sentPayload.from,'Test project <hello@example.com>');
    assert.equal(sentPayload.headers['In-Reply-To'],'<original@example.com>');
    assert.deepEqual(sentPayload.to,['reader@example.com']);
    assert.equal((await call('list_drafts')).drafts[0].status,'sent');
  } finally {
    await client.close();http.closeAllConnections();await new Promise(resolve=>http.close(resolve));DB.close();globalThis.fetch=originalFetch;
  }
});
