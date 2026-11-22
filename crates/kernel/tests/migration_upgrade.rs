//! Release 1.0 (D452 §3): a database at ANY published migration version upgrades to the latest, opened the way the
//! app opens it (file in a temporary folder, `Workspace::open`). Never touches user data.

use onedesk_kernel::workspace::{Workspace, DB_FILE, MIGRATIONS};
use rusqlite::Connection;

fn schema_version(conn: &Connection) -> usize {
    conn.query_row("SELECT value FROM meta WHERE key = 'schema_version'", [], |r| r.get::<_, String>(0)).unwrap().parse().unwrap()
}

/// Builds a database exactly as an app of version `k` (first `k` migrations) would have left it.
fn database_at(dir: &std::path::Path, k: usize) {
    let conn = Connection::open(dir.join(DB_FILE)).unwrap();
    for (i, (_, sql)) in MIGRATIONS.iter().enumerate().take(k) {
        conn.execute_batch(sql).unwrap();
        conn.execute("INSERT INTO meta (key, value) VALUES ('schema_version', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [(i + 1).to_string()]).unwrap();
    }
}

#[test]
fn every_published_migration_file_is_registered_in_order() {
    let mut files: Vec<String> = std::fs::read_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/migrations"))
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().trim_end_matches(".sql").to_string())
        .collect();
    files.sort();
    let registered: Vec<String> = MIGRATIONS.iter().map(|(n, _)| n.to_string()).collect();
    assert_eq!(files, registered);
    for (i, name) in registered.iter().enumerate() {
        assert!(name.starts_with(&format!("{:04}_", i + 1)), "{name} out of order");
    }
}

#[test]
fn a_database_at_every_published_version_opens_and_reaches_the_latest() {
    for k in 1..=MIGRATIONS.len() {
        let tmp = tempfile::tempdir().unwrap();
        database_at(tmp.path(), k);
        let (_ws, conn) = Workspace::open(tmp.path()).unwrap_or_else(|e| panic!("upgrade from version {k}: {e}"));
        assert_eq!(schema_version(&conn), MIGRATIONS.len(), "from version {k}");
        // Opening again is a no-op.
        drop(conn);
        drop(_ws);
        let (_ws2, conn2) = Workspace::open(tmp.path()).unwrap_or_else(|e| panic!("reopen after upgrade from {k}: {e}"));
        assert_eq!(schema_version(&conn2), MIGRATIONS.len());
        let ok: String = conn2.query_row("PRAGMA integrity_check", [], |r| r.get(0)).unwrap();
        assert_eq!(ok, "ok", "from version {k}");
    }
}
