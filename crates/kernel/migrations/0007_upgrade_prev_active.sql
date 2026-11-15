-- 0007 (D314): the active version before a takeover, so undoing it goes back to exactly that.
ALTER TABLE upgrade_batches ADD COLUMN prev_active TEXT;
