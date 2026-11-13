// Commands that run on your own computer and work with a hosted Project Inbox: push the Codex schedules it cannot
// see, and export the local database as SQL for D1. Nothing here runs inside the Worker.
import {DatabaseSync} from 'node:sqlite';
import {scanCodex} from './scan.js';
import {hostedEnv} from './setup.js';

const BATCH = 100;
// D1 rejects a statement longer than 100,000 bytes. Stay clear of it.
const MAX_STATEMENT = 90000;

// Reads Codex automations from this computer (name, schedule, on/off state only) and saves them to the hosted calendar.
export async function pushSchedules({url, token, home, fetcher = fetch, log = () => {}}) {
  const {PROJECT_INBOX_URL: origin} = hostedEnv(url, token);
  const {found, schedules} = await scanCodex(home);
  if (!found) { log('No Codex automations folder found on this computer, so there is nothing to push.'); return {found: false, pushed: 0}; }
  let pushed = 0;
  for (let i = 0; i < schedules.length; i += BATCH) {
    const batch = schedules.slice(i, i + BATCH);
    const response = await fetcher(`${origin}/api/schedules`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json'},
      body: JSON.stringify({schedules: batch})
    });
    if (response.status === 401) throw new Error('The hosted Project Inbox rejected PROJECT_INBOX_TOKEN.');
    if (!response.ok) throw new Error(`The hosted Project Inbox could not save the schedules (${response.status}).`);
    pushed += batch.length;
  }
  log(`Pushed ${pushed} Codex schedule${pushed === 1 ? '' : 's'} to ${origin}.`);
  return {found: true, pushed};
}

// Parents before children, so foreign keys hold while the file loads.
const TABLES = ['messages', 'deleted_messages', 'outbox', 'sync_state', 'mail_accounts', 'drafts', 'feedback', 'tasks', 'task_events', 'schedules'];
const BODY_COLUMNS = {body_text: "quote('')", body_html: "quote('')", headers: "quote('{}')", attachments: "quote('[]')", body_loaded: 'quote(0)'};

// Writes the local database as plain INSERT statements that `wrangler d1 execute --file` can load.
// Messages too big for one D1 statement keep their metadata and drop their bodies; the app fetches a body from
// Resend the first time the message is opened, exactly as it does for mail it has only listed.
export function exportSql(path) {
  const db = new DatabaseSync(path, {readOnly: true});
  try {
    const lines = ['-- Project Inbox export for Cloudflare D1. Load it with: npx wrangler d1 execute project-inbox --remote --file <this file>'];
    const counts = {};
    for (const table of TABLES) {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
      if (!columns.length) continue;
      const select = override => `SELECT ${columns.map(c => `${override?.[c] ?? `quote("${c}")`} AS "${c}"`).join(',')} FROM ${table}`;
      const statement = row => `INSERT OR REPLACE INTO ${table} (${columns.map(c => `"${c}"`).join(',')}) VALUES (${columns.map(c => row[c]).join(',')});`;
      let count = 0;
      for (const row of db.prepare(select()).iterate()) {
        let sql = statement(row);
        if (sql.length > MAX_STATEMENT && table === 'messages') {
          const slim = db.prepare(`${select(BODY_COLUMNS)} WHERE id=${row.id}`).get();
          sql = statement(slim);
        }
        if (sql.length > MAX_STATEMENT) throw new Error(`A row in ${table} is too large for D1 and cannot be exported.`);
        lines.push(sql);
        count++;
      }
      counts[table] = count;
    }
    return {sql: `${lines.join('\n')}\n`, counts};
  } finally { db.close(); }
}
