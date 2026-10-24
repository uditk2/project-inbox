ALTER TABLE messages ADD COLUMN body_loaded INTEGER NOT NULL DEFAULT 1;
CREATE TABLE sync_state (
  account_id TEXT PRIMARY KEY,
  last_complete_id TEXT,
  next_cursor TEXT,
  cycle_head TEXT,
  last_synced_at TEXT
);
