import {insertMessage,normalizeReceived,normalizeSent,resend} from './core.js';

// One bounded page per direction. Persist cursor and high-water mark together so
// an interrupted history import resumes on the next refresh.
async function syncDirection(db,account,direction) {
  const key=direction==='inbound'?account.id:`${account.id}:sent`;
  const state=await db.prepare('SELECT * FROM sync_state WHERE account_id=?').bind(key).first();
  const base=direction==='inbound'?'/emails/receiving':'/emails';
  const page=await resend(account,`${base}?limit=100${state?.next_cursor?`&after=${encodeURIComponent(state.next_cursor)}`:''}`);
  const rows=page.data || [];
  const head=state?.cycle_head || rows[0]?.id || state?.last_complete_id || null;
  let reached=false; let synced=0; const statements=[];
  for(const mail of rows) {
    if(mail.id===state?.last_complete_id) {reached=true;break;}
    try {
      const message=(direction==='inbound'?normalizeReceived:normalizeSent)(account,mail);
      message.body_loaded=0;
      statements.push(insertMessage(db,message));synced++;
    } catch(e) {if(e.status!==422) throw e;}
  }
  const more=!reached && Boolean(page.has_more) && rows.length>0;
  statements.push(db.prepare('INSERT INTO sync_state (account_id,last_complete_id,next_cursor,cycle_head,last_synced_at) VALUES (?,?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET last_complete_id=excluded.last_complete_id,next_cursor=excluded.next_cursor,cycle_head=excluded.cycle_head,last_synced_at=excluded.last_synced_at').bind(key,more?state?.last_complete_id || null:head,more?rows.at(-1).id:null,more?head:null,new Date().toISOString()));
  await db.batch(statements);
  return {synced,hasMore:more};
}
export async function syncAccount(db,account) {
  const inbound=await syncDirection(db,account,'inbound');
  const outbound=await syncDirection(db,account,'outbound');
  return {synced:inbound.synced+outbound.synced,hasMore:inbound.hasMore || outbound.hasMore};
}
