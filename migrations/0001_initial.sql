CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('inbound','outbound')),
  sender TEXT NOT NULL,
  recipients TEXT NOT NULL,
  subject TEXT NOT NULL,
  body_text TEXT NOT NULL DEFAULT '',
  body_html TEXT NOT NULL DEFAULT '',
  headers TEXT NOT NULL DEFAULT '{}',
  attachments TEXT NOT NULL DEFAULT '[]',
  message_id TEXT,
  in_reply_to TEXT,
  received_at TEXT NOT NULL,
  is_read INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'received',
  UNIQUE(account_id,provider_id,direction)
);
CREATE INDEX IF NOT EXISTS messages_account_date ON messages(account_id,received_at DESC);
CREATE INDEX IF NOT EXISTS messages_folder_date ON messages(direction,archived,received_at DESC);
CREATE TABLE IF NOT EXISTS webhook_events (
  account_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  processed_at TEXT NOT NULL,
  PRIMARY KEY(account_id,event_id)
);
CREATE TABLE IF NOT EXISTS outbox (
  request_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  sent_id TEXT,
  provider_id TEXT
);
