// One-command setup: registers the Project Inbox MCP server with the AI tools found on this computer.
// Every external effect (running a CLI, reading or writing a file, asking a question) is injected so it can be tested.
import { execFile } from 'node:child_process';
import { access, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);
export const NAME = 'project-inbox';
export const MCP_COMMAND = ['npx', '--yes', 'project-inbox-mcp'];

// Adds the server to a Claude Desktop style config (JSON with an mcpServers map), keeping everything else.
export function withServer(text) {
  const config = text.trim() ? JSON.parse(text) : {};
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Unexpected config format');
  if (config.mcpServers && (typeof config.mcpServers !== 'object' || Array.isArray(config.mcpServers))) throw new Error('Unexpected mcpServers format');
  if (config.mcpServers?.[NAME]) return null;
  config.mcpServers = { ...config.mcpServers, [NAME]: { command: MCP_COMMAND[0], args: MCP_COMMAND.slice(1) } };
  return `${JSON.stringify(config, null, 2)}\n`;
}

export function desktopConfigPath({ platform = process.platform, home = homedir(), env = process.env } = {}) {
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  if (platform === 'win32') return join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'Claude', 'claude_desktop_config.json');
}

const exists = path => access(path).then(() => true, () => false);

// A client with its own `mcp add` command (Claude Code, Codex).
const cliClient = (key, label, bin, addArgs) => ({
  key, label,
  async check({ exec }) {
    try { await exec(bin, ['--version']); } catch { return 'missing'; }
    try {
      const { stdout } = await exec(bin, ['mcp', 'list']);
      if (new RegExp(`(^|\\s)${NAME}(\\s|:|$)`, 'm').test(stdout)) return 'done';
    } catch { /* listing is best effort; try to add */ }
    return 'ready';
  },
  install: ({ exec }) => exec(bin, [...addArgs, NAME, '--', ...MCP_COMMAND])
});

const desktopClient = {
  key: 'claude-desktop',
  label: 'Claude Desktop',
  async check({ files }) {
    const path = files.desktop;
    if (!(await exists(dirname(path)))) return 'missing';
    try { return withServer(await readFile(path, 'utf8')) === null ? 'done' : 'ready'; }
    catch (error) { return error.code === 'ENOENT' ? 'ready' : 'unreadable'; }
  },
  async install({ files }) {
    const path = files.desktop;
    let text = '';
    try { text = await readFile(path, 'utf8'); await copyFile(path, `${path}.bak`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, withServer(text));
  }
};

export const clients = [
  cliClient('claude-code', 'Claude Code', 'claude', ['mcp', 'add', '--scope', 'user']),
  cliClient('codex', 'Codex', 'codex', ['mcp', 'add']),
  desktopClient
];

// "--for codex", "--for claude" (Claude Code and Claude Desktop) or "--for claude-code,codex". Null means every tool found.
export function parseTargets(value, list = clients) {
  if (!value) return null;
  const keys = new Set();
  for (const name of value.toLowerCase().split(',').map(part => part.trim()).filter(Boolean)) {
    const matches = name === 'all' ? list : name === 'claude' ? list.filter(c => c.key.startsWith('claude')) : list.filter(c => c.key === name);
    if (!matches.length) throw new Error(`Unknown tool "${name}". Choose from: ${list.map(c => c.key).join(', ')}, claude, all.`);
    matches.forEach(c => keys.add(c.key));
  }
  return [...keys];
}

export async function askYesNo(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return !/^n/i.test((await rl.question(`${question} [Y/n] `)).trim()); } finally { rl.close(); }
}

// Returns a result per client: done (already set up), added, skipped, missing, failed, unreadable.
export async function runSetup({ yes = false, only = null, ask = askYesNo, log = console.log, exec = run, files = { desktop: desktopConfigPath() }, list = clients } = {}) {
  const context = { exec, files };
  const results = {};
  for (const client of list.filter(c => !only || only.includes(c.key))) {
    const state = await client.check(context);
    if (state === 'missing') { results[client.label] = 'missing'; continue; }
    if (state === 'unreadable') { log(`${client.label}: could not read its config, so I left it alone.`); results[client.label] = 'unreadable'; continue; }
    if (state === 'done') { log(`${client.label}: already set up.`); results[client.label] = 'done'; continue; }
    if (!yes && !only && !(await ask(`Add Project Inbox to ${client.label}?`))) { results[client.label] = 'skipped'; continue; }
    try { await client.install(context); log(`${client.label}: added. Restart it to pick up the new tool.`); results[client.label] = 'added'; }
    catch { log(`${client.label}: could not add it automatically.`); results[client.label] = 'failed'; }
  }
  const missing = Object.keys(results).filter(label => results[label] === 'missing');
  if (missing.length) log(`Not found on this computer: ${missing.join(', ')}.`);
  return results;
}
