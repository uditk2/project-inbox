// HTTP routes for scheduled tasks.
import {HttpError, json, denyDemo} from './core.js';
import {batchItems} from './validate.js';
import {presentSchedule, saveSchedules, changeSchedule} from './schedule-model.js';

const MAX_BATCH = 100;

async function scan(request, env, user) {
  denyDemo(user, 'read local schedules');
  const sources = (await request.json())?.sources;
  if (!Array.isArray(sources) || !sources.length || sources.some(s => s !== 'codex')) throw new HttpError(400, 'Choose a supported source: codex');
  const {scanCodex} = await import('./scan.js');   // Node-only code, loaded only when the user asks for an import
  const result = await scanCodex(env.CODEX_HOME || undefined);
  const found = result.schedules.slice(0, MAX_BATCH);
  if (found.length) await saveSchedules(env.DB, found);
  return json({source:'codex', found:result.found, imported:found.length});
}

export async function schedules(request, env, user) {
  const path = new URL(request.url).pathname, method = request.method;
  if (path === '/api/schedules/scan' && method === 'POST') return scan(request, env, user);
  if (path === '/api/schedules') {
    if (method === 'GET') return json({schedules:(await env.DB.prepare('SELECT * FROM schedules ORDER BY source,name').all()).results.map(presentSchedule)});
    if (method === 'POST') {
      denyDemo(user, 'save schedules');
      return json({saved:await saveSchedules(env.DB, batchItems(await request.json(), 'schedules', MAX_BATCH, 'schedules'))}, 201);
    }
    throw new HttpError(405, 'Method not allowed');
  }
  const match = path.match(/^\/api\/schedules\/([^/]+)$/);
  if (!match) throw new HttpError(404, 'Not found');
  const row = await env.DB.prepare('SELECT * FROM schedules WHERE id=?').bind(decodeURIComponent(match[1])).first();
  if (!row) throw new HttpError(404, 'Schedule not found');
  if (method === 'GET') return json({schedule:presentSchedule(row)});
  denyDemo(user, 'change schedules');
  if (method === 'PATCH') return json({schedule:await changeSchedule(env.DB, row, await request.json())});
  if (method === 'DELETE') { await env.DB.prepare('DELETE FROM schedules WHERE id=?').bind(row.id).run(); return json({deleted:true}); }
  throw new HttpError(405, 'Method not allowed');
}
