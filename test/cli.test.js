import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../bin/cli.js', import.meta.url));

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer().listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
    probe.on('error', reject);
  });
}

function start(port, dataDir) {
  const child = spawn(process.execPath, ['--no-warnings', cli, '--port', String(port), '--no-open'], { env: { ...process.env, DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const exited = new Promise(resolve => child.on('exit', code => resolve(code)));
  const ready = new Promise(resolve => { const timer = setInterval(() => { if (output.includes('Press Ctrl+C')) { clearInterval(timer); resolve(); } }, 25); exited.then(() => { clearInterval(timer); resolve(); }); });
  return { child, exited, ready, output: () => output };
}

test('starting on a port where Project Inbox already runs reuses it and exits cleanly', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'pi-cli-'));
  const port = await freePort();
  const first = start(port, dataDir);
  try {
    await first.ready;
    assert.match(first.output(), new RegExp(`http://localhost:${port}`));
    const second = start(port, dataDir);
    assert.equal(await second.exited, 0);
    assert.match(second.output(), /already running/);
    assert.doesNotMatch(second.output(), /Port is in use/);
  } finally {
    first.child.kill('SIGTERM');
    await first.exited;
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('starting on a port held by a different program still fails', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'pi-cli-'));
  const other = createServer((request, response) => { response.writeHead(404); response.end('Not found'); });
  await new Promise(resolve => other.listen(0, '127.0.0.1', resolve));
  try {
    const run = start(other.address().port, dataDir);
    assert.equal(await run.exited, 1);
    assert.match(run.output(), /another program/);
  } finally {
    other.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
