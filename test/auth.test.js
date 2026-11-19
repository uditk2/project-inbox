import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/app.js';
import { openDatabase } from '../src/sqlite.js';
import { seal } from '../src/auth.js';

const BASE = 'https://inbox.example.workers.dev';
const secrets = { SESSION_SECRET: 's'.repeat(40), GOOGLE_CLIENT_ID: 'client-id', GOOGLE_CLIENT_SECRET: 'client-secret', ALLOWED_EMAILS: 'Me@Example.com', AUTH_MODE: 'google', CREDENTIALS_KEY: 'k'.repeat(40) };
const env = () => ({ ...secrets, DB: openDatabase(':memory:', new URL('../migrations/', import.meta.url)), ASSETS: { fetch: async () => new Response('<h1>app</h1>', { headers: { 'Content-Type': 'text/html' } }) } });
const get = (path, headers = {}) => new Request(`${BASE}${path}`, { headers });
const sessionCookie = async (e, email = 'me@example.com') => `__Host-pi_session=${await seal(e, 'session', { email }, 600)}`;
const send = (path, method, body, headers = {}) => new Request(`${BASE}${path}`, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
const idToken = claims => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;

test('signed-out visitors get the sign-in page and 401 JSON, never the app', async () => {
  const e = env();
  const page = await worker.fetch(get('/'), e);
  assert.equal(page.status, 401);
  assert.match(await page.text(), /Sign in with Google/);
  assert.equal((await worker.fetch(get('/api/session'), e)).status, 401);
  assert.equal((await worker.fetch(get('/health'), e)).status, 200);
});

test('login redirects to Google with PKCE and a state cookie', async () => {
  const response = await worker.fetch(get('/auth/login'), env());
  assert.equal(response.status, 302);
  const target = new URL(response.headers.get('Location'));
  assert.equal(target.origin + target.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(target.searchParams.get('redirect_uri'), `${BASE}/auth/callback`);
  assert.equal(target.searchParams.get('code_challenge_method'), 'S256');
  assert.match(response.headers.get('Set-Cookie'), /^__Host-pi_flow=.*HttpOnly.*SameSite=Lax.*Secure/);
});

async function finishLogin(e, claimsOverride = {}, tamperState = false) {
  const login = await worker.fetch(get('/auth/login'), e);
  const target = new URL(login.headers.get('Location'));
  const flowCookie = login.headers.get('Set-Cookie').split(';')[0];
  const claims = { iss: 'https://accounts.google.com', aud: 'client-id', exp: Math.floor(Date.now() / 1000) + 600, nonce: target.searchParams.get('nonce'), email: 'me@example.com', email_verified: true, ...claimsOverride };
  const calls = [];
  const fetcher = async (url, options) => { calls.push({ url, body: options.body }); return Response.json({ id_token: idToken(claims) }); };
  const { authRoutes } = await import('../src/auth.js');
  const response = await authRoutes(get(`/auth/callback?code=abc&state=${tamperState ? 'wrong' : target.searchParams.get('state')}`, { Cookie: flowCookie }), e, fetcher);
  return { response, calls };
}

test('callback sets a session for an allowed Google account and uses the PKCE verifier', async () => {
  const e = env();
  const { response, calls } = await finishLogin(e);
  assert.equal(response.status, 302);
  assert.equal(calls[0].url, 'https://oauth2.googleapis.com/token');
  assert.ok(calls[0].body.get('code_verifier'));
  assert.equal(calls[0].body.get('client_secret'), 'client-secret');
  const cookie = response.headers.getSetCookie().find(c => c.startsWith('__Host-pi_session=')).split(';')[0];
  const session = await worker.fetch(get('/api/session', { Cookie: cookie }), e);
  assert.equal(session.status, 200);
  const body = await session.json();
  assert.equal(body.email, 'me@example.com');
  assert.equal(body.hosted, true);
});

test('callback rejects other accounts, unverified emails, wrong audience, bad state and bad nonce', async () => {
  for (const [claims, state] of [[{ email: 'other@example.com' }], [{ email_verified: false }], [{ aud: 'someone-else' }], [{ nonce: 'x' }], [{}, true], [{ exp: 1 }]]) {
    const { response } = await finishLogin(env(), claims, state);
    assert.ok([400, 403].includes(response.status), JSON.stringify(claims));
    assert.equal(response.headers.getSetCookie().some(c => c.startsWith('__Host-pi_session=') && !c.includes('Max-Age=0')), false);
  }
});

test('sessions are tamper-proof, expire, and end when the address leaves the allow list', async () => {
  const e = env();
  const good = await sessionCookie(e);
  assert.equal((await worker.fetch(get('/api/session', { Cookie: good }), e)).status, 200);
  assert.equal((await worker.fetch(get('/api/session', { Cookie: good.slice(0, -2) + 'xx' }), e)).status, 401);
  assert.equal((await worker.fetch(get('/api/session', { Cookie: await sessionCookie(e, 'intruder@example.com') }), e)).status, 401);
  const expired = `__Host-pi_session=${await seal(e, 'session', { email: 'me@example.com' }, -10)}`;
  assert.equal((await worker.fetch(get('/api/session', { Cookie: expired }), e)).status, 401);
  const wrongPurpose = `__Host-pi_session=${await seal(e, 'flow', { email: 'me@example.com' }, 600)}`;
  assert.equal((await worker.fetch(get('/api/session', { Cookie: wrongPurpose }), e)).status, 401);
  assert.equal((await worker.fetch(get('/api/session', { Cookie: good }), { ...e, ALLOWED_EMAILS: 'someone@else.com' })).status, 401);
});

test('cookie writes need a same-origin request', async () => {
  const e = env(); const cookie = await sessionCookie(e);
  const cross = send('/api/feedback', 'POST', { message: 'hi' }, { Cookie: cookie, Origin: 'https://evil.example' });
  assert.equal((await worker.fetch(cross, e)).status, 403);
  const same = send('/api/feedback', 'POST', { message: 'hi' }, { Cookie: cookie, Origin: BASE });
  assert.equal((await worker.fetch(same, e)).status, 200);
});

test('agent tokens: created by a signed-in person, shown once, stored hashed, usable and revocable', async () => {
  const e = env(); const cookie = await sessionCookie(e);
  const made = await worker.fetch(send('/api/tokens', 'POST', { name: 'Claude on my Mac' }, { Cookie: cookie, Origin: BASE }), e);
  assert.equal(made.status, 201);
  const { id, token } = await made.json();
  assert.match(token, /^pi_/);
  const row = await e.DB.prepare('SELECT * FROM api_tokens WHERE id=?').bind(id).first();
  assert.ok(!JSON.stringify(row).includes(token));
  const asAgent = await worker.fetch(get('/api/session', { Authorization: `Bearer ${token}` }), e);
  assert.equal(asAgent.status, 200);
  assert.match((await asAgent.json()).email, /^Agent: Claude on my Mac$/);
  // A token can write without an Origin header, but cannot manage tokens.
  assert.equal((await worker.fetch(send('/api/feedback', 'POST', { message: 'from agent' }, { Authorization: `Bearer ${token}` }), e)).status, 200);
  assert.equal((await worker.fetch(send('/api/tokens', 'POST', { name: 'x' }, { Authorization: `Bearer ${token}` }), e)).status, 403);
  // A bad bearer never falls back to a valid cookie.
  assert.equal((await worker.fetch(get('/api/session', { Authorization: 'Bearer pi_wrong_wrong_wrong_wrong', Cookie: cookie }), e)).status, 401);
  const revoke = await worker.fetch(new Request(`${BASE}/api/tokens/${id}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: BASE }, body: '{}' }), e);
  assert.equal(revoke.status, 200);
  assert.equal((await worker.fetch(get('/api/session', { Authorization: `Bearer ${token}` }), e)).status, 401);
});

test('an unconfigured Worker fails closed', async () => {
  const e = { ...env(), ALLOWED_EMAILS: '' };
  const cookie = await sessionCookie(e);
  assert.equal((await worker.fetch(get('/api/session', { Cookie: cookie }), e)).status, 401);
  const noSecret = await worker.fetch(get('/auth/login'), { ...env(), SESSION_SECRET: '' });
  assert.equal(noSecret.status, 503);
  assert.equal((await worker.fetch(get('/'), { AUTH_MODE: 'other' })).status, 403);
});
