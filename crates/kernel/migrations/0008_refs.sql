-- 0008 (round 5, D321–D323): references between resources (kernel-design §10).
-- One row per reference found in a declared field: `[[text]]` in a text field (`seq` = order of
-- appearance) or a single `{ "ref": id }` field (`seq` = 0). `target_id` is NULL when the name did
-- not resolve or the target was purged ("missing"); a deleted target keeps its id ("deleted").
CREATE TABLE refs (
  source_id TEXT NOT NULL,
  field     TEXT NOT NULL,
  seq       INTEGER NOT NULL,
  text      TEXT NOT NULL,
  target_id TEXT,
  PRIMARY KEY (source_id, field, seq)
);
CREATE INDEX refs_target ON refs (target_id);
-- The kernel fills the table from every resource on the next start (`refs_built`).
DELETE FROM meta WHERE key = 'refs_built';
