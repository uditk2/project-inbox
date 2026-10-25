// Calendar state and everything that talks to the local API. Views read `cal` and call these functions;
// any change calls the subscribers so the screen redraws. Relies on `api` and `notice` from app.js.
import { monthGrid, startOfMonth, ymd, today } from './format.js';

export const cal = { open: false, month: null, project: '', tasks: [], schedules: [], selected: null, loaded: false };

const listeners = new Set();
export const subscribe = fn => { listeners.add(fn); };
const emit = () => listeners.forEach(fn => fn());

export const prefs = {
  get: key => { try { return localStorage.getItem(key); } catch { return null; } },
  set: (key, value) => { try { localStorage.setItem(key, value); } catch { /* storage unavailable: the choice just won't persist */ } }
};
export const showSchedules = () => prefs.get('pi-show-schedules') !== '0';

export function openCalendar() {
  cal.open = true;
  if (!cal.month) { cal.month = startOfMonth(new Date()); cal.selected = today(); }
}
export const closeCalendar = () => { cal.open = false; };

export async function load() {
  const { start, end } = monthGrid(cal.month);
  const params = new URLSearchParams({ from: ymd(start), to: ymd(end) });
  if (cal.project) params.set('project', cal.project);
  try {
    const [data, sched] = await Promise.all([api(`/api/tasks?${params}`), api('/api/schedules')]);
    Object.assign(cal, { tasks: data.tasks || [], schedules: sched.schedules || [], loaded: true });
    notice('');
  } catch (error) { cal.tasks = []; notice(error.message); }
  emit();
}

export function goToMonth(date, selected = null) { cal.month = startOfMonth(date); cal.selected = selected; return load(); }
export const shiftMonth = n => goToMonth(new Date(cal.month.getFullYear(), cal.month.getMonth() + n, 1));
export function setProject(id) { cal.project = id; cal.selected = null; return load(); }
export function selectDay(day) { cal.selected = day; emit(); }
export const redraw = emit;

export async function saveTasks(tasks) {
  for (let i = 0; i < tasks.length; i += 100) await api('/api/tasks', { method: 'POST', body: JSON.stringify({ tasks: tasks.slice(i, i + 100) }) });
}
export const fetchTask = id => api(`/api/tasks/${encodeURIComponent(id)}`);
export const scanCodex = () => api('/api/schedules/scan', { method: 'POST', body: JSON.stringify({ sources: ['codex'] }) });
