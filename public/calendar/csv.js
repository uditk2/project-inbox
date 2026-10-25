// Backfill: turn a post-log.csv (date, game, destination, status, result_url, account, notes) into calendar tasks.
import { STATUS, isDayString } from './format.js';

const REQUIRED = ['date', 'game', 'destination', 'status'];

export function parseCsv(text) {
  const rows = []; let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; } else field += c; }
    else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(v => v.trim()));
}

export function inferKind(destination) {
  const d = destination.toLowerCase();
  if (/reddit|^r\/|hacker news|show hn|x\.com|twitter/.test(d)) return 'post';
  if (/profile/.test(d)) return 'profile';
  if (/listing|submit|directory|indiedb|paizix|crazygames|itch/.test(d)) return 'listing';
  return 'outreach';
}

// Returns {tasks, skipped}. The same row always gets the same external_ref, so importing a file twice updates instead of duplicating.
export function postLogToTasks(text, project) {
  const rows = parseCsv(text);
  const header = (rows.shift() || []).map(h => h.trim().toLowerCase());
  const col = name => header.indexOf(name);
  if (REQUIRED.some(name => col(name) < 0)) throw new Error('This does not look like a post-log.csv. Expected columns: date, game, destination, status, result_url, account, notes.');
  const tasks = [], skipped = [];
  for (const row of rows) {
    const get = name => (col(name) >= 0 ? (row[col(name)] || '').trim() : '');
    const [date, game, destination, status, url] = [get('date'), get('game'), get('destination'), get('status'), get('result_url')];
    if (!STATUS[status] || !isDayString(date)) { skipped.push(row.join(',').slice(0, 60)); continue; }
    tasks.push({
      task_date: date, project, kind: inferKind(destination), title: game || destination, destination, status,
      result_url: /^https?:\/\//i.test(url) ? url : '', notes: get('notes').slice(0, 5000), external_ref: `csv|${date}|${destination}|${game}`
    });
  }
  if (!tasks.length) throw new Error('No usable rows found in that file.');
  return { tasks, skipped };
}
