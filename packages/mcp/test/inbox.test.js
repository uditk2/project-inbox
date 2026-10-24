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
