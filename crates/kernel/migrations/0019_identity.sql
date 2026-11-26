-- D487 §33 (K18): the workspace's identity (its public half; the private key is only in the keychain), signatures on
-- stamps, and the key a read-only copy's publisher signs with.
CREATE TABLE IF NOT EXISTS identity (id INTEGER PRIMARY KEY CHECK (id = 1), name TEXT NOT NULL, org TEXT NOT NULL, public_key TEXT NOT NULL, created_at INTEGER NOT NULL);
ALTER TABLE stamps ADD COLUMN signer_key TEXT;
ALTER TABLE stamps ADD COLUMN signer_name TEXT;
ALTER TABLE stamps ADD COLUMN content_hash TEXT;
ALTER TABLE stamps ADD COLUMN signature TEXT;
ALTER TABLE copies ADD COLUMN publisher_key TEXT;
