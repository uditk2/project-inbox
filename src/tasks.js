// HTTP routes for calendar tasks.
import {HttpError, json, denyDemo} from './core.js';
import {batchItems, calendarDate, plainObject} from './validate.js';
import {TASK_STATUSES, saveTasks, upsertTask, taskHistory} from './task-model.js';

const MAX_BATCH = 200, LIST_LIMIT = 1000;

async function list(url, db) {
  const filters = [['from', 'task_date>=?', calendarDate], ['to', 'task_date<=?', calendarDate], ['project', 'project=?', v => v.slice(0, 48)]];
  const conditions = [], bindings = [];
  for (const [param, clause, clean] of filters) {
    const value = url.searchParams.get(param);
    if (value) { conditions.push(clause); bindings.push(clean(value, `${param} date`)); }
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const result = await db.prepare(`SELECT * FROM tasks ${where} ORDER BY task_date DESC,created_at DESC LIMIT ${LIST_LIMIT}`).bind(...bindings).all();
  return json({tasks:result.results, statuses:TASK_STATUSES});
}

export async function tasks(request, env, user) {
  const url = new URL(request.url), method = request.method;
  if (url.pathname === '/api/tasks') {
    if (method === 'GET') return list(url, env.DB);
    if (method === 'POST') {
      denyDemo(user, 'save tasks');
      return json({tasks:await saveTasks(env.DB, batchItems(await request.json(), 'tasks', MAX_BATCH, 'tasks'))}, 201);
    }
    throw new HttpError(405, 'Method not allowed');
  }
  const match = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
  if (!match) throw new HttpError(404, 'Not found');
  const id = decodeURIComponent(match[1]);
  const task = await env.DB.prepare('SELECT * FROM tasks WHERE id=?').bind(id).first();
  if (!task) throw new HttpError(404, 'Task not found');
  if (method === 'GET') return json({task, events:await taskHistory(env.DB, id)});
  if (method === 'PATCH') {
    denyDemo(user, 'save tasks');
    return json({task:await upsertTask(env.DB, {...plainObject(await request.json(), 'Changes'), id})});
  }
  throw new HttpError(405, 'Method not allowed');
}
