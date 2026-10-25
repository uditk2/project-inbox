// The month grid: one cell per day with its task chips and a single summary line for scheduled tasks. Relies on `el` from app.js.
import { cal, selectDay } from './store.js';
import { DAY_NAMES, addDays, groupBy, monthGrid, plural, ymd, today } from './format.js';
import { cellChip, taskChip } from './chips.js';
import { dueByDay } from './schedules.js';

function scheduledChip(due) {
  const one = due.length === 1 ? due[0].schedule : null;
  const title = `Scheduled: ${due.map(d => `${d.schedule.name} (${d.entry.label})`).join('; ')}`;
  return cellChip(`cal-sched${one ? ` src-${one.source}` : ''}`, '⏱', one ? one.name : `${due.length} scheduled`, title);
}

function dayCell(day, tasks, due) {
  const key = ymd(day);
  const classes = ['cal-day', day.getMonth() !== cal.month.getMonth() && 'other-month', key === today() && 'is-today', key === cal.selected && 'selected'];
  const cell = el('button', classes.filter(Boolean).join(' '));
  cell.type = 'button'; cell.setAttribute('role', 'gridcell');
  cell.setAttribute('aria-label', `${day.toLocaleDateString(undefined, { day: 'numeric', month: 'long' })}, ${plural(tasks.length, 'task')}${due.length ? `, ${due.length} scheduled` : ''}`);
  cell.append(el('span', 'cal-num', String(day.getDate())));
  const room = due.length ? 2 : 3;                         // keep one line free for the scheduled summary
  tasks.slice(0, room).forEach(t => cell.append(taskChip(t)));
  if (tasks.length > room) cell.append(el('span', 'cal-more', `+${tasks.length - room} more`));
  if (due.length) cell.append(scheduledChip(due));
  cell.onclick = () => { selectDay(key); document.querySelector('.cal-details')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); };
  return cell;
}

export function renderGrid(root) {
  const { start, weeks } = monthGrid(cal.month);
  const grid = el('div', 'cal-grid'); grid.setAttribute('role', 'grid');
  DAY_NAMES.forEach(name => { const head = el('div', 'cal-dow', name); head.setAttribute('role', 'columnheader'); grid.append(head); });
  const due = dueByDay();
  const tasksByDay = groupBy(cal.tasks, t => t.task_date);
  for (let i = 0; i < weeks * 7; i++) {
    const day = addDays(start, i), key = ymd(day);
    grid.append(dayCell(day, tasksByDay.get(key) || [], due.get(key) || []));
  }
  root.append(grid);
}
