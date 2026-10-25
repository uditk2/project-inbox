import {readdir, readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';

// Reads only the fields the calendar needs from Codex automation files: id, name, schedule, on/off state, creation time.
// Prompts and every other field are never parsed, stored or returned.
const FIELD = /^(id|name|status|rrule|created_at)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|(\d+))\s*$/;
const unescape = value => value.replace(/\\(["\\])/g, '$1');

export function parseAutomation(text) {
  const out = {};
  let inBlock = false;
  for (const line of String(text).slice(0, 512000).split(/\r?\n/)) {
    const quotes = (line.match(/"""/g) || []).length;
    if (inBlock) { if (quotes % 2 === 1) inBlock = false; continue; }
    if (quotes % 2 === 1) { inBlock = true; continue; }
    if (line.startsWith('[')) break;                         // stop at the first table such as [target]
    const match = line.match(FIELD);
    if (match && !(match[1] in out)) out[match[1]] = match[2] !== undefined ? unescape(match[2]) : match[3];
  }
  if (!out.id || !out.name || !out.rrule) return null;
  const created = Number(out.created_at);
  return {
    source:'codex', external_id:out.id, name:out.name.slice(0, 200), cadence_type:'rrule', cadence:out.rrule,
    enabled:String(out.status || 'ACTIVE').toUpperCase() === 'ACTIVE',
    starts_at:Number.isFinite(created) && created > 0 ? new Date(created).toISOString() : null
  };
}

export async function scanCodex(home = process.env.CODEX_HOME || join(homedir(), '.codex')) {
  const dir = join(home, 'automations');
  let entries;
  try { entries = await readdir(dir, {withFileTypes:true}); }
  catch (error) { if (error.code === 'ENOENT') return {found:false, schedules:[]}; throw error; }
  const schedules = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const parsed = parseAutomation(await readFile(join(dir, entry.name, 'automation.toml'), 'utf8'));
      if (parsed) schedules.push(parsed);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return {found:true, schedules};
}
