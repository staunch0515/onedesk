-- 0003: the search table keyed by the resource's rowid instead of an unindexed `id` column
-- (review #7: every write scanned the whole table). 0002 is published and stays as it was.
DROP TABLE search;
CREATE VIRTUAL TABLE search USING fts5(name, text, tokenize = 'trigram');
-- The kernel rebuilds the index on the next start.
DELETE FROM meta WHERE key = 'search_built';
