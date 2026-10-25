// Calendar tasks: validation, storage and history. A task is one thing that was (or is being) done on a day.
import {oneOf, text, slug, httpUrl, calendarDate, plainObject} from './validate.js';
import {SCHEDULE_SOURCES} from './schedule-model.js';

export const TASK_STATUSES = ['planned','in_progress','drafted','sent','published','backlink_verified','withdrawn','failed'];
export const TASK_KINDS = ['post','outreach','listing','profile','other'];
const COLUMNS = ['task_date','project','kind','title','destination','status','result_url','notes','schedule_source','schedule_external_id','external_ref'];

// `previous` supplies values for fields the caller left out, so partial updates keep the rest of the task.
export function normalizeTask(input, previous = {}) {
  plainObject(input, 'Task');
  const pick = (key, fallback) => input[key] ?? previous[key] ?? fallback;
  const scheduleSource = pick('schedule_source', '');
  const reference = pick('external_ref', null);
  return {
    task_date:calendarDate(input.task_date ?? input.date ?? previous.task_date, 'Task date'),
    project:slug(pick('project', ''), 'Project', 48),
    kind:oneOf(pick('kind', 'other'), TASK_KINDS, 'Kind'),
    title:text(pick('title'), 'Title', 200, true),
    destination:text(pick('destination', ''), 'Destination', 200),
    status:oneOf(pick('status', 'planned'), TASK_STATUSES, 'Status'),
    result_url:httpUrl(pick('result_url', ''), 'Result URL'),
    notes:text(pick('notes', ''), 'Notes', 5000),
    schedule_source:scheduleSource && oneOf(scheduleSource, SCHEDULE_SOURCES, 'Schedule source'),
    schedule_external_id:text(pick('schedule_external_id', ''), 'Schedule ID', 200),
    external_ref:reference === null ? null : text(reference, 'Reference', 200, true)
  };
}

// Finds the task an input refers to (by id, then external_ref) and validates the result without writing.
export async function resolveTask(db, input) {
  let previous = null;
  if (typeof input?.id === 'string') previous = await db.prepare('SELECT * FROM tasks WHERE id=?').bind(input.id).first();
  if (!previous && typeof input?.external_ref === 'string') previous = await db.prepare('SELECT * FROM tasks WHERE external_ref=?').bind(input.external_ref).first();
  return {previous, note:text(input?.note, 'Note', 2000), task:normalizeTask(input, previous || {})};
}

export async function upsertTask(db, input) {
  const now = new Date().toISOString();
  const {previous, note, task} = await resolveTask(db, input);
  const values = COLUMNS.map(column => task[column]);
  let row;
  if (previous) {
    await db.prepare(`UPDATE tasks SET ${COLUMNS.map(c => `${c}=?`).join(',')},updated_at=? WHERE id=?`).bind(...values, now, previous.id).run();
    row = {...previous, ...task, updated_at:now};
  } else {
    row = {id:crypto.randomUUID(), ...task, created_at:now, updated_at:now};
    await db.prepare(`INSERT INTO tasks (id,${COLUMNS},created_at,updated_at) VALUES (?,${COLUMNS.map(() => '?').join(',')},?,?)`).bind(row.id, ...values, now, now).run();
  }
  // History records creation, every status change and every note, so what happened and when survives later edits.
  if (!previous || previous.status !== task.status || note) {
    await db.prepare('INSERT INTO task_events (id,task_id,at,status,note) VALUES (?,?,?,?,?)').bind(crypto.randomUUID(), row.id, now, task.status, note).run();
  }
  return row;
}

// Validates every item before writing any of them, so one bad row saves nothing.
export async function saveTasks(db, items) {
  for (const item of items) await resolveTask(db, item);
  const saved = [];
  for (const item of items) saved.push(await upsertTask(db, item));
  return saved;
}

export const taskHistory = async (db, id) => (await db.prepare('SELECT at,status,note FROM task_events WHERE task_id=? ORDER BY at,rowid').bind(id).all()).results;
