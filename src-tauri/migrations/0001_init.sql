-- 0001_init: initial schema for milestone 1. Published migrations are never edited (D21).
-- schema_version is created and maintained by the migration runner, not here.

CREATE TABLE resources (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  name        TEXT NOT NULL,
  group_name  TEXT NOT NULL DEFAULT '',
  tags        TEXT NOT NULL DEFAULT '[]',          -- JSON array of strings (D25)
  description TEXT NOT NULL DEFAULT '',
  body        TEXT NOT NULL DEFAULT '{}',          -- JSON object, shape defined by the kind
  visibility  TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'public')),
  ai_visible  INTEGER NOT NULL DEFAULT 0 CHECK (ai_visible IN (0, 1)),
  version     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,                       -- ISO 8601 UTC
  updated_at  TEXT NOT NULL,
  origin      TEXT NOT NULL DEFAULT 'original' CHECK (origin IN ('original', 'subscribed', 'copied')),
  search_text TEXT NOT NULL DEFAULT ''             -- lowercased name/description/tags/body strings (D24)
);
CREATE INDEX idx_resources_kind ON resources (kind);
CREATE INDEX idx_resources_group ON resources (group_name);

CREATE TABLE collections (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  rule_type  TEXT NOT NULL CHECK (rule_type IN ('tag', 'kind')),
  rule_value TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE plugins (
  id           TEXT PRIMARY KEY,
  enabled      INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  settings     TEXT NOT NULL DEFAULT '{}',
  installed_at TEXT NOT NULL
);

CREATE TABLE plugin_storage (
  plugin_id TEXT NOT NULL,
  key       TEXT NOT NULL,
  value     TEXT NOT NULL,
  PRIMARY KEY (plugin_id, key)
);

CREATE TABLE app_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
