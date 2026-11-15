-- 0006 (round 4): upgrade batches (§7.6), secret names (§3.2), merged audit counts (D309).

-- One takeover of resources by a newer plugin version; `undone_at` once rolled back.
CREATE TABLE upgrade_batches (
  id           TEXT PRIMARY KEY,
  plugin       TEXT NOT NULL,
  from_version TEXT NOT NULL,
  to_version   TEXT NOT NULL,
  at           INTEGER NOT NULL,
  undone_at    INTEGER
);
CREATE TABLE upgrade_items (
  batch        TEXT NOT NULL,
  resource_id  TEXT NOT NULL,
  old_version  TEXT NOT NULL,
  old_rev      INTEGER NOT NULL,
  new_rev      INTEGER NOT NULL,
  PRIMARY KEY (batch, resource_id)
);

-- Names only; values live in the keychain (rule 7).
CREATE TABLE secret_names (
  name       TEXT PRIMARY KEY,
  updated_at INTEGER NOT NULL
);

-- Repeated calls of one kind within one run share an audit row; the count lives here (the
-- audit table itself stays append-only).
CREATE TABLE audit_counts (
  run_id   TEXT NOT NULL,
  op       TEXT NOT NULL,
  object   TEXT NOT NULL,
  audit_seq INTEGER NOT NULL,
  count    INTEGER NOT NULL,
  first_at INTEGER NOT NULL,
  last_at  INTEGER NOT NULL,
  PRIMARY KEY (run_id, op, object)
);
CREATE INDEX audit_counts_seq ON audit_counts (audit_seq);
