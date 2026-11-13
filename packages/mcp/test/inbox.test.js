import test from 'node:test';
import assert from 'node:assert/strict';
import { InboxClient, localOrigin } from '../src/inbox.js';

test('rejects remote origins, credentials, paths, and redirects', async () => {
  for (const url of ['https://example.com','http://127.0.0.1.evil.com','http://user:pass@localhost','http://localhost/api','file:///tmp/inbox']) assert.throws(() => localOrigin(url));
  assert.equal(localOrigin('http://127.0.0.1:8798'), 'http://127.0.0.1:8798');
  const client = new InboxClient(undefined, async (_, options) => { assert.equal(options.redirect, 'error'); throw new Error('sensitive error'); });
  await assert.rejects(client.accounts(), /Cannot connect/);
});

test('account summaries exclude keys and sync supplies required same-origin headers', async () => {
  const client = new InboxClient('http://localhost:8798', async (url, options) => {
    if (url.endsWith('/api/session')) return Response.json({accounts:[{id:'a',name:'Project',mailbox:'hi@example.com',apiKey:'must-not-return'}],demo:true});
    assert.equal(options.headers.Origin, 'http://localhost:8798');
    assert.deepEqual(JSON.parse(options.body), {accountId:'a'});
    return Response.json({synced:1,hasMore:false});
  });
  assert.equal(JSON.stringify(await client.accounts()).includes('must-not-return'), false);
  assert.deepEqual(await client.sync('a'), {synced:1,hasMore:false});
});

test('read returns bounded plain text without raw headers, HTML, or provider fields', async () => {
  const client = new InboxClient(undefined, async url => {
    assert.ok(url.endsWith('/api/messages/a%2Fb'));
    return Response.json({id:'a/b',body_text:'x'.repeat(31000),body_html:'private-html',headers:{secret:'hidden'},provider_id:'provider'});
  });
  const result = await client.read('a/b');
  assert.equal(result.text.length,30000);
  assert.equal(result.truncated,true);
  assert.equal('headers' in result,false);
  assert.equal('body_html' in result,false);
});

test('client finds the app: explicit URL, then discovery, then port 8787', () => {
  const found = () => 'http://127.0.0.1:9001';
  assert.equal(new InboxClient('http://localhost:8798', fetch, found).origin, 'http://localhost:8798');
  assert.equal(new InboxClient(undefined, fetch, found).origin, 'http://127.0.0.1:9001');
  assert.equal(new InboxClient(undefined, fetch, () => null).origin, 'http://127.0.0.1:8787');
});

test('discovery ignores stale, foreign and malformed files', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { discoveredUrl } = await import('../src/inbox.js');
  const dir = mkdtempSync(join(tmpdir(), 'pi-discover-'));
  const write = value => writeFileSync(join(dir, 'server.json'), typeof value === 'string' ? value : JSON.stringify(value));
  assert.equal(discoveredUrl(dir), null);
  write({ url: 'http://127.0.0.1:9002', pid: process.pid });
  assert.equal(discoveredUrl(dir), 'http://127.0.0.1:9002');
  write({ url: 'http://127.0.0.1:9002', pid: 2 ** 22 + 12345 });
  assert.equal(discoveredUrl(dir), null);
  write({ url: 'https://evil.example.com', pid: process.pid });
  assert.equal(discoveredUrl(dir), null);
  write('not json');
  assert.equal(discoveredUrl(dir), null);
});

test('a hosted app needs https plus a token, sends the token, and reports its error text', async () => {
  const { remoteOrigin } = await import('../src/inbox.js');
  for (const url of ['http://inbox.example.com','https://user:pass@inbox.example.com','https://inbox.example.com/path','https://inbox.example.com/?x=1']) assert.throws(() => remoteOrigin(url));
  assert.equal(remoteOrigin('https://inbox.example.com'), 'https://inbox.example.com');
  assert.throws(() => new InboxClient(undefined, fetch, () => null, 'a-token'), /PROJECT_INBOX_URL/);
  assert.throws(() => new InboxClient('https://inbox.example.com', fetch, () => null), /loopback/);
  const seen = [];
  const client = new InboxClient('https://inbox.example.com', async (url, options) => {
    seen.push([url, options.headers.Authorization]);
    if (url.endsWith('/api/session')) return Response.json({accounts:[{id:'a',name:'A',mailbox:'a@example.com'}],demo:false});
    if (url.endsWith('/api/sync')) return Response.json({error:'Mail provider is busy. Please retry shortly.'}, {status:429});
    return Response.json({error:'nope'}, {status:401});
  }, () => null, 'secret-token');
  assert.equal((await client.accounts()).accounts[0].id, 'a');
  assert.deepEqual(seen[0], ['https://inbox.example.com/api/session', 'Bearer secret-token']);
  await assert.rejects(client.sync('a'), /429.*busy/);
  await assert.rejects(client.tasks(), /rejected PROJECT_INBOX_TOKEN/);
  const down = new InboxClient('https://inbox.example.com', async () => { throw new Error('boom secret-token'); }, () => null, 'secret-token');
  await assert.rejects(down.accounts(), err => /hosted Project Inbox/.test(err.message) && !err.message.includes('secret-token'));
});
