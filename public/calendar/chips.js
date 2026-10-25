// Small reusable pieces of markup. Relies on `el` from app.js.
import { SOURCE, statusLabel, statusGlyph } from './format.js';

const glyph = text => el('span', 'task-glyph', text);

export function statusChip(status, suffix = '') {
  const chip = el('span', `task-status status-${status}`);
  chip.append(glyph(statusGlyph(status)), document.createTextNode(statusLabel(status) + suffix));
  return chip;
}

// A one-line chip inside a calendar cell.
export function cellChip(className, symbol, label, title) {
  const chip = el('span', `cal-chip ${className}`);
  chip.append(glyph(symbol), document.createTextNode(label));
  chip.title = title;
  return chip;
}
export const taskChip = t => cellChip(`status-${t.status}`, statusGlyph(t.status), t.title, `${statusLabel(t.status)}: ${t.title}${t.destination ? ` → ${t.destination}` : ''}`);

export const sourceBadge = (source, text) => el('span', `task-status src-${source}`, text ?? (SOURCE[source] || source));
export const tag = text => el('span', 'project-tag', text);

export function externalLink(url) {
  const a = el('a', 'cal-link', url);
  a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
  return a;
}
