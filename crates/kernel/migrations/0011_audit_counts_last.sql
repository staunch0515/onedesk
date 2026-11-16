-- Round 6 review #9: a merged audit row also keeps the last call's summary (e.g. the exit code of
-- the last run of a program) and how many of the merged calls failed (non-zero exit, signal…).
ALTER TABLE audit_counts ADD COLUMN last_summary TEXT;
ALTER TABLE audit_counts ADD COLUMN failures INTEGER NOT NULL DEFAULT 0;
