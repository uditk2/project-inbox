import { send } from './send.js';
import { syncAccount } from './sync.js';
import { localRequest, HttpError, normalizeReceived, normalizeSent, publicAccount, resend, loadAccounts, encryptCredentials, validEmail } from './core.js';

const json = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
const messageColumns = 'id,account_id,direction,sender,recipients,subject,substr(body_text,1,180) AS preview,received_at,is_read,archived,status';

async function api(request, env, user) {
  const url = new URL(request.url);
  const configured = await loadAccounts(env);
  if (url.pathname === '/api/session' && request.method === 'GET') return json({ email: user.email, demo: user.demo, accounts: configured.map(publicAccount), settingsAvailable:true });
  if (!env.DB) throw new HttpError(503, 'Database is not configured');
  if (url.pathname === '/api/accounts' && request.method === 'POST') {
    if (user.demo) throw new HttpError(403,'Demo mode cannot save real credentials');
    const input = await request.json();
    if (!/^[a-z0-9-]{1,48}$/.test(input.id || '') || typeof input.name!=='string' || !input.name.trim() || input.name.length>100 || /[\r\n<>]/.test(input.name) || !validEmail(input.mailbox)) throw new HttpError(400,'Enter an account ID, name, and valid mailbox address');
    const previous = configured.find(a=>a.id===input.id);
    const apiKey = input.apiKey || previous?.apiKey;
    if (typeof apiKey!=='string' || !apiKey.startsWith('re_') || apiKey.length>512) throw new HttpError(400,'Enter a Resend API key');
    const encrypted = await encryptCredentials(env,input.id,{apiKey});
    await env.DB.prepare('INSERT INTO mail_accounts VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,mailbox=excluded.mailbox,encrypted_credentials=excluded.encrypted_credentials,updated_at=excluded.updated_at').bind(input.id,input.name.trim(),input.mailbox.toLowerCase(),encrypted,new Date().toISOString()).run();
    return json({account:publicAccount(input)});
  }
  if (url.pathname === '/api/sync' && request.method === 'POST') {
    if (user.demo) return json({ synced: 0, hasMore:false });
    const input = await request.json();
    const account = configured.find(a=>a.id===input.accountId);
    if (!account) throw new HttpError(400,'Choose a configured account');
    return json(await syncAccount(env.DB,account));
  }
  if (url.pathname === '/api/messages' && request.method === 'GET') {
    const folder = url.searchParams.get('folder') || 'inbox';
    const conditions = [folder === 'sent' ? "direction='outbound'" : "direction='inbound'", folder === 'archive' ? 'archived=1' : 'archived=0'];
    const bindings = [];
    if (url.searchParams.get('account')) { conditions.push('account_id=?'); bindings.push(url.searchParams.get('account')); }
    if (url.searchParams.get('q')) { conditions.push('(subject LIKE ? OR sender LIKE ? OR body_text LIKE ?)'); const term = `%${url.searchParams.get('q').slice(0,200)}%`; bindings.push(term,term,term); }
    const offset = Math.max(0,Math.min(100000,Number(url.searchParams.get('offset')) || 0));
    const result = await env.DB.prepare(`SELECT ${messageColumns} FROM messages WHERE ${conditions.join(' AND ')} ORDER BY received_at DESC,id DESC LIMIT 51 OFFSET ?`).bind(...bindings,offset).all();
    const stats = await env.DB.prepare("SELECT account_id,COUNT(*) AS unread FROM messages WHERE direction='inbound' AND is_read=0 AND archived=0 GROUP BY account_id").all();
    return json({ messages: result.results.slice(0,50), hasMore: result.results.length > 50, unread: stats.results });
  }
  const match = url.pathname.match(/^\/api\/messages\/([^/]+)$/);
  if (match) {
    const id = decodeURIComponent(match[1]);
    if (request.method === 'GET') {
      let message = await env.DB.prepare('SELECT * FROM messages WHERE id=?').bind(id).first();
      if (!message) throw new HttpError(404, 'Message not found');
      if (!message.body_loaded) {
        const account = configured.find(a=>a.id===message.account_id);
        if (!account) throw new HttpError(404,'Account not configured');
        const full = (message.direction==='inbound'?normalizeReceived:normalizeSent)(account,await resend(account,`/emails/${message.direction==='inbound'?'receiving/':''}${encodeURIComponent(message.provider_id)}`));
        await env.DB.prepare('UPDATE messages SET body_text=?,body_html=?,headers=?,attachments=?,message_id=?,in_reply_to=?,body_loaded=1 WHERE id=?').bind(full.body_text,full.body_html,full.headers,full.attachments,full.message_id,full.in_reply_to,id).run();
        message = {...message,...full,is_read:message.is_read,archived:message.archived,body_loaded:1};
      }
      return json(message);
    }
    if (request.method === 'PATCH') {
      const body = await request.json();
      const updates = []; const values = [];
      for (const [key, column] of [['read','is_read'],['archived','archived']]) if (typeof body[key] === 'boolean') { updates.push(`${column}=?`); values.push(Number(body[key])); }
      if (!updates.length) throw new HttpError(400, 'No changes supplied');
      await env.DB.prepare(`UPDATE messages SET ${updates.join(',')} WHERE id=?`).bind(...values,id).run();
      return json({ updated: true });
    }
  }
  if (url.pathname === '/api/send' && request.method === 'POST') {
    if (user.demo) throw new HttpError(403, 'Demo mode cannot send real email');
    return send(request,env,configured);
  }
  const attachment = url.pathname.match(/^\/api\/attachments\/([^/]+)\/([^/]+)$/);
  if (attachment && request.method === 'GET') {
    const message = await env.DB.prepare("SELECT * FROM messages WHERE id=? AND direction='inbound'").bind(decodeURIComponent(attachment[1])).first();
    if (!message) throw new HttpError(404,'Attachment not found');
    const account = configured.find(a => a.id === message.account_id);
    if (!account) throw new HttpError(404,'Account not configured');
    const meta = await resend(account,`/emails/receiving/${encodeURIComponent(message.provider_id)}/attachments/${encodeURIComponent(decodeURIComponent(attachment[2]))}`);
    if (!meta.download_url || new URL(meta.download_url).protocol !== 'https:') throw new HttpError(502,'Attachment unavailable');
    const file = await fetch(meta.download_url,{signal:AbortSignal.timeout(15000)});
    if (!file.ok) throw new HttpError(502,'Attachment unavailable');
    return new Response(file.body,{headers:{'Content-Type':'application/octet-stream','Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(meta.filename || 'attachment')}`,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
  }
  throw new HttpError(404, 'Not found');
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (url.pathname === '/health') return json({ status: 'ok', app: 'project-inbox' });
      const user = localRequest(request,env);
      if (url.pathname.startsWith('/api/')) {
        if (!['GET','HEAD'].includes(request.method)) {
          if (request.headers.get('Origin') !== url.origin || !request.headers.get('Content-Type')?.startsWith('application/json')) throw new HttpError(403,'Same-origin JSON request required');
          if (Number(request.headers.get('Content-Length') || 0) > 1000000) throw new HttpError(413,'Request too large');
        }
        return await api(request,env,user);
      }
      const response = await env.ASSETS.fetch(request);
      const headers = new Headers(response.headers);
      headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'self' about:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
      headers.set('X-Content-Type-Options','nosniff');
      headers.set('Referrer-Policy','no-referrer');
      return new Response(response.body,{status:response.status,headers});
    } catch (e) {
      if (e instanceof SyntaxError) return json({error:'Invalid JSON configuration or request'},400);
      return json({error:e instanceof HttpError ? e.message : 'Request could not be completed. Check server configuration.'},e instanceof HttpError ? e.status : 500);
    }
  }
};
