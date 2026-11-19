// Sign-in for the hosted (Cloudflare Worker) deployment.
// People sign in with Google and get a signed session cookie. Agents (the MCP server) use API tokens
// that a signed-in person creates. The local npx app never loads any of this: it has no sign-in by design.
import { HttpError, json, hash } from './core.js';

const encoder = new TextEncoder();
const SESSION_SECONDS = 7 * 24 * 3600;
const FLOW_SECONDS = 600;
const MAX_TOKENS = 20;
const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';

const b64 = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = text => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

export const hosted = env => env.LOCAL_APP !== 'true' && env.AUTH_MODE === 'google';
export const allowedEmails = env => String(env.ALLOWED_EMAILS || '').split(',').map(v => v.trim().toLowerCase()).filter(Boolean);

async function signingKey(env) {
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) throw new HttpError(503, 'Sign-in is not configured: set SESSION_SECRET (32 or more characters).');
  return crypto.subtle.importKey('raw', encoder.encode(env.SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
// Signed, expiring, purpose-bound values for cookies. A value made for one purpose is rejected for another.
export async function seal(env, purpose, data, seconds) {
  const body = b64(encoder.encode(JSON.stringify({ ...data, p: purpose, exp: Math.floor(Date.now() / 1000) + seconds })));
  const signature = b64(new Uint8Array(await crypto.subtle.sign('HMAC', await signingKey(env), encoder.encode(body))));
  return `${body}.${signature}`;
}
export async function unseal(env, purpose, value) {
  const parts = String(value || '').split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  let valid = false;
  try { valid = await crypto.subtle.verify('HMAC', await signingKey(env), unb64(parts[1]), encoder.encode(parts[0])); }
  catch (error) { if (error instanceof HttpError) throw error; return null; }
  if (!valid) return null;
  let data;
  try { data = JSON.parse(new TextDecoder().decode(unb64(parts[0]))); } catch { return null; }
  return data?.p === purpose && data.exp > Date.now() / 1000 ? data : null;
}

const cookieNames = secure => ({ session: secure ? '__Host-pi_session' : 'pi_session', flow: secure ? '__Host-pi_flow' : 'pi_flow' });
const isSecure = request => new URL(request.url).protocol === 'https:';
function readCookies(request) {
  const out = {};
  for (const part of (request.headers.get('Cookie') || '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0) out[part.slice(0, at).trim()] = part.slice(at + 1).trim();
  }
  return out;
}
// Lax, not Strict: the redirect back from Google is a cross-site navigation and must still carry the flow cookie.
const cookie = (name, value, secure, maxAge) => `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;

const escapeHtml = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export function signInPage(message = '', status = 401) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Project Inbox · Sign in</title><link rel="icon" href="/favicon.svg"><style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.5 -apple-system,BlinkMacSystemFont,Arial,sans-serif;background:#f6f7fb;color:#24324a}main{background:#fff;border:1px solid #e3e7f0;border-radius:16px;padding:40px;max-width:360px;text-align:center;box-shadow:0 8px 30px rgba(36,50,74,.08)}h1{font-size:22px;margin:0 0 6px}p{margin:0 0 24px;color:#5b6a85}a.button{display:inline-block;background:#24324a;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:600}.error{color:#b42318;background:#fef3f2;border-radius:8px;padding:10px 12px;margin:0 0 20px;font-size:14px}</style></head><body><main><h1>Project Inbox</h1><p>One place for every project's email.</p>${message ? `<div class="error" role="alert">${escapeHtml(message)}</div>` : ''}<a class="button" href="/auth/login">Sign in with Google</a></main></body></html>`;
  return new Response(html, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

// ID token claims. The token comes straight from Google's token endpoint over TLS, in exchange for our client secret
// and PKCE verifier, so the signature check that OpenID Connect requires for other channels is not needed here.
function claimsOf(idToken) {
  try { return JSON.parse(new TextDecoder().decode(unb64(String(idToken).split('.')[1]))); } catch { return null; }
}

async function login(request, env) {
  if (!env.GOOGLE_CLIENT_ID) throw new HttpError(503, 'Sign-in is not configured: set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.');
  const url = new URL(request.url);
  const state = b64(crypto.getRandomValues(new Uint8Array(24)));
  const nonce = b64(crypto.getRandomValues(new Uint8Array(24)));
  const verifier = b64(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(verifier))));
  const target = new URL(GOOGLE_AUTH);
  target.search = new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, redirect_uri: `${url.origin}/auth/callback`, response_type: 'code', scope: 'openid email', state, nonce, code_challenge: challenge, code_challenge_method: 'S256', prompt: 'select_account' });
  const secure = isSecure(request);
  return new Response(null, { status: 302, headers: { Location: target.href, 'Cache-Control': 'no-store', 'Set-Cookie': cookie(cookieNames(secure).flow, await seal(env, 'flow', { state, nonce, verifier }, FLOW_SECONDS), secure, FLOW_SECONDS) } });
}

async function callback(request, env, fetcher) {
  const url = new URL(request.url);
  const secure = isSecure(request);
  const names = cookieNames(secure);
  const flow = await unseal(env, 'flow', readCookies(request)[names.flow]);
  const code = url.searchParams.get('code');
  if (url.searchParams.get('error')) throw new HttpError(403, 'Google sign-in was cancelled.');
  if (!flow || !code || url.searchParams.get('state') !== flow.state) throw new HttpError(400, 'That sign-in link expired. Please start again.');
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) throw new HttpError(503, 'Sign-in is not configured: set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.');
  let exchange;
  try {
    exchange = await fetcher(GOOGLE_TOKEN, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(10000), body: new URLSearchParams({ code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: `${url.origin}/auth/callback`, grant_type: 'authorization_code', code_verifier: flow.verifier }) });
  } catch { throw new HttpError(502, 'Could not reach Google. Please try again.'); }
  if (!exchange.ok) throw new HttpError(502, 'Google sign-in failed. Please try again.');
  const claims = claimsOf((await exchange.json().catch(() => ({}))).id_token);
  const email = typeof claims?.email === 'string' ? claims.email.toLowerCase() : '';
  const issuerOk = claims && ['https://accounts.google.com', 'accounts.google.com'].includes(claims.iss);
  if (!issuerOk || claims.aud !== env.GOOGLE_CLIENT_ID || !(claims.exp > Date.now() / 1000) || claims.nonce !== flow.nonce || claims.email_verified !== true || !email) throw new HttpError(403, 'Google sign-in could not be verified.');
  if (!allowedEmails(env).includes(email)) throw new HttpError(403, 'This Google account does not have access.');
  const headers = new Headers({ Location: '/', 'Cache-Control': 'no-store' });
  headers.append('Set-Cookie', cookie(names.session, await seal(env, 'session', { email }, SESSION_SECONDS), secure, SESSION_SECONDS));
  headers.append('Set-Cookie', cookie(names.flow, '', secure, 0));
  return new Response(null, { status: 302, headers });
}

function logout(request) {
  const url = new URL(request.url);
  if (request.method !== 'POST' || request.headers.get('Origin') !== url.origin) throw new HttpError(403, 'Sign out from the app.');
  const secure = isSecure(request);
  const headers = new Headers({ Location: '/', 'Cache-Control': 'no-store' });
  headers.append('Set-Cookie', cookie(cookieNames(secure).session, '', secure, 0));
  return new Response(null, { status: 303, headers });
}

// Routes under /auth/. Returns null for any other path. Browser-facing failures show the sign-in page, not raw JSON.
export async function authRoutes(request, env, fetcher = fetch) {
  const { pathname } = new URL(request.url);
  if (!pathname.startsWith('/auth/')) return null;
  try {
    if (pathname === '/auth/login' && request.method === 'GET') return await authenticate(request, env) ? new Response(null, { status: 302, headers: { Location: '/' } }) : await login(request, env);
    if (pathname === '/auth/callback' && request.method === 'GET') return await callback(request, env, fetcher);
    if (pathname === '/auth/logout') return logout(request);
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    return signInPage(error.message, error.status);
  }
  return signInPage('Not found.', 404);
}

// The signed-in user, or null. An Authorization header is judged on its own and never falls back to a cookie.
export async function authenticate(request, env) {
  const header = request.headers.get('Authorization');
  if (header !== null) {
    const token = header.match(/^Bearer (pi_[A-Za-z0-9_-]{20,128})$/)?.[1];
    if (!token || !env.DB) return null;
    const row = await env.DB.prepare('SELECT id,name,last_used_at FROM api_tokens WHERE token_hash=? AND revoked_at IS NULL').bind(await hash(token)).first();
    if (!row) return null;
    const now = Date.now();
    if (!row.last_used_at || Date.parse(row.last_used_at) < now - 3600000) await env.DB.prepare('UPDATE api_tokens SET last_used_at=? WHERE id=?').bind(new Date(now).toISOString(), row.id).run();
    return { email: `Agent: ${row.name}`, demo: false, via: 'token' };
  }
  const session = await unseal(env, 'session', readCookies(request)[cookieNames(isSecure(request)).session]);
  // The allow list is checked on every request, so removing an address ends its sessions immediately.
  if (!session || !allowedEmails(env).includes(session.email)) return null;
  return { email: session.email, demo: false, via: 'session' };
}

// /api/tokens: list, create and revoke agent tokens. Only a signed-in person may do this, never a token.
export async function tokens(request, env, user) {
  if (user.via !== 'session') throw new HttpError(403, 'Sign in with Google to manage agent tokens.');
  const { pathname } = new URL(request.url);
  if (pathname === '/api/tokens' && request.method === 'GET') {
    return json({ tokens: (await env.DB.prepare('SELECT id,name,created_at,last_used_at FROM api_tokens WHERE revoked_at IS NULL ORDER BY created_at DESC').all()).results });
  }
  if (pathname === '/api/tokens' && request.method === 'POST') {
    const body = await request.json();
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!/^[\w .@-]{1,60}$/.test(name)) throw new HttpError(400, 'Name the token with up to 60 letters, numbers, spaces or . _ - @');
    const active = await env.DB.prepare('SELECT COUNT(*) AS n FROM api_tokens WHERE revoked_at IS NULL').first();
    if (active.n >= MAX_TOKENS) throw new HttpError(409, 'Revoke an unused token first.');
    const token = `pi_${b64(crypto.getRandomValues(new Uint8Array(32)))}`;
    const id = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO api_tokens (id,name,token_hash,created_at) VALUES (?,?,?,?)').bind(id, name, await hash(token), new Date().toISOString()).run();
    return json({ id, name, token }, 201); // shown once; only its hash is kept
  }
  const match = pathname.match(/^\/api\/tokens\/([^/]+)$/);
  if (match && request.method === 'DELETE') {
    const result = await env.DB.prepare('UPDATE api_tokens SET revoked_at=? WHERE id=? AND revoked_at IS NULL').bind(new Date().toISOString(), decodeURIComponent(match[1])).run();
    if (!result.meta?.changes) throw new HttpError(404, 'Token not found');
    return json({ revoked: true });
  }
  throw new HttpError(404, 'Not found');
}
