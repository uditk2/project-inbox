import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import app from '../../../src/app.js';
import {openDatabase} from '../../../src/sqlite.js';
import {insertMessage} from '../../../src/core.js';
import {fileURLToPath} from 'node:url';

test('MCP handshake and fourteen tools work through real local APIs; draft retries send once',async()=>{
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
    const tools=await client.listTools();assert.equal(tools.tools.length,14);
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
    const logged=await call('log_task',{task_date:'2026-10-25',title:'Paizix submission',project:'test',kind:'listing',status:'sent',external_ref:'paizix-1'});
    const updated=await call('log_task',{task_date:'2026-10-25',title:'Paizix submission',status:'published',result_url:'https://example.com/listing',external_ref:'paizix-1'});
    assert.equal(updated.tasks[0].id,logged.tasks[0].id);
    const listed=await call('list_tasks',{from:'2026-10-01',to:'2026-10-31',project:'test'});
    assert.equal(listed.tasks.length,1);assert.equal(listed.tasks[0].status,'published');
    await call('sync_schedules',{schedules:[{source:'claude',external_id:'trig_1',name:'News queue',cadence_type:'cron',cadence:'CRON_TZ=Asia/Calcutta 0 9 * * *'}]});
    await call('sync_schedules',{schedules:[{source:'claude',external_id:'trig_1',name:'News queue (renamed)',cadence_type:'cron',cadence:'0 9 * * *',enabled:false}]});
    const scheduled=(await call('list_schedules')).schedules;
    assert.equal(scheduled.length,1);assert.equal(scheduled[0].name,'News queue (renamed)');assert.equal(scheduled[0].enabled,false);
    const resumed=await call('update_schedule',{source:'claude',external_id:'trig_1',enabled:true,cadence:'30 9 * * 1-5'});
    assert.equal(resumed.schedule.enabled,true);assert.equal(resumed.schedule.cadence,'30 9 * * 1-5');assert.equal(resumed.schedule.name,'News queue (renamed)');
    assert.equal((await client.callTool({name:'update_schedule',arguments:{source:'claude',external_id:'missing',enabled:false}})).isError,true);
    // a task is started, progressed by external_ref, and keeps its history
    await call('log_task',{task_date:'2026-10-26',title:'Directory submission',project:'test',kind:'listing',status:'in_progress',external_ref:'dir-1',schedule_source:'claude',schedule_external_id:'trig_1',note:'Started from the scheduled run'});
    const progressed=await call('update_task',{external_ref:'dir-1',status:'sent',note:'Provider accepted the submission'});
    assert.equal(progressed.task.status,'sent');assert.equal(progressed.task.title,'Directory submission');assert.equal(progressed.task.schedule_external_id,'trig_1');
    await call('update_task',{id:progressed.task.id,status:'published',result_url:'https://example.com/dir/listing'});
    const history=await call('get_task',{id:progressed.task.id});
    assert.deepEqual(history.events.map(e=>e.status),['in_progress','sent','published']);
    assert.equal(history.events[1].note,'Provider accepted the submission');
    assert.equal((await client.callTool({name:'update_task',arguments:{external_ref:'nope',status:'sent'}})).isError,true);
    assert.equal((await client.callTool({name:'log_task',arguments:{task_date:'2026-02-30',title:'Bad date'}})).isError,true);
  } finally {
    await client.close();http.closeAllConnections();await new Promise(resolve=>http.close(resolve));DB.close();globalThis.fetch=originalFetch;
  }
});
