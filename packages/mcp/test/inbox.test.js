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

test('a hosted https inbox needs a token, which is sent as a bearer header', async () => {
  assert.throws(() => new InboxClient('http://example.com', fetch, () => null, 't'), /loopback|https/);
  assert.throws(() => new InboxClient('https://inbox.example.com/path', fetch, () => null, 't'), /https origin/);
  await assert.rejects(new InboxClient('https://inbox.example.com', async () => { throw new Error('must not call'); }, () => null).accounts(), /PROJECT_INBOX_TOKEN/);
  const client = new InboxClient('https://inbox.example.com', async (url, options) => {
    assert.equal(url, 'https://inbox.example.com/api/session');
    assert.equal(options.headers.Authorization, 'Bearer pi_secret');
    return Response.json({accounts:[],demo:false});
  }, () => null, 'pi_secret');
  assert.deepEqual(await client.accounts(), {accounts:[],demo:false});
  const rejected = new InboxClient('https://inbox.example.com', async () => new Response('{}', {status:401}), () => null, 'pi_old');
  await assert.rejects(rejected.accounts(), /rejected this token/);
});

test('local clients never send a token', async () => {
  const client = new InboxClient('http://127.0.0.1:8799', async (_, options) => {
    assert.equal(options.headers.Authorization, undefined);
    return Response.json({accounts:[],demo:false});
  }, () => null, 'pi_unused');
  await client.accounts();
});
