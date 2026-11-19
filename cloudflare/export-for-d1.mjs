#!/usr/bin/env node
// Writes your local task calendar (and optionally mail state) as SQL you can load into the Cloudflare D1 database.
// Never exports Resend keys or the encryption key: add accounts again in the hosted app's Settings.
//   node cloudflare/export-for-d1.mjs [--messages] [--db ~/.project-inbox/inbox.sqlite] > project-inbox-export.sql
//   npx wrangler d1 execute project-inbox --remote --file project-inbox-export.sql
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const dbPath = args.includes('--db') ? args[args.indexOf('--db') + 1] : join(process.env.DATA_DIR || join(homedir(), '.project-inbox'), 'inbox.sqlite');
const tables = ['tasks', 'task_events', 'schedules', 'drafts', 'outbox', 'deleted_messages', 'feedback', ...(args.includes('--messages') ? ['messages'] : [])];
const literal = value => value === null || value === undefined ? 'NULL' : typeof value === 'number' || typeof value === 'bigint' ? String(value) : `'${String(value).replaceAll("'", "''")}'`;

const db = new DatabaseSync(dbPath, { readOnly: true });
const counts = {};
for (const table of tables) {
  const rows = db.prepare(`SELECT * FROM ${table}`).all();
  counts[table] = rows.length;
  for (const row of rows) {
    const keys = Object.keys(row);
    console.log(`INSERT OR IGNORE INTO ${table} (${keys.join(',')}) VALUES (${keys.map(k => literal(row[k])).join(',')});`);
  }
}
console.error('Exported rows:', JSON.stringify(counts));
