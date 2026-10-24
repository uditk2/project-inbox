#!/usr/bin/env node
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile, chmod } from 'node:fs/promises';
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
  console.log('Project Inbox\n\nproject-inbox                 Open your local inbox\nproject-inbox --demo          Sample inbox (no real email)\nproject-inbox --port 8787      Choose a port\nproject-inbox --no-open        Do not open the browser\n\nNode.js 22.16+ required. Resend receiving must be enabled on each mail domain.');
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
  if (!args.includes('--no-open')) {
    const {execFile}=await import('node:child_process');
    const [command,values]=process.platform==='darwin'?['open',[url]]:process.platform==='win32'?['cmd',['/c','start','',url]]:['xdg-open',[url]];
    execFile(command,values,error=>{if(error) console.log('Open the address above in your browser.');});
  }
});
server.on('error',error=>{console.error(error.code === 'EADDRINUSE'?'Port is in use. Choose another with --port.':'Could not start server.');process.exitCode=1;db.close();});
process.on('SIGINT',()=>server.close(()=>{db.close();process.exit(0);}));
process.on('SIGTERM',()=>server.close(()=>{db.close();process.exit(0);}));
