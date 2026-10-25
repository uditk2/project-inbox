CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  external_id TEXT NOT NULL,
  name TEXT NOT NULL,
  cadence_type TEXT NOT NULL CHECK(cadence_type IN ('rrule','cron')),
  cadence TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  starts_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(source,external_id)
);
