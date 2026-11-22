-- 0013 (round 18, D442): what a plugin keeps beside a run (a saved analysis…). Removed with the
-- run, however the run goes (deleted, purged, past the retention of 200).
CREATE TABLE IF NOT EXISTS run_artifacts (
  id         TEXT PRIMARY KEY,
  run_id     TEXT NOT NULL,
  plugin     TEXT NOT NULL,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL,
  data       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS run_artifacts_run ON run_artifacts (run_id, plugin);
CREATE TRIGGER IF NOT EXISTS run_artifacts_with_run AFTER DELETE ON runs
BEGIN
  DELETE FROM run_artifacts WHERE run_id = old.id;
END;
