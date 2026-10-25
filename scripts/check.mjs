// Syntax-checks every JavaScript file the package ships, so new files never need adding to a list.
import {readdirSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

const files = [];
const walk = dir => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) { if (name !== 'node_modules') walk(path); }
    else if (path.endsWith('.js')) files.push(path);
  }
};
['bin', 'src', 'public'].forEach(walk);
let failed = false;
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], {encoding:'utf8'});
  if (result.status !== 0) { failed = true; console.error(`${file}\n${result.stderr}`); }
}
console.log(`${failed ? 'Syntax errors found' : 'Syntax OK'} (${files.length} files)`);
process.exit(failed ? 1 : 0);
