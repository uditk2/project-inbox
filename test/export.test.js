import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/sqlite.js';
import { encryptCredentials, loadAccounts } from '../src/core.js';

const migrations = new URL('../migrations/', import.meta.url);
const script = fileURLToPath(new URL('../cloudflare/export-for-d1.mjs', import.meta.url));

test('exported accounts decrypt on the hosted side with the same CREDENTIALS_KEY, and only with --accounts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-export-'));
  try {
    const KEY = 'k'.repeat(40);
    const localPath = join(dir, 'local.sqlite');
    const local = openDatabase(localPath, migrations);
    const sealed = await encryptCredentials({ CREDENTIALS_KEY: KEY }, 'proj', { apiKey: 're_fake_test_key' });
    await local.prepare('INSERT INTO mail_accounts VALUES (?,?,?,?,?)').bind('proj', 'Proj', 'hi@proj.example', sealed, 'now').run();
    local.close();
    const run = args => spawnSync(process.execPath, ['--no-warnings', script, '--db', localPath, ...args], { encoding: 'utf8' });
    assert.ok(!run([]).stdout.includes('mail_accounts'));
    const sql = run(['--accounts']).stdout;
    assert.ok(!sql.includes('re_fake_test_key'), 'plaintext key must never be exported');
    const hostedPath = join(dir, 'hosted.sqlite');
    openDatabase(hostedPath, migrations).close();
    const raw = new DatabaseSync(hostedPath); raw.exec(sql); raw.close();
    const hosted = openDatabase(hostedPath, migrations);
    try {
      const [account] = await loadAccounts({ DB: hosted, CREDENTIALS_KEY: KEY, MAIL_ACCOUNTS_JSON: '[]' });
      assert.equal(account.apiKey, 're_fake_test_key');
      await assert.rejects(loadAccounts({ DB: hosted, CREDENTIALS_KEY: 'x'.repeat(40), MAIL_ACCOUNTS_JSON: '[]' }));
    } finally { hosted.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
