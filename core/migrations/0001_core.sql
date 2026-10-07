-- wOS core tables. Portable SQL: ids, times and JSON are TEXT; flags are INTEGER 0/1.

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT,
  github_login TEXT,
  github_id TEXT,
  avatar_url TEXT,
  created_at TEXT NOT NULL,
  last_seen_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email ON users (email);
CREATE UNIQUE INDEX IF NOT EXISTS users_github ON users (github_login);

-- Sign-in sessions for the browser and for apps connected over MCP. Only a hash of each token is kept.
-- A refresh token used twice revokes its whole family.
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  team_id TEXT,
  family TEXT NOT NULL,
  kind TEXT NOT NULL,
  client_name TEXT,
  scopes TEXT NOT NULL DEFAULT '["read","write","delete","admin"]',
  token_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  revoked_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS sessions_token ON sessions (token_hash);

CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  github_org TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  plan TEXT,
  archived_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS teams_slug ON teams (slug);

CREATE TABLE IF NOT EXISTS members (
  team_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,
  invited_by TEXT,
  joined_at TEXT NOT NULL,
  PRIMARY KEY (team_id, user_id)
);

CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  email TEXT,
  github_login TEXT,
  role TEXT NOT NULL,
  invited_by TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  accepted_at TEXT,
  accepted_by TEXT,
  revoked_at TEXT
);

-- Which apps each team has on. No row means off (core apps are always on).
CREATE TABLE IF NOT EXISTS team_apps (
  team_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  changed_at TEXT NOT NULL,
  changed_by TEXT,
  PRIMARY KEY (team_id, app_id)
);

CREATE TABLE IF NOT EXISTS settings (
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scope, key)
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  name TEXT NOT NULL,
  data TEXT,
  actor_kind TEXT,
  actor_id TEXT,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_team ON events (team_id, at);

-- Every tool call, from any caller.
CREATE TABLE IF NOT EXISTS audit (
  id TEXT PRIMARY KEY,
  team_id TEXT,
  actor_kind TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_name TEXT,
  person_id TEXT,
  tool TEXT NOT NULL,
  via TEXT NOT NULL,
  input TEXT,
  status TEXT NOT NULL,
  error TEXT,
  ms INTEGER,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_team ON audit (team_id, at);

-- The one inbox: questions, approvals and notices for a person.
CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  options TEXT,
  ref TEXT,
  source TEXT,
  status TEXT NOT NULL,
  answer TEXT,
  answered_via TEXT,
  answered_at TEXT,
  created_at TEXT NOT NULL,
  pushed_at TEXT,
  emailed_at TEXT
);
CREATE INDEX IF NOT EXISTS alerts_person ON alerts (team_id, person_id, status, created_at);

CREATE TABLE IF NOT EXISTS alert_rules (
  team_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  rules TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (team_id, person_id)
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  keys TEXT NOT NULL,
  device TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS push_endpoint ON push_subscriptions (endpoint);

-- Tool calls by agents that wait for a person's yes.
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  alert_id TEXT,
  tool TEXT NOT NULL,
  input TEXT,
  actor TEXT NOT NULL,
  status TEXT NOT NULL,
  result TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT
);

-- Mail the server sent (sign-in links, alerts, digests), so a self-hoster can see what went out.
CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY,
  team_id TEXT,
  to_addr TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL
);

-- Model providers. secret holds the key sealed with the server key, which never sits in the database.
CREATE TABLE IF NOT EXISTS model_providers (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  user_id TEXT,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  base_url TEXT,
  secret TEXT,
  models TEXT,
  default_model TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  provider_id TEXT,
  model TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
);
CREATE INDEX IF NOT EXISTS conversations_user ON conversations (team_id, user_id, updated_at);

CREATE TABLE IF NOT EXISTS conversation_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS conversation_messages_conv ON conversation_messages (conversation_id, created_at);
