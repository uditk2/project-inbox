// The panel under the grid: what was logged on the selected day, each task's history, and what was scheduled. Relies on `el`, `action`, `api`, `notice`, `state` from app.js.
import { cal, fetchTask } from './store.js';
import { KIND, longDate, today, safeLink } from './format.js';
import { statusChip, sourceBadge, tag, externalLink } from './chips.js';
import { dueByDay } from './schedules.js';

const projectName = id => state.accounts.find(a => a.id === id)?.name || id;

function historyLines(events) {
  if (!events.length) return [el('p', 'cal-hint', 'No history was recorded for this task.')];
  return events.map(e => {
    const line = el('div', 'cal-event');
    line.append(el('span', 'cal-event-time', new Date(e.at).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })), statusChip(e.status));
    if (e.note) line.append(el('span', 'cal-event-note', e.note));
    return line;
  });
}

function historyToggle(task) {
  const box = el('div', 'cal-history'); box.hidden = true;
  const button = action('History', async () => {
    if (!box.hidden) { box.hidden = true; return; }
    try { box.replaceChildren(...historyLines((await fetchTask(task.id)).events)); box.hidden = false; }
    catch (error) { notice(error.message); }
  }, 'text-button');
  return [button, box];
}

function taskCard(task) {
  const card = el('article', 'cal-task');
  const top = el('div', 'cal-task-top');
  const tags = el('div', 'cal-task-tags');
  tags.append(tag(KIND[task.kind] || 'Task'));
  if (task.project) tags.append(tag(projectName(task.project)));
  top.append(statusChip(task.status), el('strong', '', task.title), tags);
  card.append(top);
  if (task.destination) card.append(el('p', 'cal-dest', `→ ${task.destination}`));
  const href = safeLink(task.result_url);
  if (href) card.append(externalLink(href));
  if (task.notes) card.append(el('p', 'cal-notes', task.notes));
  card.append(...historyToggle(task));
  return card;
}

// What happened for one scheduled entry on the selected day: the tasks linked to it, or a note that none were logged.
function runLine(schedule, tasks) {
  const ran = tasks.filter(t => t.schedule_source === schedule.source && t.schedule_external_id === schedule.external_id);
  if (ran.length) {
    const line = el('p', 'cal-dest', 'Ran: ');
    ran.forEach(t => line.append(statusChip(t.status), document.createTextNode(` ${t.title}  `)));
    return line;
  }
  if (cal.selected < today()) return el('p', 'cal-dest', 'No run was logged for this day.');
  if (cal.selected === today()) return el('p', 'cal-dest', 'Nothing logged yet today.');
  return null;
}

function scheduledCard({ schedule, entry }, tasks) {
  const card = el('article', 'cal-task cal-task-sched');
  const top = el('div', 'cal-task-top');
  top.append(sourceBadge(schedule.source, `⏱ ${entry.label}`), el('strong', '', schedule.name), sourceBadge(schedule.source));
  card.append(top);
  const line = runLine(schedule, tasks);
  if (line) card.append(line);
  return card;
}

export function renderDetails(root) {
  const panel = el('section', 'cal-details'); panel.setAttribute('aria-live', 'polite');
  root.append(panel);
  if (!cal.selected) { panel.append(el('p', 'cal-hint', 'Choose a day to see what was done.')); return; }
  const tasks = cal.tasks.filter(t => t.task_date === cal.selected);
  const due = dueByDay().get(cal.selected) || [];
  panel.append(el('h3', '', longDate(cal.selected)));
  if (!tasks.length) panel.append(el('p', 'cal-hint', 'Nothing was logged for this day.'));
  tasks.forEach(t => panel.append(taskCard(t)));
  if (due.length) {
    panel.append(el('h4', 'cal-sub', 'Scheduled for this day'), el('p', 'cal-hint', 'Scheduled means it was due to run. Check the logged tasks above for what actually happened.'));
    due.forEach(d => panel.append(scheduledCard(d, tasks)));
  }
}
