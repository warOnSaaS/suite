-- Portable SQL: runs on Postgres and SQLite. Ids, times and JSON are TEXT; flags are INTEGER 0/1.
CREATE TABLE IF NOT EXISTS chat_channels (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'public',
  created_by TEXT,
  created_at TEXT NOT NULL,
  archived_at TEXT
);
CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  thread_id TEXT,
  author_kind TEXT NOT NULL,
  author_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  edited_at TEXT,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS chat_messages_channel ON chat_messages (team_id, channel_id, created_at);
