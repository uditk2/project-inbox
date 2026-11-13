import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import worker from '../src/worker.js';
import {authenticate, verifyWebhook, syncAll, syncUntilDone} from '../src/hosted.js';
import {openDatabase} from '../src/sqlite.js';
import {loadAccounts} from '../src/core.js';

const TOKEN = 'hosted-test-token-at-least-32-characters-long';
const SECRET_BYTES = Buffer.from('test-secret-with-enough-entropy');
const SECRET = `whsec_${SECRET_BYTES.toString('base64')}`;
const accountsJson = [{id:'studio',name:'Studio',mailbox:'hello@studio.example',apiKey:'re_test_only',webhookSecret:SECRET}];
const ORIGIN = 'https://inbox.example.com';

function fixture(extra = {}) {
  const DB = openDatabase(':memory:', new URL('../migrations/', import.meta.url));
  const env = {DB, HOSTED:'true', INBOX_TOKEN:TOKEN, CREDENTIALS_KEY:'test-encryption-key-32-characters-long', MAIL_ACCOUNTS_JSON:JSON.stringify(accountsJson),
    ASSETS:{fetch:async () => new Response('<html>app</html>', {headers:{'Content-Type':'text/html'}})}, ...extra};
  return {env, close:() => DB.close()};
}
const bearer = {Authorization:`Bearer ${TOKEN}`};
const req = (path, {method = 'GET', headers = {}, body} = {}) => new Request(`${ORIGIN}${path}`, {method, headers, ...(body === undefined ? {} : {body})});
const jsonReq = (path, method, body, headers = {}) => req(path, {method, headers:{'Content-Type':'application/json', ...headers}, body:JSON.stringify(body)});
const sign = (id, timestamp, body, secretBytes = SECRET_BYTES) => `v1,${createHmac('sha256', secretBytes).update(`${id}.${timestamp}.${body}`).digest('base64')}`;
const nowSeconds = () => String(Math.floor(Date.now() / 1000));
function hook(id, body, {timestamp = nowSeconds(), signature, account = 'studio'} = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return req(`/webhooks/resend/${account}`, {method:'POST', headers:{'svix-id':id, 'svix-timestamp':timestamp, 'svix-signature':signature ?? sign(id, timestamp, text), 'Content-Type':'application/json'}, body:text});
}
function stubResend(mails) {
  const original = globalThis.fetch; const calls = [];
  globalThis.fetch = async url => {
    calls.push(String(url));
    if (String(url).includes('/emails?')) return Response.json({data:[], has_more:false});
    if (String(url).includes('/emails/receiving?')) return Response.json({data:mails, has_more:false});
    return Response.json({});
  };
  return {calls, restore:() => { globalThis.fetch = original; }};
}
const mail = id => ({id, from:'maya@example.com', to:['hello@studio.example'], subject:`Mail ${id}`, created_at:new Date().toISOString()});

test('without a valid token or session nothing is served, and a missing token fails closed', async () => {
  const f = fixture();
  try {
    const anonymous = await worker.fetch(req('/api/session'), f.env);
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.headers.get('WWW-Authenticate'), 'Bearer');
    assert.equal((await worker.fetch(req('/mcp', {method:'POST', body:'{}'}), f.env)).status, 401);
    const page = await worker.fetch(req('/'), f.env);
    assert.equal(page.status, 302);
    assert.equal(page.headers.get('Location'), `${ORIGIN}/login`);
    assert.equal((await worker.fetch(req('/api/session', {headers:{Authorization:'Bearer wrong-token'}}), f.env)).status, 401);
    assert.equal((await worker.fetch(req('/health'), f.env)).status, 200);
    for (const env of [{...f.env, INBOX_TOKEN:undefined}, {...f.env, INBOX_TOKEN:'too-short'}]) {
      assert.equal((await worker.fetch(req('/api/session', {headers:bearer}), env)).status, 503);
      assert.equal((await worker.fetch(req('/'), env)).status, 503);
    }
  } finally { f.close(); }
});

test('a bearer token reaches the API and never exposes provider keys or webhook secrets', async () => {
  const f = fixture();
  try {
    const response = await worker.fetch(req('/api/session', {headers:bearer}), f.env);
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.equal(JSON.parse(text).accounts[0].id, 'studio');
    assert.ok(!text.includes('re_test_only') && !text.includes('whsec_'));
    // Writes with a bearer token need no Origin header: browsers never attach one on their own.
    const written = await worker.fetch(jsonReq('/api/tasks', 'POST', {task_date:'2026-11-13', title:'Hosted task', project:'slayfit', external_ref:'t1'}, bearer), f.env);
    assert.equal(written.status, 201);
    const listed = await (await worker.fetch(req('/api/tasks', {headers:bearer}), f.env)).json();
    assert.equal(listed.tasks[0].title, 'Hosted task');
  } finally { f.close(); }
});

test('browser sign-in sets a strict cookie, and cookie writes must be same-origin JSON', async () => {
  const f = fixture();
  try {
    assert.equal((await worker.fetch(req('/login'), f.env)).status, 200);
    const bad = await worker.fetch(req('/login', {method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:'token=nope'}), f.env);
    assert.equal(bad.status, 401);
    assert.ok(!bad.headers.get('Set-Cookie'));
    const foreign = await worker.fetch(req('/login', {method:'POST', headers:{Origin:'https://attacker.example', 'Content-Type':'application/x-www-form-urlencoded'}, body:`token=${TOKEN}`}), f.env);
    assert.equal(foreign.status, 403);
    const ok = await worker.fetch(req('/login', {method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:`token=${encodeURIComponent(TOKEN)}`}), f.env);
    assert.equal(ok.status, 303);
    const setCookie = ok.headers.get('Set-Cookie');
    assert.match(setCookie, /HttpOnly/); assert.match(setCookie, /SameSite=Strict/); assert.match(setCookie, /Secure/);
    assert.ok(!setCookie.includes(TOKEN));
    const cookie = setCookie.split(';')[0];
    const home = await worker.fetch(req('/', {headers:{Cookie:cookie}}), f.env);
    assert.equal(home.status, 200);
    assert.match(home.headers.get('Content-Security-Policy'), /default-src 'self'/);
    assert.equal((await worker.fetch(req('/api/session', {headers:{Cookie:cookie}}), f.env)).status, 200);
    const noOrigin = await worker.fetch(jsonReq('/api/feedback', 'POST', {message:'hi'}, {Cookie:cookie}), f.env);
    assert.equal(noOrigin.status, 403);
    const sameOrigin = await worker.fetch(jsonReq('/api/feedback', 'POST', {message:'hi'}, {Cookie:cookie, Origin:ORIGIN}), f.env);
    assert.equal(sameOrigin.status, 200);
    // A cookie never opens the MCP endpoint, and a tampered or expired one is refused.
    assert.equal((await worker.fetch(req('/mcp', {method:'POST', headers:{Cookie:cookie}, body:'{}'}), f.env)).status, 401);
    const [expires, signature] = cookie.split('=')[1].split('.');
    assert.equal(await authenticate(req('/api/session', {headers:{Cookie:`pi_session=${Number(expires) + 100}.${signature}`}}), f.env), null);
    assert.equal(await authenticate(req('/api/session', {headers:{Cookie:cookie}}), f.env, (Number(expires) + 1) * 1000), null);
    const out = await worker.fetch(req('/logout', {method:'POST'}), f.env);
    assert.match(out.headers.get('Set-Cookie'), /Max-Age=0/);
  } finally { f.close(); }
});

test('webhook signatures follow the Svix scheme, and stale, forged or wrongly keyed events are refused', async () => {
  const body = '{"type":"email.received"}';
  const ts = nowSeconds();
  const good = sign('evt_1', ts, body);
  assert.equal(await verifyWebhook({secret:SECRET, id:'evt_1', timestamp:ts, signature:good, body}), true);
  assert.equal(await verifyWebhook({secret:SECRET, id:'evt_1', timestamp:ts, signature:`v1,AAAA ${good}`, body}), true, 'any listed signature may match');
  assert.equal(await verifyWebhook({secret:SECRET, id:'evt_1', timestamp:ts, signature:good, body:body + ' '}), false);
  assert.equal(await verifyWebhook({secret:SECRET, id:'evt_2', timestamp:ts, signature:good, body}), false);
  assert.equal(await verifyWebhook({secret:SECRET, id:'evt_1', timestamp:ts, signature:good.replace('v1', 'v2'), body}), false);
  assert.equal(await verifyWebhook({secret:SECRET, id:'evt_1', timestamp:ts, signature:sign('evt_1', ts, body, Buffer.from('another secret')), body}), false);
  const old = String(Number(ts) - 3600);
  assert.equal(await verifyWebhook({secret:SECRET, id:'evt_1', timestamp:old, signature:sign('evt_1', old, body), body}), false);
  assert.equal(await verifyWebhook({secret:'whsec_%%%not-base64', id:'evt_1', timestamp:ts, signature:good, body}), false);
  assert.equal(await verifyWebhook({secret:SECRET, id:null, timestamp:ts, signature:good, body}), false);
});

test('a signed webhook pulls the new mail once, ignores replays, and needs no access token', async () => {
  const f = fixture(); const resend = stubResend([mail('wh-1')]);
  try {
    const first = await worker.fetch(hook('evt_a', {type:'email.received', data:{email_id:'wh-1'}}), f.env);
    assert.equal(first.status, 200);
    assert.equal((await first.json()).synced, 1);
    const messages = (await f.env.DB.prepare('SELECT id,subject FROM messages').all()).results;
    assert.deepEqual(messages.map(m => m.id), ['studio:in:wh-1']);
    const callsAfterFirst = resend.calls.length;
    const replay = await worker.fetch(hook('evt_a', {type:'email.received', data:{email_id:'wh-1'}}), f.env);
    assert.equal((await replay.json()).duplicate, true);
    assert.equal(resend.calls.length, callsAfterFirst, 'a replayed event must not call Resend again');
    const ignored = await worker.fetch(hook('evt_b', {type:'domain.updated'}), f.env);
    assert.equal(ignored.status, 200);
    assert.equal(resend.calls.length, callsAfterFirst, 'events that are not about email do not sync');
    assert.equal((await f.env.DB.prepare('SELECT COUNT(*) AS n FROM webhook_events').first()).n, 2);
  } finally { resend.restore(); f.close(); }
});

test('webhook failures are loud: forged, stale, unknown account, no secret, or a failed sync that Resend should retry', async () => {
  const f = fixture(); const resend = stubResend([mail('wh-2')]);
  try {
    assert.equal((await worker.fetch(hook('e1', {type:'email.received'}, {signature:'v1,AAAA'}), f.env)).status, 401);
    const stale = String(Number(nowSeconds()) - 3600);
    assert.equal((await worker.fetch(hook('e2', {type:'email.received'}, {timestamp:stale}), f.env)).status, 401);
    assert.equal((await worker.fetch(hook('e3', {type:'email.received'}, {account:'nobody'}), f.env)).status, 404);
    assert.equal((await worker.fetch(req('/webhooks/resend/studio', {method:'GET'}), f.env)).status, 405);
    const bare = fixture({MAIL_ACCOUNTS_JSON:JSON.stringify([{...accountsJson[0], webhookSecret:undefined}])});
    assert.equal((await worker.fetch(hook('e4', {type:'email.received'}), bare.env)).status, 503);
    // The secret may come from WEBHOOK_SECRETS_JSON instead of the account entry.
    const viaEnv = fixture({MAIL_ACCOUNTS_JSON:JSON.stringify([{...accountsJson[0], webhookSecret:undefined}]), WEBHOOK_SECRETS_JSON:JSON.stringify({studio:SECRET})});
    assert.equal((await worker.fetch(hook('e5', {type:'email.received'}), viaEnv.env)).status, 200);
    bare.close(); viaEnv.close();
    assert.equal((await f.env.DB.prepare('SELECT COUNT(*) AS n FROM messages').first()).n, 0, 'nothing is stored for refused events');
    resend.restore();
    globalThis.fetch = async () => new Response('nope', {status:500});
    const failed = await worker.fetch(hook('e6', {type:'email.received'}), f.env);
    assert.equal(failed.status, 502);
    assert.equal((await f.env.DB.prepare('SELECT COUNT(*) AS n FROM webhook_events WHERE event_id=?').bind('e6').first()).n, 0, 'a failed sync is not marked done');
  } finally { resend.restore(); f.close(); }
});

test('the webhook secret can be saved with an account, stays sealed, and is validated', async () => {
  const f = fixture();
  try {
    const save = body => worker.fetch(jsonReq('/api/accounts', 'POST', body, bearer), f.env);
    assert.equal((await save({id:'workshop', name:'Workshop', mailbox:'hi@workshop.example', apiKey:'re_workshop_key', webhookSecret:'not-a-secret'})).status, 400);
    assert.equal((await save({id:'workshop', name:'Workshop', mailbox:'hi@workshop.example', apiKey:'re_workshop_key', webhookSecret:SECRET})).status, 200);
    const row = await f.env.DB.prepare('SELECT * FROM mail_accounts WHERE id=?').bind('workshop').first();
    assert.ok(!row.encrypted_credentials.includes('re_workshop_key') && !row.encrypted_credentials.includes('whsec_'));
    assert.equal((await loadAccounts(f.env)).find(a => a.id === 'workshop').webhookSecret, SECRET);
    // Editing without re-entering the secret keeps it.
    assert.equal((await save({id:'workshop', name:'Workshop 2', mailbox:'hi@workshop.example'})).status, 200);
    assert.equal((await loadAccounts(f.env)).find(a => a.id === 'workshop').webhookSecret, SECRET);
    const session = await (await worker.fetch(req('/api/session', {headers:bearer}), f.env)).text();
    assert.ok(!session.includes('whsec_') && !session.includes('re_workshop_key'));
  } finally { f.close(); }
});

test('cron sync covers every account, reports a failing one without stopping the rest, and prunes old events', async () => {
  const two = [...accountsJson, {id:'workshop', name:'Workshop', mailbox:'hi@workshop.example', apiKey:'re_other_key'}];
  const f = fixture({MAIL_ACCOUNTS_JSON:JSON.stringify(two)});
  try {
    await f.env.DB.prepare('INSERT INTO webhook_events VALUES (?,?,?)').bind('studio', 'ancient', '2020-01-01T00:00:00.000Z').run();
    await f.env.DB.prepare('INSERT INTO webhook_events VALUES (?,?,?)').bind('studio', 'recent', new Date().toISOString()).run();
    const seen = [];
    const report = await syncAll(f.env, 3, async (_db, account) => { seen.push(account.id); if (account.id === 'studio') throw new Error('boom with re_secret'); return {synced:2, hasMore:false}; });
    assert.deepEqual(seen, ['studio', 'workshop']);
    assert.equal(report[0].error, 'Sync failed');
    assert.ok(!JSON.stringify(report).includes('re_secret'));
    assert.deepEqual(report[1], {account:'workshop', synced:2, hasMore:false});
    assert.deepEqual((await f.env.DB.prepare('SELECT event_id FROM webhook_events').all()).results.map(r => r.event_id), ['recent']);
    // Paging is bounded, so one tick cannot run away on a large mailbox.
    let pages = 0;
    const bounded = await syncUntilDone(f.env.DB, two[0], 3, async () => { pages++; return {synced:1, hasMore:true}; });
    assert.deepEqual([pages, bounded.synced, bounded.hasMore], [3, 3, true]);
    // The scheduled entry point runs the same job.
    const resend = stubResend([mail('cron-1')]); const pending = [];
    try {
      await worker.scheduled({}, {...f.env, MAIL_ACCOUNTS_JSON:JSON.stringify([accountsJson[0]])}, {waitUntil:p => pending.push(p)});
      await Promise.all(pending);
      assert.equal((await f.env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE id='studio:in:cron-1'").first()).n, 1);
    } finally { resend.restore(); }
  } finally { f.close(); }
});

test('hosted mode cannot scan this computer for Codex schedules and says how to push them instead', async () => {
  const f = fixture();
  try {
    const response = await worker.fetch(jsonReq('/api/schedules/scan', 'POST', {sources:['codex']}, bearer), f.env);
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /push-schedules/);
  } finally { f.close(); }
});

test('the hosted MCP endpoint speaks Streamable HTTP, offers the same 14 tools, and needs the bearer token', async () => {
  const f = fixture(); const resend = stubResend([]);
  const viaWorker = (url, init) => worker.fetch(new Request(url, init), f.env);
  try {
    const refused = new Client({name:'test', version:'1.0.0'});
    await assert.rejects(refused.connect(new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), {fetch:viaWorker})));
    const client = new Client({name:'project-inbox-hosted-test', version:'1.0.0'});
    await client.connect(new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), {fetch:viaWorker, requestInit:{headers:bearer}}));
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 14);
    const call = async (name, args = {}) => {
      const result = await client.callTool({name, arguments:args});
      assert.equal(result.isError, undefined, JSON.stringify(result));
      const text = result.content[0].text;
      assert.ok(!text.includes('re_test_only') && !text.includes('whsec_'));
      return JSON.parse(text);
    };
    assert.equal((await call('list_accounts')).accounts[0].mailbox, 'hello@studio.example');
    assert.equal((await call('sync_mail', {accountId:'studio'})).hasMore, false);
    await call('log_task', {task_date:'2026-11-13', title:'Hosted listing', project:'slayfit', kind:'listing', status:'planned', external_ref:'2026-11-13|example.com|listing'});
    await call('update_task', {external_ref:'2026-11-13|example.com|listing', status:'published', result_url:'https://example.com/slayfit'});
    const tasks = await call('list_tasks', {project:'slayfit'});
    assert.equal(tasks.tasks[0].status, 'published');
    await call('sync_schedules', {schedules:[{source:'claude', external_id:'daily-slayfit-backlinks', name:'Daily SlayFit backlinks', cadence_type:'cron', cadence:'CRON_TZ=Asia/Calcutta 43 11 * * *'}]});
    assert.equal((await call('list_schedules')).schedules[0].external_id, 'daily-slayfit-backlinks');
    const missing = await client.callTool({name:'read_message', arguments:{messageId:'studio:in:none'}});
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /404/);
    await client.close();
  } finally { resend.restore(); f.close(); }
});

test('MCP tools call the app with a plain in-process Request (workerd rejects the abort timer and redirect policy)', async () => {
  const {handleMcp} = await import('../src/mcp-http.js');
  const seen = [];
  const call = {jsonrpc:'2.0', id:1, method:'tools/call', params:{name:'list_schedules', arguments:{}}};
  const response = await handleMcp(req('/mcp', {method:'POST', headers:{'Content-Type':'application/json', Accept:'application/json, text/event-stream'}, body:JSON.stringify(call)}),
    async request => { seen.push(request); return Response.json({schedules:[]}); });
  assert.equal(response.status, 200);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].redirect, 'follow');
  assert.equal(seen[0].headers.get('Origin'), null);
  assert.deepEqual(JSON.parse((await response.json()).result.content[0].text), {schedules:[]});
});
