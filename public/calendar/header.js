// Month navigation, project filter, schedule toggle, CSV import button and the monthly summary. Relies on `el`, `action`, `state` from app.js.
import { cal, shiftMonth, goToMonth, setProject, prefs, showSchedules, redraw } from './store.js';
import { STATUS, plural, today, pad, groupBy } from './format.js';
import { statusChip } from './chips.js';

const iconButton = (symbol, label, onClick) => { const b = action(symbol, onClick, 'icon-button'); b.setAttribute('aria-label', label); return b; };

function projectSelect() {
  const select = el('select'); select.id = 'cal-project';
  for (const [value, label] of [['', 'All projects'], ...state.accounts.map(a => [a.id, a.name])]) { const o = el('option', '', label); o.value = value; select.append(o); }
  select.value = cal.project;
  select.onchange = () => setProject(select.value);
  return select;
}

function scheduleToggle() {
  const label = el('label', 'cal-toggle'), box = el('input');
  box.type = 'checkbox'; box.checked = showSchedules();
  box.onchange = () => { prefs.set('pi-show-schedules', box.checked ? '1' : '0'); redraw(); };
  label.append(box, document.createTextNode(' Show schedules'));
  return label;
}

function importButton(onFile) {
  const file = el('input'); file.type = 'file'; file.accept = '.csv,text/csv'; file.hidden = true; file.id = 'cal-import-file';
  file.onchange = () => { if (file.files[0]) onFile(file.files[0]); file.value = ''; };
  const button = action('Import post-log.csv', () => file.click(), 'secondary');
  button.title = 'Backfill the calendar from a post-log.csv (date, game, destination, status, result_url, account, notes)';
  return [button, file];
}

export function renderHeader(root, { onImportFile }) {
  const nav = el('div', 'cal-nav');
  nav.append(iconButton('‹', 'Previous month', () => shiftMonth(-1)), el('h2', 'cal-title', cal.month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })),
    iconButton('›', 'Next month', () => shiftMonth(1)), action('Today', () => goToMonth(new Date(), today()), 'secondary'));
  const tools = el('div', 'cal-tools');
  const label = el('label', 'sr-only', 'Project'); label.setAttribute('for', 'cal-project');
  tools.append(label, projectSelect(), scheduleToggle(), ...importButton(onImportFile));
  const head = el('div', 'cal-head'); head.append(nav, tools); root.append(head);
}

export function renderSummary(root) {
  const prefix = `${cal.month.getFullYear()}-${pad(cal.month.getMonth() + 1)}`;
  const month = cal.tasks.filter(t => t.task_date.startsWith(prefix));
  const counts = groupBy(month, t => t.status);
  const strip = el('div', 'cal-summary');
  strip.append(el('strong', '', `${plural(month.length, 'task')} this month`));
  Object.keys(STATUS).filter(s => counts.has(s)).forEach(s => strip.append(statusChip(s, ` · ${counts.get(s).length}`)));
  root.append(strip);
  if (cal.loaded && !cal.tasks.length) {
    root.append(el('p', 'cal-hint cal-empty', `No tasks logged ${cal.project ? 'for this project ' : ''}in this month. Use Import post-log.csv to backfill, or have your agent record tasks with log_task.`));
  }
}
