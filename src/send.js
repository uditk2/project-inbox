import { HttpError, insertMessage, resend, validateSend, hash } from './core.js';
import {safeMessageHtml} from './format.js';
const json=(data,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store'}});

export async function send(request, env, configured) {
  const data = await request.json();
  const { account, payload } = validateSend(data, configured);
  if(data.html !== undefined) {
    if(typeof data.html!=='string' || data.html.length>100000) throw new HttpError(400,'Formatted message is too large');
    payload.html=safeMessageHtml(data.html);
  }
  if (data.replyToId) {
    const original = await env.DB.prepare('SELECT * FROM messages WHERE id=? AND account_id=?').bind(data.replyToId, account.id).first();
    if (!original) throw new HttpError(400, 'Reply must use the original project account');
    if (original.message_id) payload.headers = { 'In-Reply-To': original.message_id, 'References': original.message_id };
  }
  const serialized = JSON.stringify(payload);
  const digest = await hash(serialized);
  const saved = await env.DB.prepare('SELECT * FROM outbox WHERE request_id=?').bind(data.requestId).first();
  if (saved && (saved.account_id !== account.id || saved.payload_hash !== digest)) throw new HttpError(409, 'This send request was already used. Start a new message.');
  if (saved?.sent_id) return json({ id: saved.sent_id });
  // Resend idempotency keys expire after 24h. Never resend an old ambiguous attempt.
  if (saved && Date.now() - Date.parse(saved.created_at) > 23 * 3600000) throw new HttpError(409, 'Old send attempt needs manual review in Resend before resending.');
  await env.DB.prepare('INSERT OR IGNORE INTO outbox (request_id,account_id,payload_hash,payload,created_at) VALUES (?,?,?,?,?)').bind(data.requestId, account.id, digest, serialized, new Date().toISOString()).run();
  const result = await resend(account, '/emails', { method: 'POST', headers: { 'Idempotency-Key': `project-inbox/${data.requestId}` }, body: serialized });
  const id = `${account.id}:out:${result.id}`;
  await env.DB.batch([
    insertMessage(env.DB, { id, account_id: account.id, provider_id: result.id, direction: 'outbound', sender: payload.from, recipients: JSON.stringify(payload.to), subject: payload.subject, body_text: payload.text, body_html: payload.html || '', headers: JSON.stringify(payload.headers || {}), attachments: '[]', message_id: null, in_reply_to: payload.headers?.['In-Reply-To'] || null, received_at: saved?.created_at || new Date().toISOString(), is_read: 1, archived: 0, status: 'sent' }),
    env.DB.prepare('UPDATE outbox SET sent_id=?,provider_id=? WHERE request_id=?').bind(id, result.id, data.requestId)
  ]);
  return json({ id });
}
