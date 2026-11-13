// Everything that only exists when Project Inbox runs as a hosted Cloudflare Worker: access control, the Resend
// webhook, and the scheduled mail sync. The local app never loads this file.
import {HttpError, json, loadAccounts} from './core.js';
import {syncAccount} from './sync.js';

const encoder = new TextEncoder();
const SESSION_COOKIE = 'pi_session';
const SESSION_SECONDS = 7 * 24 * 3600;
const WEBHOOK_TOLERANCE_SECONDS = 300;

const toHex = bytes => Array.from(new Uint8Array(bytes), x => x.toString(16).padStart(2, '0')).join('');
const toBase64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const fromBase64 = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));
const sha256 = async text => new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
async function hmac(keyBytes, text) {
  const key = await crypto.subtle.importKey('raw', keyBytes, {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
  return crypto.subtle.sign('HMAC', key, encoder.encode(text));
}

// Compares two strings without leaking where they differ: both are hashed to a fixed length first.
export async function safeEqual(a, b) {
  const [x, y] = await Promise.all([sha256(String(a)), sha256(String(b))]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function accessToken(env) {
  if (typeof env.INBOX_TOKEN !== 'string' || env.INBOX_TOKEN.length < 32) throw new HttpError(503, 'The hosted app has no access token yet. Set INBOX_TOKEN to at least 32 random characters.');
  return env.INBOX_TOKEN;
}

const cookieValue = (request, name) => {
  for (const part of (request.headers.get('Cookie') || '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
};

async function sessionSignature(env, expires) {
  const key = await sha256(`project-inbox session key\n${accessToken(env)}`);
  return toHex(await hmac(key, `session.${expires}`));
}
async function newSession(env, now = Date.now()) {
  const expires = Math.floor(now / 1000) + SESSION_SECONDS;
  return `${expires}.${await sessionSignature(env, expires)}`;
}

// Returns {email, demo, via} for a valid bearer token or browser session, or null.
export async function authenticate(request, env, now = Date.now()) {
  const token = accessToken(env);
  const bearer = request.headers.get('Authorization')?.match(/^Bearer (\S+)$/i)?.[1];
  if (bearer) return await safeEqual(bearer, token) ? {email: 'Hosted workspace', demo: false, via: 'bearer'} : null;
  const session = cookieValue(request, SESSION_COOKIE);
  const [expires, signature] = String(session || '').split('.');
  if (!/^\d{9,12}$/.test(expires || '') || !signature || Number(expires) * 1000 < now) return null;
  return await safeEqual(signature, await sessionSignature(env, expires)) ? {email: 'Hosted workspace', demo: false, via: 'cookie'} : null;
}

const page = (body, status = 200, headers = {}) => new Response(
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Project Inbox</title><style>body{font:16px system-ui,sans-serif;max-width:22rem;margin:20vh auto;padding:0 1rem}input,button{font:inherit;padding:.5rem;width:100%;box-sizing:border-box;margin:.4rem 0}</style>${body}`,
  {status, headers: {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'", 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...headers}});

const loginForm = (note = '') => page(`<h1>Project Inbox</h1>${note ? `<p>${note}</p>` : ''}<form method="post" action="/login"><label>Access token<input name="token" type="password" autocomplete="current-password" required autofocus></label><button>Sign in</button></form>`, note ? 401 : 200);

export async function login(request, env) {
  const url = new URL(request.url);
  accessToken(env);
  if (request.method === 'GET') return loginForm();
  if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed');
  if (request.headers.get('Origin') && request.headers.get('Origin') !== url.origin) throw new HttpError(403, 'Same-origin request required');
  const token = String((await request.formData()).get('token') || '');
  if (!await safeEqual(token, env.INBOX_TOKEN)) return loginForm('That token is not right.');
  const secure = url.protocol === 'https:' ? '; Secure' : '';
  return new Response(null, {status: 303, headers: {Location: '/', 'Cache-Control': 'no-store', 'Set-Cookie': `${SESSION_COOKIE}=${await newSession(env)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_SECONDS}${secure}`}});
}

export function logout(request) {
  if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed');
  return new Response(null, {status: 303, headers: {Location: '/login', 'Cache-Control': 'no-store', 'Set-Cookie': `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`}});
}

// Resend signs webhooks with Svix: HMAC-SHA256 over "<id>.<timestamp>.<body>", keyed by the base64 part of whsec_...
export async function verifyWebhook({secret, id, timestamp, signature, body, now = Date.now()}) {
  if (!id || !signature || !/^\d{9,12}$/.test(timestamp || '')) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > WEBHOOK_TOLERANCE_SECONDS) return false;
  let key;
  try { key = fromBase64(String(secret).replace(/^whsec_/, '')); } catch { return false; }
  const expected = toBase64(await hmac(key, `${id}.${timestamp}.${body}`));
  let ok = false;
  for (const part of signature.split(' ')) {
    const [version, value] = part.split(',');
    if (version === 'v1' && value && await safeEqual(value, expected)) ok = true;   // check every candidate, no early exit
  }
  return ok;
}

// Pulls new mail for one account. A webhook or cron tick only says "something changed"; the mail itself always
// comes from Resend's API, exactly as when a person presses Refresh, so a forged or malformed event can add nothing.
export async function syncUntilDone(db, account, maxPages = 3, sync = syncAccount) {
  let synced = 0, hasMore = false;
  for (let page = 0; page < maxPages; page++) {
    const result = await sync(db, account);
    synced += result.synced;
    hasMore = result.hasMore;
    if (!hasMore) break;
  }
  return {synced, hasMore};
}

export async function webhook(request, env, accountId, now = Date.now(), sync = syncAccount) {
  if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed');
  if (!env.DB) throw new HttpError(503, 'Database is not configured');
  const account = (await loadAccounts(env)).find(a => a.id === accountId);
  if (!account) throw new HttpError(404, 'Not found');
  let secrets = {};
  try { secrets = JSON.parse(env.WEBHOOK_SECRETS_JSON || '{}'); } catch { throw new HttpError(503, 'WEBHOOK_SECRETS_JSON is not valid JSON'); }
  const secret = account.webhookSecret || secrets[accountId];
  if (!secret) throw new HttpError(503, 'No webhook signing secret is configured for this account');
  if (Number(request.headers.get('Content-Length') || 0) > 1000000) throw new HttpError(413, 'Request too large');
  const body = await request.text();
  if (body.length > 1000000) throw new HttpError(413, 'Request too large');
  const id = request.headers.get('svix-id');
  const verified = await verifyWebhook({secret, id, timestamp: request.headers.get('svix-timestamp'), signature: request.headers.get('svix-signature'), body, now});
  if (!verified) throw new HttpError(401, 'Invalid webhook signature');
  const event = JSON.parse(body);
  if (await env.DB.prepare('SELECT 1 AS seen FROM webhook_events WHERE account_id=? AND event_id=?').bind(account.id, id).first()) return json({ok: true, duplicate: true});
  const relevant = typeof event?.type === 'string' && event.type.startsWith('email.');
  const result = relevant ? await syncUntilDone(env.DB, account, 2, sync) : {synced: 0, hasMore: false};
  // Recorded only after the sync worked, so a failed attempt is retried by Resend instead of being treated as done.
  await env.DB.prepare('INSERT OR IGNORE INTO webhook_events (account_id,event_id,processed_at) VALUES (?,?,?)').bind(account.id, id, new Date(now).toISOString()).run();
  return json({ok: true, ...result});
}

// Cron fallback: covers missed webhooks and finishes a history import that one request could not.
export async function syncAll(env, maxPages = 3, sync = syncAccount) {
  const report = [];
  for (const account of await loadAccounts(env)) {
    try { report.push({account: account.id, ...await syncUntilDone(env.DB, account, maxPages, sync)}); }
    catch (error) { report.push({account: account.id, error: error instanceof HttpError ? error.message : 'Sync failed'}); }
  }
  // Event ids only matter while Resend could still retry them.
  await env.DB.prepare('DELETE FROM webhook_events WHERE processed_at < ?').bind(new Date(Date.now() - 30 * 86400000).toISOString()).run();
  return report;
}
