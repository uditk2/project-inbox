// Expands the common recurrence rules (RRULE subset and 5-field cron) into per-day entries for the task calendar.
// Handles DAILY, HOURLY and WEEKLY rules with INTERVAL, BYDAY, BYHOUR, BYMINUTE, COUNT and UNTIL, and standard cron.
// Anything else returns null so the caller can list the schedule without projecting it onto days.
// Times are shown as written in the rule; they are not converted between time zones.
import { pad, ymd as key, addDays } from './format.js';
const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const dayStart = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const daysBetween = (a, b) => Math.round((dayStart(b) - dayStart(a)) / 86400000);
const clock = (h, m) => `${pad(h)}:${pad(m)}`;

function parseRrule(text) {
  const parts = {};
  for (const piece of String(text).replace(/^RRULE:/i, '').split(';')) {
    const [k, v] = piece.split('=');
    if (k && v !== undefined) parts[k.toUpperCase()] = v;
  }
  const nums = v => (v === undefined ? null : v.split(',').map(Number));
  const rule = {
    freq: (parts.FREQ || '').toUpperCase(), interval: Math.max(1, Number(parts.INTERVAL) || 1),
    hours: nums(parts.BYHOUR), minutes: nums(parts.BYMINUTE),
    days: parts.BYDAY ? parts.BYDAY.split(',').map(d => DAYS.indexOf(d.slice(-2).toUpperCase())) : null,
    count: parts.COUNT ? Number(parts.COUNT) : null, until: null
  };
  if (parts.UNTIL) { const m = parts.UNTIL.match(/^(\d{4})(\d{2})(\d{2})/); if (m) rule.until = new Date(+m[1], +m[2] - 1, +m[3], 23, 59, 59); }
  const bad = list => list && list.some(n => !Number.isInteger(n) || n < 0);
  if (!['DAILY', 'HOURLY', 'WEEKLY'].includes(rule.freq) || bad(rule.hours) || bad(rule.minutes) || (rule.days && rule.days.includes(-1))) return null;
  return rule;
}

function cronField(text, min, max) {
  const set = new Set();
  for (const part of text.split(',')) {
    const m = part.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/);
    if (!m) return null;
    let lo, hi;
    if (m[1] === '*') { lo = min; hi = max; }
    else { const [a, b] = m[1].split('-').map(Number); lo = a; hi = b === undefined ? (m[2] ? max : a) : b; }
    const step = m[2] ? Number(m[2]) : 1;
    if (!step || lo < min || hi > max || lo > hi) return null;
    for (let n = lo; n <= hi; n += step) set.add(n);
  }
  return set;
}
function parseCron(text) {
  const fields = String(text).replace(/^CRON_TZ=\S+\s+/, '').trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minute, hour, dom, month, dow] = [cronField(fields[0], 0, 59), cronField(fields[1], 0, 23), cronField(fields[2], 1, 31), cronField(fields[3], 1, 12), cronField(fields[4], 0, 7)];
  if (!minute || !hour || !dom || !month || !dow) return null;
  if (dow.has(7)) { dow.add(0); dow.delete(7); }
  return { minute, hour, dom, month, dow, domAny: fields[2] === '*', dowAny: fields[4] === '*' };
}

function label(times, hourlyEvery) {
  if (hourlyEvery) return hourlyEvery === 1 ? 'Hourly' : `Every ${hourlyEvery}h`;
  if (times.length <= 3) return times.join(', ');
  return `${times.length}× a day`;
}

// Returns Map<'YYYY-MM-DD', {label, times}> for days in [from, to], or null when the rule is not understood.
function project(schedule, from, to) {
  const out = new Map();
  const start = schedule.starts_at ? new Date(schedule.starts_at) : null;
  const firstDay = start ? dayStart(start) : null;
  if (schedule.cadence_type === 'cron') {
    const cron = parseCron(schedule.cadence);
    if (!cron) return null;
    const times = [...cron.hour].sort((a, b) => a - b).flatMap(h => [...cron.minute].sort((a, b) => a - b).map(m => clock(h, m)));
    for (let day = dayStart(from); day <= to; day = addDays(day, 1)) {
      if (firstDay && day < firstDay) continue;
      const domOk = cron.dom.has(day.getDate()), dowOk = cron.dow.has(day.getDay());
      const ok = cron.domAny && cron.dowAny ? true : cron.domAny ? dowOk : cron.dowAny ? domOk : domOk || dowOk;
      if (ok && cron.month.has(day.getMonth() + 1)) out.set(key(day), { label: label(times), times });
    }
    return out;
  }
  const rule = parseRrule(schedule.cadence);
  if (!rule) return null;
  const anchor = start || dayStart(from);
  const hours = rule.hours || [anchor.getHours()], minutes = rule.minutes || [anchor.getMinutes()];
  const times = [...hours].sort((a, b) => a - b).flatMap(h => [...minutes].sort((a, b) => a - b).map(m => clock(h, m)));
  const weekdays = rule.days || [anchor.getDay()];
  const begin = firstDay || dayStart(from);
  let seen = 0;
  for (let day = begin; day <= to; day = addDays(day, 1)) {
    if (rule.until && day > rule.until) break;
    let hit = false;
    if (rule.freq === 'HOURLY') hit = true;
    else if (rule.freq === 'DAILY') hit = daysBetween(begin, day) % rule.interval === 0;
    else if (rule.freq === 'WEEKLY') hit = weekdays.includes(day.getDay()) && Math.floor(daysBetween(addDays(begin, -begin.getDay()), day) / 7) % rule.interval === 0;
    if (!hit) continue;
    const onDay = rule.freq === 'HOURLY' ? 1 : times.filter(t => !(start && key(day) === key(start) && new Date(day.getFullYear(), day.getMonth(), day.getDate(), +t.slice(0, 2), +t.slice(3)) < start)).length;
    if (!onDay) continue;
    if (rule.count && rule.freq !== 'HOURLY') { if (seen >= rule.count) break; seen += onDay; }
    if (day >= dayStart(from)) out.set(key(day), { label: label(times, rule.freq === 'HOURLY' ? rule.interval : 0), times: rule.freq === 'HOURLY' ? [] : times });
  }
  return out;
}

function describe(schedule) {
  const when = times => (times.length ? ` at ${times.slice(0, 3).join(', ')}` : '');
  if (schedule.cadence_type === 'cron') {
    const cron = parseCron(schedule.cadence);
    if (!cron) return schedule.cadence;
    const times = [...cron.hour].sort((a, b) => a - b).flatMap(h => [...cron.minute].sort((a, b) => a - b).map(m => clock(h, m)));
    if (cron.domAny && cron.dowAny) return `Daily${when(times)}`;
    if (cron.domAny) return `${[...cron.dow].sort().map(d => NAMES[d]).join(', ')}${when(times)}`;
    return schedule.cadence;
  }
  const rule = parseRrule(schedule.cadence);
  if (!rule) return schedule.cadence;
  const times = [...(rule.hours || [])].sort((a, b) => a - b).flatMap(h => (rule.minutes || [0]).map(m => clock(h, m)));
  if (rule.count === 1) return `Once${when(times)}`;
  if (rule.freq === 'HOURLY') return rule.interval === 1 ? 'Hourly' : `Every ${rule.interval} hours`;
  if (rule.freq === 'DAILY') return `${rule.interval === 1 ? 'Daily' : `Every ${rule.interval} days`}${when(times)}`;
  return `${rule.interval === 1 ? 'Weekly' : `Every ${rule.interval} weeks`} on ${(rule.days || []).map(d => NAMES[d]).join(', ')}${when(times)}`;
}

export { project, describe, parseRrule, parseCron };
