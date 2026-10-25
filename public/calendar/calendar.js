// Task calendar entry point: shows which tasks were done each day and which scheduled tasks were due, backed by /api/tasks and /api/schedules.
// Loaded as a module after app.js, whose helpers ($, el, action, api, notice, state) it uses.
import { cal, subscribe, load, openCalendar, closeCalendar, goToMonth, saveTasks } from './store.js';
import { parseDay, plural } from './format.js';
import { postLogToTasks } from './csv.js';
import { renderHeader, renderSummary } from './header.js';
import { renderSchedulePrompt, renderScheduleList } from './schedules.js';
import { renderGrid } from './grid.js';
import { renderDetails } from './details.js';

function render() {
  const root = $('calendar-view'); root.replaceChildren();
  renderHeader(root, { onImportFile: importPostLog });
  renderSummary(root); renderSchedulePrompt(root); renderGrid(root); renderDetails(root); renderScheduleList(root);
}

async function importPostLog(file) {
  const project = cal.project || (state.accounts.length === 1 ? state.accounts[0].id : '');
  if (!project) { notice('Choose the project in the calendar’s project menu first, so imported tasks are filed under it.'); return; }
  try {
    const { tasks, skipped } = postLogToTasks(await file.text(), project);
    await saveTasks(tasks);
    const latest = tasks.map(t => t.task_date).sort().pop();
    await goToMonth(parseDay(latest), latest);
    notice(`Imported ${plural(tasks.length, 'task')}${skipped.length ? `; skipped ${plural(skipped.length, 'unreadable row')}` : ''}. Importing the same file again updates these entries instead of duplicating them.`);
  } catch (error) { notice(error.message); }
}

const workspace = () => document.querySelector('.mail-workspace');
function show() {
  if (!state.ready) return;
  openCalendar();
  document.querySelectorAll('[data-folder],#calendar-nav').forEach(n => n.classList.toggle('active', n.id === 'calendar-nav'));
  $('accounts').querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  $('folder-title').textContent = 'Task calendar';
  workspace().hidden = true; $('calendar-view').hidden = false;
  render(); load();
}
function hide() {
  if (!cal.open) return;
  closeCalendar(); $('calendar-view').hidden = true; workspace().hidden = false; $('calendar-nav').classList.remove('active');
}

subscribe(render);
$('calendar-nav').onclick = show;
document.querySelectorAll('[data-folder]').forEach(b => b.addEventListener('click', hide));
$('accounts').addEventListener('click', hide);
$('refresh').addEventListener('click', () => { if (cal.open) load(); });
