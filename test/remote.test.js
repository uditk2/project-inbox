import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {openDatabase} from '../src/sqlite.js';
import {insertMessage} from '../src/core.js';
import {pushSchedules, exportSql} from '../src/remote.js';
import {runSetup, withServer, hostedEnv} from '../src/setup.js';

const TOKEN = 'hosted-test-token-at-least-32-characters-long';
const migrations = new URL('../migrations/', import.meta.url);
const cli = fileURLToPath(new URL('../bin/cli.js', import.meta.url));

test('setup --remote points Claude Code, Codex and Claude Desktop at the hosted app, and validates first', async () => {
  assert.throws(() => hostedEnv('http://inbox.example.com', TOKEN), /https/);
  assert.throws(() => hostedEnv('https://inbox.example.com/app', TOKEN), /no path/);
  assert.throws(() => hostedEnv('https://user:pw@inbox.example.com', TOKEN), /https origin/);
  assert.throws(() => hostedEnv('not a url', TOKEN), /look like/);
  assert.throws(() => hostedEnv('https://inbox.example.com', 'short'), /PROJECT_INBOX_TOKEN/);
  const desktop = join(mkdtempSync(join(tmpdir(), 'pi-remote-')), 'claude_desktop_config.json');
  writeFileSync(desktop, '{"mcpServers":{"keep":{"command":"y"}}}');
  const calls = []; const logs = [];
  const exec = async (bin, args) => { calls.push([bin, ...args]); return {stdout: ''}; };
  const results = await runSetup({yes: true, remote: {url: 'https://inbox.example.com', token: TOKEN}, exec, files: {desktop}, log: line => logs.push(line)});
  assert.deepEqual(results, {'Claude Code': 'added', Codex: 'added', 'Claude Desktop': 'added'});
  assert.deepEqual(calls.find(c => c[0] === 'claude' && c[2] === 'add').slice(1), ['mcp', 'add', '--scope', 'user', '-e', 'PROJECT_INBOX_URL=https://inbox.example.com', '-e', `PROJECT_INBOX_TOKEN=${TOKEN}`, 'project-inbox', '--', 'npx', '--yes', 'project-inbox-mcp']);
  assert.deepEqual(calls.find(c => c[0] === 'codex' && c[2] === 'add').slice(1, 4), ['mcp', 'add', '--env']);
  const saved = JSON.parse(readFileSync(desktop, 'utf8'));
  assert.deepEqual(saved.mcpServers['project-inbox'].env, {PROJECT_INBOX_URL: 'https://inbox.example.com', PROJECT_INBOX_TOKEN: TOKEN});
  assert.ok(saved.mcpServers.keep);
  assert.ok(!logs.join('\n').includes(TOKEN), 'the token is never printed');
  // Without --remote nothing changes for local users.
  assert.ok(!('env' in JSON.parse(withServer('')).mcpServers['project-inbox']));
  // Already registered: say how to switch rather than silently keeping the old target.
  logs.length = 0;
  const listed = async (bin, args) => ({stdout: args[1] === 'list' ? 'project-inbox: npx x' : ''});
  assert.equal((await runSetup({yes: true, only: ['claude-code'], remote: {url: 'https://inbox.example.com', token: TOKEN}, exec: listed, files: {desktop}, log: line => logs.push(line)}))['Claude Code'], 'done');
  assert.match(logs.join('\n'), /remove the existing "project-inbox" entry/);
});

test('the CLI refuses a hosted setup without a token and never starts a local app for it', () => {
  const run = (args, env = {}) => spawnSync(process.execPath, ['--no-warnings', cli, ...args], {encoding: 'utf8', timeout: 20000, env: {...process.env, PROJECT_INBOX_TOKEN: '', ...env}});
  const noToken = run(['setup', '--remote', 'https://inbox.example.com', '--for', 'codex']);
  assert.equal(noToken.status, 1);
  assert.match(noToken.stderr, /PROJECT_INBOX_TOKEN/);
  const badUrl = run(['setup', '--remote', 'http://inbox.example.com', '--for', 'codex'], {PROJECT_INBOX_TOKEN: TOKEN});
  assert.equal(badUrl.status, 1);
  assert.match(badUrl.stderr, /https/);
  assert.ok(!(noToken.stdout + badUrl.stdout).includes('Press Ctrl+C'));
  const missingDb = run(['export-sql', '--out', join(mkdtempSync(join(tmpdir(), 'pi-out-')), 'x.sql')], {DATA_DIR: mkdtempSync(join(tmpdir(), 'pi-empty-'))});
  assert.equal(missingDb.status, 1);
});

function codexHome() {
  const home = mkdtempSync(join(tmpdir(), 'pi-codex-'));
  for (const [id, name, rrule] of [['daily-one', 'Daily one', 'FREQ=DAILY;BYHOUR=9'], ['hourly-two', 'Hourly two', 'FREQ=HOURLY;INTERVAL=6']]) {
    mkdirSync(join(home, 'automations', id), {recursive: true});
    writeFileSync(join(home, 'automations', id, 'automation.toml'), `id = "${id}"\nname = "${name}"\nstatus = "ACTIVE"\nrrule = "${rrule}"\ncreated_at = 1790000000000\nprompt = """\nSECRET INSTRUCTIONS do not leak\n"""\n`);
  }
  return home;
}

test('push-schedules sends names and schedules, never prompts, with the token, over https only', async () => {
  const seen = [];
  const fetcher = async (url, init) => { seen.push({url, init}); return Response.json({saved: 2}, {status: 201}); };
  const result = await pushSchedules({url: 'https://inbox.example.com', token: TOKEN, home: codexHome(), fetcher});
  assert.deepEqual(result, {found: true, pushed: 2});
  assert.equal(seen[0].url, 'https://inbox.example.com/api/schedules');
  assert.equal(seen[0].init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(seen[0].init.redirect, 'error');
  const body = JSON.parse(seen[0].init.body);
  assert.deepEqual(body.schedules.map(s => s.external_id).sort(), ['daily-one', 'hourly-two']);
  assert.ok(!seen[0].init.body.includes('SECRET INSTRUCTIONS'));
  await assert.rejects(pushSchedules({url: 'http://inbox.example.com', token: TOKEN, home: codexHome(), fetcher}), /https/);
  await assert.rejects(pushSchedules({url: 'https://inbox.example.com', token: TOKEN, home: codexHome(), fetcher: async () => new Response('{}', {status: 401})}), /rejected PROJECT_INBOX_TOKEN/);
  await assert.rejects(pushSchedules({url: 'https://inbox.example.com', token: TOKEN, home: codexHome(), fetcher: async () => new Response('{}', {status: 500})}), /500/);
  const none = await pushSchedules({url: 'https://inbox.example.com', token: TOKEN, home: join(tmpdir(), 'pi-no-codex-home'), fetcher: async () => { throw new Error('must not be called'); }});
  assert.deepEqual(none, {found: false, pushed: 0});
});

test('export-sql produces statements D1 accepts: complete rows, short enough, no transactions, oversized bodies dropped', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-export-'));
  const path = join(dir, 'inbox.sqlite');
  const db = openDatabase(path, migrations);
  const base = {account_id: 'slayfit', direction: 'inbound', sender: 'a@example.com', recipients: '["udit@slayfit.fun"]', headers: '{}', attachments: '[]', received_at: '2026-11-01T10:00:00.000Z', is_read: 0, archived: 0, status: 'received'};
  await insertMessage(db, {...base, id: 'slayfit:in:small', provider_id: 'small', subject: "It's a quote 'test'", body_text: "O'Reilly said: it's \"fine\"\nnew line", body_loaded: 1}).run();
  await insertMessage(db, {...base, id: 'slayfit:in:huge', provider_id: 'huge', subject: 'Huge', body_text: 'x'.repeat(30000), body_html: '<p>' + 'y'.repeat(120000) + '</p>', headers: '{"a":"b"}', body_loaded: 1}).run();
  await db.prepare('INSERT INTO mail_accounts VALUES (?,?,?,?,?)').bind('slayfit', 'SlayFit', 'udit@slayfit.fun', '{"iv":"AAAA","data":"BBBB"}', '2026-11-01T00:00:00.000Z').run();
  await db.prepare('INSERT INTO tasks (id,task_date,title,created_at,updated_at,external_ref) VALUES (?,?,?,?,?,?)').bind('t1', '2026-11-04', 'Task', 'now', 'now', 'ref1').run();
  await db.prepare('INSERT INTO task_events VALUES (?,?,?,?,?)').bind('e1', 't1', 'now', 'planned', 'made').run();
  await db.prepare('INSERT INTO schedules VALUES (?,?,?,?,?,?,?,?,?)').bind('s1', 'claude', 'daily', 'Daily', 'cron', '0 9 * * *', 1, null, 'now').run();
  db.close();
  const {sql, counts} = exportSql(path);
  assert.deepEqual(counts, {messages: 2, deleted_messages: 0, outbox: 0, sync_state: 0, mail_accounts: 1, drafts: 0, feedback: 0, tasks: 1, task_events: 1, schedules: 1});
  for (const line of sql.split('\n')) assert.ok(line.length < 100000, 'every statement fits D1');
  assert.doesNotMatch(sql, /\b(BEGIN|COMMIT|PRAGMA)\b/i);
  // Load it into a fresh database, the way D1 would, and compare.
  const target = new DatabaseSync(':memory:');
  target.exec('PRAGMA foreign_keys=ON');
  for (const name of readdirSync(fileURLToPath(migrations)).filter(n => n.endsWith('.sql')).sort()) target.exec(readFileSync(new URL(name, migrations), 'utf8'));
  target.exec(sql);
  const small = target.prepare("SELECT * FROM messages WHERE id='slayfit:in:small'").get();
  assert.equal(small.subject, "It's a quote 'test'");
  assert.equal(small.body_text, "O'Reilly said: it's \"fine\"\nnew line");
  assert.equal(small.body_loaded, 1);
  const huge = target.prepare("SELECT * FROM messages WHERE id='slayfit:in:huge'").get();
  assert.deepEqual([huge.body_text, huge.body_html, huge.headers, huge.body_loaded, huge.subject], ['', '', '{}', 0, 'Huge']);
  assert.equal(target.prepare('SELECT COUNT(*) AS n FROM task_events').get().n, 1);
  assert.equal(target.prepare("SELECT encrypted_credentials FROM mail_accounts").get().encrypted_credentials, '{"iv":"AAAA","data":"BBBB"}');
  assert.equal(target.prepare('SELECT cadence FROM schedules').get().cadence, '0 9 * * *');
  // Loading it twice is safe.
  target.exec(sql);
  assert.equal(target.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 2);
  target.close();
  rmSync(dir, {recursive: true, force: true});
});
