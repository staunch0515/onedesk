-- 0005: runs (kernel-design §8, D288). JSON columns hold the protocol shapes as text.
CREATE TABLE runs (
  id            TEXT PRIMARY KEY,
  seq           INTEGER NOT NULL,
  title         TEXT NOT NULL,
  icon          TEXT NOT NULL,
  resource_id   TEXT,
  resource_kind TEXT,
  plugin        TEXT NOT NULL,
  action        TEXT NOT NULL,
  action_label  TEXT NOT NULL,
  tab_id        TEXT,
  env_id        TEXT,
  env_name      TEXT,
  actor         TEXT NOT NULL,
  source        TEXT NOT NULL,
  started_at    INTEGER NOT NULL,
  ended_at      INTEGER,
  status        TEXT NOT NULL,
  params        TEXT NOT NULL DEFAULT '{}',
  input         TEXT NOT NULL DEFAULT '{}',
  progress      TEXT,
  summary       TEXT,
  error         TEXT,
  output        TEXT,
  kept          INTEGER NOT NULL DEFAULT 0,
  kept_name     TEXT,
  in_task_panel INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX runs_seq ON runs (seq);
CREATE INDEX runs_resource ON runs (resource_id, started_at);
CREATE INDEX runs_action ON runs (action, started_at);
CREATE INDEX runs_status ON runs (status);
