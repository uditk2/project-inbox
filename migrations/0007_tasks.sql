CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  task_date TEXT NOT NULL,
  project TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'other',
  title TEXT NOT NULL,
  destination TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'planned',
  result_url TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  external_ref TEXT UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_date ON tasks(task_date,project);
