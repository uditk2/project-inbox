CREATE TABLE mail_accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  mailbox TEXT NOT NULL,
  encrypted_credentials TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
