// Scheduled tasks (Codex automations, Claude scheduled tasks, ...): validation and storage. Only name, cadence and on/off state are kept.
import {HttpError} from './core.js';
import {text, oneOf, plainObject} from './validate.js';

export const SCHEDULE_SOURCES = ['codex','claude','other'];
const CADENCE_PATTERN = {
  rrule:/^(RRULE:)?[A-Za-z0-9=;,:+\-]+$/,
  cron:/^(CRON_TZ=[A-Za-z0-9_\/+\-]+ )?[0-9*\/,\-A-Za-z?#LW ]+$/
};

export const presentSchedule = row => ({...row, enabled:!!row.enabled});

export function normalizeSchedule(input) {
  plainObject(input, 'Schedule');
  const type = oneOf(input.cadence_type, Object.keys(CADENCE_PATTERN), 'Cadence type');
  const cadence = text(input.cadence, 'Cadence', 200, true);
  if (!CADENCE_PATTERN[type].test(cadence)) throw new HttpError(400, type === 'cron' ? 'Invalid cron expression' : 'Invalid recurrence rule');
  let startsAt = null;
  if (input.starts_at !== undefined && input.starts_at !== null) {
    startsAt = new Date(input.starts_at);
    if (Number.isNaN(startsAt.getTime())) throw new HttpError(400, 'Start time must be a valid date');
    startsAt = startsAt.toISOString();
  }
  return {
    source:oneOf(input.source, SCHEDULE_SOURCES, 'Source'), external_id:text(input.external_id, 'External ID', 200, true), name:text(input.name, 'Name', 200, true),
    cadence_type:type, cadence, enabled:input.enabled === false ? 0 : 1, starts_at:startsAt
  };
}

export async function upsertSchedule(db, schedule) {
  await db.prepare('INSERT INTO schedules (id,source,external_id,name,cadence_type,cadence,enabled,starts_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(source,external_id) DO UPDATE SET name=excluded.name,cadence_type=excluded.cadence_type,cadence=excluded.cadence,enabled=excluded.enabled,starts_at=COALESCE(excluded.starts_at,schedules.starts_at),updated_at=excluded.updated_at')
    .bind(crypto.randomUUID(), schedule.source, schedule.external_id, schedule.name, schedule.cadence_type, schedule.cadence, schedule.enabled, schedule.starts_at, new Date().toISOString()).run();
}

// Validates every item first so a bad row writes nothing.
export async function saveSchedules(db, items) {
  const normalized = items.map(normalizeSchedule);
  for (const schedule of normalized) await upsertSchedule(db, schedule);
  return normalized.length;
}

// Applies a partial change (pause, rename, new cadence) to an existing row.
export async function changeSchedule(db, row, changes) {
  const merged = normalizeSchedule({...row, enabled:!!row.enabled, ...plainObject(changes, 'Changes'), source:row.source, external_id:row.external_id});
  await db.prepare('UPDATE schedules SET name=?,cadence_type=?,cadence=?,enabled=?,starts_at=COALESCE(?,starts_at),updated_at=? WHERE id=?')
    .bind(merged.name, merged.cadence_type, merged.cadence, merged.enabled, merged.starts_at, new Date().toISOString(), row.id).run();
  return presentSchedule(await db.prepare('SELECT * FROM schedules WHERE id=?').bind(row.id).first());
}
