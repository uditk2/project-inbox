ALTER TABLE messages ADD COLUMN trashed INTEGER NOT NULL DEFAULT 0;
CREATE INDEX messages_trash_date ON messages(trashed,received_at DESC);
CREATE TABLE deleted_messages (
  account_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  direction TEXT NOT NULL,
  deleted_at TEXT NOT NULL,
  PRIMARY KEY(account_id,provider_id,direction)
);
CREATE TABLE feedback (
  id TEXT PRIMARY KEY,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL
);
