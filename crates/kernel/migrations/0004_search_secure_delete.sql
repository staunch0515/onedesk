-- 0004 (D283): removing a search row also scrubs it from the FTS5 segments, so a permanently
-- deleted resource's text does not linger in the index's shadow tables.
INSERT INTO search (search, rank) VALUES ('secure-delete', 1);
