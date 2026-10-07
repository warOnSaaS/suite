-- The Agents app: saved agents, their runs, plans (as checklists with evidence), live events and panel layouts.

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  provider_id TEXT,
  model TEXT,
  tools TEXT NOT NULL,
  scopes TEXT NOT NULL,
  budget TEXT NOT NULL,
  runtime TEXT NOT NULL DEFAULT 'server',
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
);

CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  goal TEXT NOT NULL,
  task_ref TEXT,
  status TEXT NOT NULL,
  status_note TEXT,
  started_by TEXT,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ended_at TEXT,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  turns INTEGER NOT NULL DEFAULT 0,
  plan_version INTEGER NOT NULL DEFAULT 0,
  plan_note TEXT,
  transcript TEXT NOT NULL,
  waiting_on TEXT,
  lease_until TEXT
);
CREATE INDEX IF NOT EXISTS agent_runs_team ON agent_runs (team_id, status, updated_at);

CREATE TABLE IF NOT EXISTS agent_steps (
  run_id TEXT NOT NULL,
  n INTEGER NOT NULL,
  text TEXT NOT NULL,
  done_at TEXT,
  evidence TEXT,
  PRIMARY KEY (run_id, n)
);

CREATE TABLE IF NOT EXISTS agent_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_events_run ON agent_events (run_id, at);

CREATE TABLE IF NOT EXISTS agent_layouts (
  team_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  layout TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (team_id, user_id)
);
