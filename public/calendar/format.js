// Constants and pure helpers for the task calendar. No DOM and no network, so everything here is unit-testable.
export const STATUS = {
  planned: ['Planned', '○'], in_progress: ['In progress', '▶'], drafted: ['Drafted', '✎'], sent: ['Sent', '↗'], published: ['Published', '✓'],
  backlink_verified: ['Backlink verified', '✓'], withdrawn: ['Withdrawn', '–'], failed: ['Failed', '✕']
};
export const KIND = { post: 'Post', outreach: 'Outreach', listing: 'Listing', profile: 'Profile', other: 'Task' };
export const SOURCE = { codex: 'Codex', claude: 'Claude', other: 'Other' };
export const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export const pad = n => String(n).padStart(2, '0');
export const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const isDayString = value => /^\d{4}-\d{2}-\d{2}$/.test(value);
export const today = () => ymd(new Date());
export const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
export const startOfMonth = d => new Date(d.getFullYear(), d.getMonth(), 1);
export const parseDay = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
export const longDate = (day, options = { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) => parseDay(day).toLocaleDateString(undefined, options);
export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export function groupBy(items, keyOf) {
  const groups = new Map();
  for (const item of items) { const key = keyOf(item); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(item); }
  return groups;
}
export const safeLink = url => (/^https?:\/\/[^\s<>"]+$/i.test(url || '') ? url : '');
export const statusLabel = status => STATUS[status]?.[0] || status;
export const statusGlyph = status => STATUS[status]?.[1] || '•';

// The weeks shown for a month, starting on Monday: first visible day, number of weeks, last visible day.
export function monthGrid(month) {
  const offset = (month.getDay() + 6) % 7;
  const start = new Date(month.getFullYear(), month.getMonth(), 1 - offset);
  const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const weeks = Math.ceil((offset + daysInMonth) / 7);
  return { start, weeks, end: addDays(start, weeks * 7 - 1) };
}
