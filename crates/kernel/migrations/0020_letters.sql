-- D487 §35 (K19): letters sent and received (`dir` out / in) and the replies to those sent.
CREATE TABLE IF NOT EXISTS letters (id TEXT NOT NULL, dir TEXT NOT NULL, resource_id TEXT NOT NULL, peer_key TEXT, peer_name TEXT NOT NULL, subject TEXT NOT NULL, comment TEXT NOT NULL, due TEXT, to_json TEXT NOT NULL, tasks_json TEXT NOT NULL, pages_json TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (id, dir));
CREATE INDEX IF NOT EXISTS letters_resource ON letters (resource_id);
CREATE TABLE IF NOT EXISTS letter_replies (letter_id TEXT NOT NULL, from_key TEXT NOT NULL, from_name TEXT NOT NULL, at INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (letter_id, from_key));
