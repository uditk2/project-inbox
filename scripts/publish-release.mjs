import fs from 'node:fs';
import {execFileSync} from 'node:child_process';

const {name,version}=JSON.parse(fs.readFileSync('package.json','utf8'));
const endpoint=`https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`;
async function lookup() {
  const response=await fetch(endpoint,{headers:{'Cache-Control':'no-cache'},signal:AbortSignal.timeout(15000)});
  if(response.status===404) return null;
  if(!response.ok) throw new Error(`Registry lookup failed: ${response.status}`);
  return response.json();
}
let published;
if(!process.argv.includes('--verify-only')) {
  execFileSync('npm',['publish','--access','public','--provenance'],{stdio:'inherit'});
}
for(let attempt=0;attempt<24;attempt++) {
  published=await lookup();
  if(published?.version===version && published.dist?.tarball) break;
  console.log('Waiting for npm registry publication to become visible…');
  await new Promise(resolve=>setTimeout(resolve,5000));
}
if(published?.version!==version || !published.dist?.tarball || !published.dist?.integrity) throw new Error('Published artifact could not be verified on the registry');
const summary=`Verified **${name}@${version}**: ${published.dist.tarball}\n`;
console.log(summary);
if(process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,summary);
