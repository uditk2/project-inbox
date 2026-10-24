export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function accounts(env) {
  const parsed = JSON.parse(env.MAIL_ACCOUNTS_JSON || '[]');
  if (!Array.isArray(parsed)) throw new Error('Invalid mail configuration');
  const ids = new Set();
  for (const a of parsed) {
    if (!/^[a-z0-9-]{1,48}$/.test(a.id) || ids.has(a.id) || !validEmail(a.mailbox) || !a.apiKey) throw new Error('Invalid mail configuration');
    ids.add(a.id);
  }
  return parsed;
}
async function credentialsKey(env) {
  if (!env.CREDENTIALS_KEY || env.CREDENTIALS_KEY.length<32) throw new HttpError(503,'Encrypted account storage is not configured');
  const bytes = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(env.CREDENTIALS_KEY));
  return crypto.subtle.importKey('raw',bytes,'AES-GCM',false,['encrypt','decrypt']);
}
export async function encryptCredentials(env,id,credentials) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:new TextEncoder().encode(id)},await credentialsKey(env),new TextEncoder().encode(JSON.stringify(credentials))));
  return JSON.stringify({iv:btoa(String.fromCharCode(...iv)),data:btoa(String.fromCharCode(...encrypted))});
}
export async function loadAccounts(env) {
  const configured = accounts(env);
  if (!env.DB) return configured;
  const {results} = await env.DB.prepare('SELECT * FROM mail_accounts ORDER BY name').all();
  if (!results.length) return configured;
  const key = await credentialsKey(env);
  const merged = new Map(configured.map(a=>[a.id,a]));
  for (const row of results) {
    const sealed = JSON.parse(row.encrypted_credentials);
    const decoded = await crypto.subtle.decrypt({name:'AES-GCM',iv:Uint8Array.from(atob(sealed.iv),c=>c.charCodeAt(0)),additionalData:new TextEncoder().encode(row.id)},key,Uint8Array.from(atob(sealed.data),c=>c.charCodeAt(0)));
    merged.set(row.id,{id:row.id,name:row.name,mailbox:row.mailbox,...JSON.parse(new TextDecoder().decode(decoded))});
  }
  return [...merged.values()];
}
export function validEmail(value) {
  return typeof value === 'string' && value.length <= 254 && /^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(value);
}
export function address(value) {
  const text = String(value || '').trim();
  return (text.match(/<([^<>]+)>$/)?.[1] || text).toLowerCase();
}
export function localRequest(request, env) {
  const host = new URL(request.url).hostname;
  if (env.LOCAL_APP !== 'true' || !['localhost','127.0.0.1','[::1]'].includes(host)) throw new HttpError(403,'This app is available only on this computer.');
  return {email:'Local workspace',demo:env.LOCAL_DEMO==='true'};
}
const providerSlots = new Map();
export async function resend(account, path, init = {}, fetcher = fetch) {
  const now=Date.now();
  const slot=Math.max(now,providerSlots.get(account.apiKey) || 0);
  providerSlots.set(account.apiKey,slot+600);
  if(slot>now) await new Promise(resolve=>setTimeout(resolve,slot-now));
  const result = await fetcher(`https://api.resend.com${path}`, {
    ...init,
    headers: { 'Authorization': `Bearer ${account.apiKey}`, 'Content-Type': 'application/json', ...init.headers },
    signal: AbortSignal.timeout(12000)
  });
  if (!result.ok) throw new HttpError(result.status === 429 ? 429 : 502, result.status === 429 ? 'Mail provider is busy. Please retry shortly.' : [401,403].includes(result.status) ? 'Resend rejected this API key. Use a valid full-access key for this account.' : 'Mail provider could not complete the request. Check account settings and retry.');
  return result.json();
}
export function normalizeSent(account,mail) {
  if(address(mail.from)!==account.mailbox.toLowerCase()) throw new HttpError(422,'Message was not sent from this mailbox');
  const headers=mail.headers || {};
  return {id:`${account.id}:out:${mail.id}`,account_id:account.id,provider_id:mail.id,direction:'outbound',sender:String(mail.from || ''),recipients:JSON.stringify(Array.isArray(mail.to)?mail.to:[mail.to].filter(Boolean)),subject:String(mail.subject || '(No subject)'),body_text:String(mail.text || ''),body_html:String(mail.html || ''),headers:JSON.stringify(headers),attachments:JSON.stringify(mail.attachments || []),message_id:mail.message_id || headers['message-id'] || null,in_reply_to:headers['in-reply-to'] || null,received_at:mail.created_at || new Date().toISOString(),is_read:1,archived:0,status:mail.last_event || 'sent'};
}
export function normalizeReceived(account, mail) {
  const to = Array.isArray(mail.to) ? mail.to : [mail.to].filter(Boolean);
  const delivered = [...to, ...(mail.received_for || [])].map(address);
  if (!delivered.includes(account.mailbox.toLowerCase())) throw new HttpError(422, 'Message is not addressed to this mailbox');
  const headers = mail.headers || {};
  return {
    id: `${account.id}:in:${mail.id}`, account_id: account.id, provider_id: mail.id, direction: 'inbound',
    sender: String(mail.from || ''), recipients: JSON.stringify(to), subject: String(mail.subject || '(No subject)'),
    body_text: String(mail.text || ''), body_html: String(mail.html || ''), headers: JSON.stringify(headers),
    attachments: JSON.stringify(mail.attachments || []), message_id: mail.message_id || headers['message-id'] || null,
    in_reply_to: headers['in-reply-to'] || null, received_at: mail.created_at || new Date().toISOString(),
    is_read: 0, archived: 0, status: 'received'
  };
}
export function validateSend(data, configured) {
  const account = configured.find(a => a.id === data.accountId);
  if (!account) throw new HttpError(400, 'Choose a configured sending account');
  const to = (Array.isArray(data.to) ? data.to : String(data.to || '').split(',')).map(v => String(v).trim());
  if (!to.length || to.length > 20 || !to.every(validEmail)) throw new HttpError(400, 'Enter valid recipient addresses, separated by commas');
  if (typeof data.subject !== 'string' || !data.subject.trim() || data.subject.length > 998 || /[\r\n]/.test(data.subject)) throw new HttpError(400, 'Enter a valid subject');
  if (typeof data.text !== 'string' || !data.text.trim() || data.text.length > 100000) throw new HttpError(400, 'Write a message of up to 100,000 characters');
  if (typeof data.requestId !== 'string' || !/^[0-9a-f-]{36}$/i.test(data.requestId)) throw new HttpError(400, 'Invalid send request');
  return { account, payload: { from: `${account.name || account.id} <${account.mailbox}>`, to, subject: data.subject.trim(), text: data.text } };
}
export async function hash(value) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), x => x.toString(16).padStart(2, '0')).join('');
}
export function insertMessage(db, message) {
  const keys = Object.keys(message);
  return db.prepare(`INSERT OR IGNORE INTO messages (${keys.join(',')}) SELECT ${keys.map(() => '?').join(',')} WHERE NOT EXISTS (SELECT 1 FROM deleted_messages WHERE account_id=? AND provider_id=? AND direction=?)`).bind(...Object.values(message),message.account_id,message.provider_id,message.direction);
}
export function publicAccount(a) { return { id: a.id, name: a.name || a.id, mailbox: a.mailbox }; }
