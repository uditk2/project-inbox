import {HttpError, json, validateSend} from './core.js';
import {safeMessageHtml} from './format.js';
import {send} from './send.js';

const view = row => ({id:row.id, ...JSON.parse(row.payload), createdAt:row.created_at, sentId:row.sent_id, status:row.sent_id?'sent':'draft'});

export async function drafts(request, env, configured, user) {
  const path = new URL(request.url).pathname;
  if (path === '/api/drafts' && request.method === 'GET') {
    return json({drafts:(await env.DB.prepare('SELECT * FROM drafts ORDER BY created_at DESC LIMIT 100').all()).results.map(view)});
  }
  if (path === '/api/drafts' && request.method === 'POST') {
    const input = await request.json();
    const id = crypto.randomUUID();
    const {payload} = validateSend({...input,requestId:id},configured);
    const saved = {accountId:input.accountId,to:payload.to,subject:payload.subject,text:payload.text,requestId:id};
    if (input.html !== undefined) {
      if (typeof input.html !== 'string' || input.html.length > 100000) throw new HttpError(400,'Formatted message is too large');
      saved.html = safeMessageHtml(input.html);
    }
    if (input.replyToId !== undefined) {
      if (typeof input.replyToId !== 'string' || !await env.DB.prepare('SELECT id FROM messages WHERE id=? AND account_id=?').bind(input.replyToId,input.accountId).first()) throw new HttpError(400,'Reply must use the original project account');
      saved.replyToId = input.replyToId;
    }
    const row = {id,payload:JSON.stringify(saved),created_at:new Date().toISOString(),sent_id:null};
    await env.DB.prepare('INSERT INTO drafts VALUES (?,?,?,NULL)').bind(id,row.payload,row.created_at).run();
    return json(view(row),201);
  }
  const match = path.match(/^\/api\/drafts\/([^/]+)(\/send)?$/);
  if (!match) return null;
  const row = await env.DB.prepare('SELECT * FROM drafts WHERE id=?').bind(decodeURIComponent(match[1])).first();
  if (!row) throw new HttpError(404,'Draft not found');
  if (!match[2] && request.method === 'GET') return json(view(row));
  if (match[2] && request.method === 'POST') {
    if (user.demo) throw new HttpError(403,'Demo mode cannot send real email');
    if (row.sent_id) return json({id:row.sent_id});
    const response = await send(new Request(request.url,{method:'POST',headers:{'Content-Type':'application/json'},body:row.payload}),env,configured);
    if (!response.ok) return response;
    const result = await response.clone().json();
    await env.DB.prepare('UPDATE drafts SET sent_id=? WHERE id=?').bind(result.id,row.id).run();
    return response;
  }
  throw new HttpError(405,'Method not allowed');
}
