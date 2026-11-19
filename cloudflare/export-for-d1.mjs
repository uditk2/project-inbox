#!/usr/bin/env node
// Writes your local task calendar (and optionally mail state) as SQL you can load into the Cloudflare D1 database.
// Resend keys are exported only as the encrypted rows, and only with --accounts. They are unreadable without the encryption
// key in ~/.project-inbox/credentials.key, which this script never reads. To keep your saved keys, set the Worker's
// CREDENTIALS_KEY secret to that same value (see README), or add the accounts again in the hosted Settings.
//   node cloudflare/export-for-d1.mjs [--accounts] [--messages] [--only table,table] [--db ~/.project-inbox/inbox.sqlite] > project-inbox-export.sql
//   npx wrangler d1 execute project-inbox --remote --file project-inbox-export.sql
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const dbPath = args.includes('--db') ? args[args.indexOf('--db') + 1] : join(process.env.DATA_DIR || join(homedir(), '.project-inbox'), 'inbox.sqlite');
const tables = [...(args.includes('--accounts') ? ['mail_accounts'] : []), 'tasks', 'task_events', 'schedules', 'drafts', 'outbox', 'deleted_messages', 'feedback', ...(args.includes('--messages') ? ['messages'] : [])];
// --only picks exact tables. Messages replace rows already in D1, so read, archive and trash state from this computer wins.
const only = args.includes('--only') ? args[args.indexOf('--only') + 1].split(',') : null;
const literal = value => value === null || value === undefined ? 'NULL' : typeof value === 'number' || typeof value === 'bigint' ? String(value) : `'${String(value).replaceAll("'", "''")}'`;

const db = new DatabaseSync(dbPath, { readOnly: true });
const counts = {};
for (const table of only || tables) {
  const rows = db.prepare(`SELECT * FROM ${table}`).all();
  counts[table] = rows.length;
  for (const row of rows) {
    const keys = Object.keys(row);
    console.log(`INSERT OR ${table === 'messages' ? 'REPLACE' : 'IGNORE'} INTO ${table} (${keys.join(',')}) VALUES (${keys.map(k => literal(row[k])).join(',')});`);
  }
}
console.error('Exported rows:', JSON.stringify(counts));
