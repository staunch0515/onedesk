-- 0002: search text (D277) and restore links in history (D278).

-- One row per live, visible resource. `text` = description, tags, string values of body and params.
-- Filled by the write pipeline in the same transaction as the data; rebuilt by the kernel when
-- meta `search_built` is missing (e.g. right after this migration on an existing database).
CREATE VIRTUAL TABLE search USING fts5(id UNINDEXED, name, text, tokenize = 'trigram');

-- A `restore` revision points at the history entry (`<rev>:<field>`) it restored.
ALTER TABLE revisions ADD COLUMN restored_from TEXT;
