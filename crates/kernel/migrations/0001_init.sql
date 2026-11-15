-- 0001: workspace database, kernel-design §3.2. Published migrations are never edited (rule 6).

CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE resources (
  id             TEXT PRIMARY KEY,
  kind           TEXT NOT NULL,
  plugin_version TEXT,
  tree           TEXT,
  parent_id      TEXT,
  pos            INTEGER NOT NULL DEFAULT 0,
  name           TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  tags           TEXT NOT NULL DEFAULT '[]',
  body           TEXT NOT NULL DEFAULT '{}',
  visibility     TEXT NOT NULL DEFAULT 'normal',
  ai_visible     INTEGER NOT NULL DEFAULT 1,
  origin         TEXT NOT NULL DEFAULT 'original',
  origin_ref     TEXT,
  external_key   TEXT,
  state          TEXT NOT NULL DEFAULT 'ok',
  rev            INTEGER NOT NULL,
  created_at     INTEGER NOT NULL,
  created_by     TEXT NOT NULL,
  updated_at     INTEGER NOT NULL,
  updated_by     TEXT NOT NULL,
  deleted_at     INTEGER,
  delete_batch   TEXT
);
CREATE INDEX resources_tree_parent ON resources (tree, parent_id, pos);
CREATE INDEX resources_kind ON resources (kind);
CREATE UNIQUE INDEX resources_external_key ON resources (kind, external_key) WHERE external_key IS NOT NULL;

-- One row per change: the whole record after the change, and which fields changed.
CREATE TABLE revisions (
  resource_id TEXT NOT NULL,
  rev         INTEGER NOT NULL,
  at          INTEGER NOT NULL,
  actor       TEXT NOT NULL,
  op          TEXT NOT NULL,
  fields      TEXT NOT NULL,
  snapshot    TEXT NOT NULL,
  commit_ref  TEXT,
  PRIMARY KEY (resource_id, rev)
);

-- Append only (§4.3).
CREATE TABLE audit (
  seq     INTEGER PRIMARY KEY AUTOINCREMENT,
  at      INTEGER NOT NULL,
  actor   TEXT NOT NULL,
  op      TEXT NOT NULL,
  object  TEXT NOT NULL,
  summary TEXT NOT NULL,
  result  TEXT NOT NULL
);
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit
BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit
BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;

CREATE TABLE resource_meta (
  resource_id  TEXT PRIMARY KEY,
  favorite     INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER,
  use_count    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE plugin_storage (
  plugin  TEXT NOT NULL,
  version TEXT NOT NULL,
  key     TEXT NOT NULL,
  value   TEXT NOT NULL,
  PRIMARY KEY (plugin, version, key)
);

CREATE TABLE ui_state (
  client TEXT NOT NULL,
  key    TEXT NOT NULL,
  value  TEXT NOT NULL,
  PRIMARY KEY (client, key)
);

CREATE TABLE outbox (
  seq     INTEGER PRIMARY KEY AUTOINCREMENT,
  at      INTEGER NOT NULL,
  kind    TEXT NOT NULL,
  payload TEXT NOT NULL
);
