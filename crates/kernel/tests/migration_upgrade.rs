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

/// D487 §33: a workspace of 0018 with a stamp and a read-only copy keeps them; they are unsigned (no key) afterwards.
#[test]
fn stamps_and_copies_before_signatures_are_kept_unsigned() {
    let tmp = tempfile::tempdir().unwrap();
    let at = MIGRATIONS.iter().position(|(n, _)| *n == "0018_stamps").unwrap() + 1;
    database_at(tmp.path(), at);
    {
        let conn = Connection::open(tmp.path().join(DB_FILE)).unwrap();
        conn.execute("INSERT INTO stamps (resource_id, seq, label, signer, at, actor) VALUES ('r1', 1, 'Signed', 'A', 1, 'user')", []).unwrap();
        conn.execute("INSERT INTO copies (root_id, publisher, publisher_name, title, edition, printing, variant, published_at, imported_at) VALUES ('b1', 'ws', 'P', 'T', 1, 1, 'student', 1, 1)", []).unwrap();
    }
    let (_ws, conn) = Workspace::open(tmp.path()).unwrap();
    let (label, key): (String, Option<String>) = conn.query_row("SELECT label, signature FROM stamps WHERE resource_id = 'r1'", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
    assert_eq!((label.as_str(), key), ("Signed", None));
    let pk: Option<String> = conn.query_row("SELECT publisher_key FROM copies WHERE root_id = 'b1'", [], |r| r.get(0)).unwrap();
    assert_eq!(pk, None);
    let n: i64 = conn.query_row("SELECT COUNT(*) FROM identity", [], |r| r.get(0)).unwrap();
    assert_eq!(n, 0);
}

