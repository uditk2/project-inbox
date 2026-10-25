// Scheduled tasks on the calendar: which are due on which day, the opt-in import prompt, and the list of everything known.
// Relies on `el`, `action`, `notice` from app.js.
import { cal, load, redraw, prefs, showSchedules, scanCodex } from './store.js';
import { monthGrid, plural } from './format.js';
import { sourceBadge, tag } from './chips.js';
import { project, describe } from './recurrence.js';

const PROMPT_FOR_CLAUDE = 'List my scheduled tasks and save them to Project Inbox with the sync_schedules tool (source "claude", cron expressions in cadence_type "cron").';

// Map of 'YYYY-MM-DD' to [{schedule, entry}] for the visible weeks. "Due" means scheduled, not that the run happened.
export function dueByDay() {
  const byDay = new Map();
  if (!showSchedules()) return byDay;
  const { start, end } = monthGrid(cal.month);
  for (const schedule of cal.schedules.filter(s => s.enabled)) {
    project(schedule, start, end)?.forEach((entry, day) => {
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push({ schedule, entry });
    });
  }
  return byDay;
}

async function importFromCodex(button) {
  button.disabled = true;
  try {
    const r = await scanCodex();
    await load();                                          // reloading clears the notice, so show ours afterwards
    notice(!r.found ? 'No Codex automations folder was found on this computer (looked in ~/.codex/automations).'
      : !r.imported ? 'Found the Codex folder but no scheduled automations in it.'
      : `Imported ${plural(r.imported, 'Codex automation')}. Only names, schedules and on/off state were read.`);
  } catch (error) { notice(error.message); } finally { button.disabled = false; }
}

async function copyClaudePrompt() {
  try { await navigator.clipboard.writeText(PROMPT_FOR_CLAUDE); notice('Copied. Paste it into Claude with the Project Inbox MCP connected. Claude’s own scheduled tasks are stored by Claude, so it has to list them for you.'); }
  catch { notice(`Paste this into Claude with the Project Inbox MCP connected: ${PROMPT_FOR_CLAUDE}`); }
}

export function renderSchedulePrompt(root) {
  if (!cal.loaded || cal.schedules.length || prefs.get('pi-schedules-dismissed') === '1') return;
  const box = el('section', 'cal-onboard');
  box.append(el('strong', '', 'Show your scheduled tasks here?'), el('p', '', 'Add Codex automations and Claude scheduled tasks to the calendar, so you can see what is due each day next to what was done. Nothing is read until you choose. Only each task’s name, schedule and on/off state are imported, never its instructions.'));
  const actions = el('div', 'cal-onboard-actions');
  const codex = action('Import from Codex', () => importFromCodex(codex), 'primary');
  actions.append(codex, action('Claude: copy a prompt', copyClaudePrompt, 'secondary'), action('Not now', () => { prefs.set('pi-schedules-dismissed', '1'); redraw(); }, 'text-button'));
  box.append(actions); root.append(box);
}

export function renderScheduleList(root) {
  if (!cal.schedules.length) return;
  const wrap = el('details', 'cal-sched-list');
  wrap.append(el('summary', '', `Scheduled tasks (${cal.schedules.length})`));
  const now = new Date();
  for (const s of cal.schedules) {
    const row = el('div', 'cal-sched-row' + (s.enabled ? '' : ' paused'));
    row.append(sourceBadge(s.source), el('strong', '', s.name), el('span', 'cal-sched-when', describe(s)));
    if (!s.enabled) row.append(tag('Paused'));
    if (project(s, now, now) === null) row.append(tag('Not shown on days'));
    wrap.append(row);
  }
  root.append(wrap);
}
