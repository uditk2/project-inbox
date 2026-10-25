ALTER TABLE tasks ADD COLUMN schedule_source TEXT NOT NULL DEFAULT '';
ALTER TABLE tasks ADD COLUMN schedule_external_id TEXT NOT NULL DEFAULT '';
CREATE TABLE IF NOT EXISTS task_events (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  at TEXT NOT NULL,
  status TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS task_events_task ON task_events(task_id,at);
