CREATE TABLE IF NOT EXISTS drafts (
  id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  sent_id TEXT
);
