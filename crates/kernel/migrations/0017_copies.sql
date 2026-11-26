-- 0017 (D487 §21, K9/K10): read-only copies of published subtrees (one row per copy, by its root), and the
-- fingerprints of withheld fields that came with them (the original text is in the keychain, rule 7).
CREATE TABLE IF NOT EXISTS copies (
    root_id TEXT PRIMARY KEY,
    publisher TEXT NOT NULL,
    publisher_name TEXT NOT NULL,
    title TEXT NOT NULL,
    edition INTEGER NOT NULL,
    printing INTEGER NOT NULL,
    variant TEXT NOT NULL,
    published_at INTEGER NOT NULL,
    imported_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sealed (
    resource_id TEXT NOT NULL,
    field TEXT NOT NULL,
    salt TEXT NOT NULL,
    hashes TEXT NOT NULL,
    PRIMARY KEY (resource_id, field)
);
