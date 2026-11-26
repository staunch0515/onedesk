-- D487 §23 (K6): stamps on a resource (its content is then fixed), what happened to them, and what its references
-- showed when the first stamp went on.
CREATE TABLE IF NOT EXISTS stamps (resource_id TEXT NOT NULL, seq INTEGER NOT NULL, label TEXT NOT NULL, signer TEXT NOT NULL, at INTEGER NOT NULL, actor TEXT NOT NULL, PRIMARY KEY (resource_id, seq));
CREATE TABLE IF NOT EXISTS stamp_log (id INTEGER PRIMARY KEY AUTOINCREMENT, resource_id TEXT NOT NULL, action TEXT NOT NULL, label TEXT, signer TEXT, reason TEXT, rev INTEGER NOT NULL, at INTEGER NOT NULL, actor TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS stamp_log_resource ON stamp_log (resource_id);
CREATE TABLE IF NOT EXISTS frozen (resource_id TEXT NOT NULL, key TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY (resource_id, key));
