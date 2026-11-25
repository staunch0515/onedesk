-- 0016 (D484 §16): files kept by their content (images), and which resources (history included) use them.
CREATE TABLE IF NOT EXISTS blobs (
    hash TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    size INTEGER NOT NULL,
    width INTEGER,
    height INTEGER,
    created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS blob_uses (
    resource_id TEXT NOT NULL,
    hash TEXT NOT NULL,
    PRIMARY KEY (resource_id, hash)
);
CREATE INDEX IF NOT EXISTS blob_uses_hash ON blob_uses (hash);
