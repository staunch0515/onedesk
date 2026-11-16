-- 0010 (D330): whether a `refs` row ever pointed at a resource. A row that never did (written before
-- its target existed) is connected when a resource gets that name; one whose target was purged is
-- not (D323). Existing rows with a target did point; rows without one cannot be told apart and
-- count as "never".
ALTER TABLE refs ADD COLUMN ever INTEGER NOT NULL DEFAULT 0;
UPDATE refs SET ever = 1 WHERE target_id IS NOT NULL;
CREATE INDEX refs_waiting ON refs (text) WHERE target_id IS NULL AND ever = 0;
