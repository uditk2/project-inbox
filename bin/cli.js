#!/usr/bin/env node
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { Readable } from 'node:stream';
import app from '../src/app.js';
import { openDatabase } from '../src/sqlite.js';
import { demoAccounts, seedDemo } from '../src/demo.js';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Project Inbox\n\nproject-inbox                 Open your local inbox\nproject-inbox setup           Connect your AI tools (Claude, Codex), then open your inbox\nproject-inbox setup --yes     Same, without asking questions\nproject-inbox setup --for codex     Only some tools: claude, claude-code, claude-desktop, codex\nproject-inbox setup --remote https://inbox.example.com     Point your AI tools at a hosted Project Inbox (token in PROJECT_INBOX_TOKEN)\nproject-inbox push-schedules --remote https://inbox.example.com   Send this computer\'s Codex schedules to a hosted inbox\nproject-inbox export-sql [--out inbox.sql]   Export your local data for a hosted inbox (Cloudflare D1)\nproject-inbox --demo          Sample inbox (no real email)\nproject-inbox --port 8787      Choose a port\nproject-inbox --no-open        Do not open the browser\n\nNode.js 22.16+ required. Resend receiving must be enabled on each mail domain.');
  process.exit(0);
}
if (args[0] === 'setup') {
  const { runSetup, parseTargets } = await import('../src/setup.js');
  const forArg = args.indexOf('--for');
  let only;
  try { only = parseTargets(forArg >= 0 ? args[forArg+1] : null); } catch (error) { console.error(error.message); process.exit(1); }
  const remoteArg = args.indexOf('--remote');
  const remote = remoteArg >= 0 ? { url: args[remoteArg+1], token: process.env.PROJECT_INBOX_TOKEN } : null;
  try { await runSetup({ yes: args.includes('--yes'), only, remote }); } catch (error) { console.error(error.message); process.exit(1); }
  if (remote) process.exit(0);   // a hosted inbox needs no local app
}
if (args[0] === 'push-schedules' || args[0] === 'export-sql') {
  const option = name => { const i = args.indexOf(name); return i >= 0 ? args[i+1] : undefined; };
  try {
    if (args[0] === 'push-schedules') {
      const { pushSchedules } = await import('../src/remote.js');
      await pushSchedules({ url: option('--remote'), token: process.env.PROJECT_INBOX_TOKEN, log: console.log });
    } else {
      const { exportSql } = await import('../src/remote.js');
      const source = join(process.env.DATA_DIR || join(homedir(),'.project-inbox'),'inbox.sqlite');
      const { sql, counts } = exportSql(source);
      const out = option('--out') || 'inbox.sql';
      await writeFile(out, sql, { mode: 0o600 });
      console.log(`Wrote ${out}. Rows: ${Object.entries(counts).map(([table, n]) => `${table} ${n}`).join(', ')}.\nIt contains your mail and encrypted account keys, so keep it private and delete it after loading it.`);
    }
  } catch (error) { console.error(error.code === 'ERR_SQLITE_ERROR' ? 'Could not read the local Project Inbox database.' : error.message); process.exit(1); }
  process.exit(0);
}
// Optional local configuration. Never included in the public package.
try { process.loadEnvFile(resolve('.env')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
const portArg = args.indexOf('--port');
const port = Number(portArg >= 0 ? args[portArg+1] : process.env.PORT || 8787);
if (!Number.isInteger(port) || port<1 || port>65535) throw new Error('Invalid port');
const demo = args.includes('--demo');
const dir = new URL('../',import.meta.url);
const dataDir = process.env.DATA_DIR || join(homedir(),'.project-inbox');
if (!demo) await mkdir(dataDir,{recursive:true,mode:0o700});
const announce = join(dataDir,'server.json');
const forget = () => rm(announce,{force:true}).catch(()=>{});
let credentialsKey = process.env.CREDENTIALS_KEY;
if (!credentialsKey) {
  if (demo) credentialsKey = randomBytes(32).toString('base64url');
  else {
    const keyPath=join(dataDir,'credentials.key');
    try {credentialsKey=(await readFile(keyPath,'utf8')).trim();}
    catch(e) {if(e.code!=='ENOENT') throw e; credentialsKey=randomBytes(32).toString('base64url'); await writeFile(keyPath,credentialsKey,{mode:0o600,flag:'wx'});}
    await chmod(keyPath,0o600);
  }
}
const db = openDatabase(demo ? ':memory:' : join(dataDir,'inbox.sqlite'),new URL('migrations/',dir));
if (!demo) await chmod(join(dataDir,'inbox.sqlite'),0o600);
const env = {...process.env, DB:db, LOCAL_APP:'true', CREDENTIALS_KEY:credentialsKey, LOCAL_DEMO:demo?'true':'false'};
if (demo) { env.MAIL_ACCOUNTS_JSON = JSON.stringify(demoAccounts); await seedDemo(db); }
const types = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.webmanifest':'application/manifest+json'};
env.ASSETS = {fetch: async request => {
  const pathname = decodeURIComponent(new URL(request.url).pathname);
  const asset = pathname === '/' ? 'index.html' : pathname.slice(1);
  const base = fileURLToPath(new URL('public/',dir));
  const full = resolve(base,asset);
  if (!full.startsWith(base) || !types[extname(full)]) return new Response('Not found',{status:404});
  try { return new Response(await readFile(full),{headers:{'Content-Type':types[extname(full)]}}); }
  catch {return new Response('Not found',{status:404});}
}};
const server = createServer(async (incoming,outgoing) => {
  try {
    const host = incoming.headers.host || `localhost:${port}`;
    const request = new Request(`http://${host}${incoming.url}`,{method:incoming.method,headers:incoming.headers,...(['GET','HEAD'].includes(incoming.method)?{}:{body:Readable.toWeb(incoming),duplex:'half'})});
    const response = await app.fetch(request,env);
    outgoing.writeHead(response.status,Object.fromEntries(response.headers));
    if (response.body) Readable.fromWeb(response.body).pipe(outgoing); else outgoing.end();
  } catch {outgoing.writeHead(500);outgoing.end('Request failed');}
});
server.listen(port,'127.0.0.1',async()=>{
  const url=`http://localhost:${port}`;
  console.log(`Project Inbox: ${url}${demo?' (demo data only)':''}\nPress Ctrl+C to stop.`);
  // Lets project-inbox-mcp find this app if it runs on a port other than 8787. Demo runs never advertise themselves.
  if (!demo) await writeFile(announce,JSON.stringify({url:`http://127.0.0.1:${port}`,pid:process.pid}),{mode:0o600}).catch(()=>{});
  if (!args.includes('--no-open')) {
    const {execFile}=await import('node:child_process');
    const [command,values]=process.platform==='darwin'?['open',[url]]:process.platform==='win32'?['cmd',['/c','start','',url]]:['xdg-open',[url]];
    execFile(command,values,error=>{if(error) console.log('Open the address above in your browser.');});
  }
});
// Another Project Inbox already on this port is not an error: reuse it. Only a different program on the port is.
const projectInboxRunning = async () => {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/session`,{redirect:'error',signal:AbortSignal.timeout(2000),headers:{Accept:'application/json'}});
    const body = await response.json();
    return response.ok && Array.isArray(body.accounts) && typeof body.demo === 'boolean';
  } catch { return false; }
};
server.on('error',async error=>{
  db.close();
  if (error.code === 'EADDRINUSE' && await projectInboxRunning()) { console.log(`Project Inbox is already running at http://localhost:${port}. Using that one.`); return; }
  console.error(error.code === 'EADDRINUSE'?'Port is in use by another program. Choose another with --port.':'Could not start server.');
  process.exitCode=1;
});
for (const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>server.close(async()=>{if(!demo) await forget();db.close();process.exit(0);}));
