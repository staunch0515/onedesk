//! Workspace folder (kernel-design §3.1): `workspace.json`, `workspace.db` (WAL), the lock.

use std::fs::{File, OpenOptions};
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};

use crate::util::new_id;

pub const DB_FILE: &str = "workspace.db";
pub const INFO_FILE: &str = "workspace.json";
pub const LOCK_FILE: &str = ".lock";

/// Ordered migrations. Add new files at the end; never edit a published one (rule 6).
pub const MIGRATIONS: &[(&str, &str)] = &[
    ("0001_init", include_str!("../migrations/0001_init.sql")),
    ("0002_search_restore", include_str!("../migrations/0002_search_restore.sql")),
    ("0003_search_rowid", include_str!("../migrations/0003_search_rowid.sql")),
    ("0004_search_secure_delete", include_str!("../migrations/0004_search_secure_delete.sql")),
    ("0005_runs", include_str!("../migrations/0005_runs.sql")),
    ("0006_versions_secrets_counts", include_str!("../migrations/0006_versions_secrets_counts.sql")),
    ("0007_upgrade_prev_active", include_str!("../migrations/0007_upgrade_prev_active.sql")),
    ("0008_refs", include_str!("../migrations/0008_refs.sql")),
    ("0009_resource_names", include_str!("../migrations/0009_resource_names.sql")),
    ("0010_refs_ever", include_str!("../migrations/0010_refs_ever.sql")),
    ("0011_audit_counts_last", include_str!("../migrations/0011_audit_counts_last.sql")),
    ("0012_resources_parent", include_str!("../migrations/0012_resources_parent.sql")),
    ("0013_run_artifacts", include_str!("../migrations/0013_run_artifacts.sql")),
    ("0014_ai_visible_default_off", include_str!("../migrations/0014_ai_visible_default_off.sql")),
    ("0015_default_env", include_str!("../migrations/0015_default_env.sql")),
    ("0016_blobs", include_str!("../migrations/0016_blobs.sql")),
    ("0017_copies", include_str!("../migrations/0017_copies.sql")),
    ("0018_stamps", include_str!("../migrations/0018_stamps.sql")),
    ("0019_identity", include_str!("../migrations/0019_identity.sql")),
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFile {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub last_opened_at: i64,
}

#[derive(Debug)]
pub enum LockError {
    /// Another process holds the workspace.
    Busy,
    Io(std::io::Error),
}

/// Takes the workspace's exclusive lock. The OS releases it when the process ends, however it ends.
pub fn lock_workspace(dir: &Path) -> Result<File, LockError> {
    std::fs::create_dir_all(dir).map_err(LockError::Io)?;
    let f = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(dir.join(LOCK_FILE))
        .map_err(LockError::Io)?;
    match f.try_lock() {
        Ok(()) => Ok(f),
        Err(std::fs::TryLockError::WouldBlock) => Err(LockError::Busy),
        Err(std::fs::TryLockError::Error(e)) => Err(LockError::Io(e)),
    }
}

pub struct Workspace {
    pub dir: PathBuf,
    pub id: String,
    pub name: String,
}

/// Largest `workspace.json` the kernel reads (the real one is well under 1 KiB).
pub const MAX_INFO_BYTES: u64 = 64 * 1024;
/// Longest workspace name kept, in characters (the main process allows 1 to 100).
pub const MAX_NAME_CHARS: usize = 100;

/// Reads `workspace.json` safely (round 14 review #3): only a regular file, not through a symbolic link,
/// never blocking (a FIFO), at most `MAX_INFO_BYTES`; the name is cut to `MAX_NAME_CHARS`. `None` when the
/// file is missing, not a regular file, too large, unreadable, or its name is empty.
pub fn read_info(dir: &Path) -> Option<WorkspaceFile> {
    use std::io::Read;
    use std::os::unix::fs::OpenOptionsExt;
    let f = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(dir.join(INFO_FILE))
        .ok()?;
    // Checked on the opened file, so it cannot be swapped between the check and the read.
    let meta = f.metadata().ok()?;
    if !meta.is_file() || meta.len() > MAX_INFO_BYTES {
        return None;
    }
    let mut bytes = Vec::new();
    f.take(MAX_INFO_BYTES + 1).read_to_end(&mut bytes).ok()?;
    if bytes.len() as u64 > MAX_INFO_BYTES {
        return None;
    }
    let mut info: WorkspaceFile = serde_json::from_slice(&bytes).ok()?;
    if info.name.chars().count() > MAX_NAME_CHARS {
        info.name = info.name.chars().take(MAX_NAME_CHARS).collect();
    }
    Some(info).filter(|i| !i.name.is_empty())
}

fn configure(conn: &Connection) -> rusqlite::Result<()> {
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    conn.pragma_update(None, "foreign_keys", true)?;
    // D283: freed pages are zeroed, so a permanent deletion leaves nothing in the file.
    conn.pragma_update(None, "secure_delete", true)?;
    Ok(())
}

/// Applies every migration newer than the stored `schema_version`, each in its own transaction.
pub fn migrate(conn: &mut Connection) -> rusqlite::Result<usize> {
    let has_meta: i64 =
        conn.query_row("SELECT count(*) FROM sqlite_master WHERE type='table' AND name='meta'", [], |r| r.get(0))?;
    let current: usize = if has_meta == 0 {
        0
    } else {
        conn.query_row("SELECT value FROM meta WHERE key = 'schema_version'", [], |r| r.get::<_, String>(0))
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(0)
    };
    for (i, (_, stmt_text)) in MIGRATIONS.iter().enumerate().skip(current) {
        let tx = conn.transaction()?;
        tx.execute_batch(stmt_text)?;
        tx.execute(
            "INSERT INTO meta (key, value) VALUES ('schema_version', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [(i + 1).to_string()],
        )?;
        tx.commit()?;
    }
    Ok(MIGRATIONS.len())
}

impl Workspace {
    /// Opens the folder, creating `workspace.json` and `workspace.db` when missing.
    /// Returns the workspace and the writable connection (the caller hands it to the writer).
    pub fn open(dir: &Path) -> Result<(Workspace, Connection), String> {
        std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
        // D280: before migrations touch it. A failed snapshot must not keep the workspace closed (#9).
        if let Err(e) = snapshot(dir, crate::util::now_ms()) {
            eprintln!("onedesk: startup snapshot of {} failed: {e}", dir.display());
        }
        let mut conn = Connection::open(dir.join(DB_FILE)).map_err(|e| format!("open db: {e}"))?;
        conn.pragma_update(None, "journal_mode", "WAL").map_err(|e| format!("wal: {e}"))?;
        configure(&conn).map_err(|e| e.to_string())?;
        migrate(&mut conn).map_err(|e| format!("migrate: {e}"))?;

        let db_id: Option<String> =
            conn.query_row("SELECT value FROM meta WHERE key = 'workspace_id'", [], |r| r.get(0)).ok();
        let file = read_info(dir);
        // The database is the source of truth for the id; the file is a cache for the main process.
        let id = db_id.or_else(|| file.as_ref().map(|f| f.id.clone())).unwrap_or_else(new_id);
        conn.execute(
            "INSERT INTO meta (key, value) VALUES ('workspace_id', ?1) ON CONFLICT(key) DO NOTHING",
            [&id],
        )
        .map_err(|e| e.to_string())?;
        let name = file
            .as_ref()
            .map(|f| f.name.clone())
            .or_else(|| dir.file_name().map(|n| n.to_string_lossy().into_owned()))
            .unwrap_or_else(|| "workspace".into());
        let info = WorkspaceFile { id: id.clone(), name: name.clone(), last_opened_at: crate::util::now_ms() };
        let tmp = dir.join(".workspace.json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(&info).expect("serializes"))
            .and_then(|_| std::fs::rename(&tmp, dir.join(INFO_FILE)))
            .map_err(|e| format!("write workspace.json: {e}"))?;
        Ok((Workspace { dir: dir.to_path_buf(), id, name }, conn))
    }

    /// The current name: `workspace.json` is re-read because the main process renames a workspace by rewriting
    /// that file while its worker runs (round 13 review #10). Falls back to the name read at opening.
    pub fn current_name(&self) -> String {
        read_info(&self.dir).map(|f| f.name).unwrap_or_else(|| self.name.clone())
    }

    pub fn open_reader(&self) -> Result<Connection, String> {
        let conn = Connection::open_with_flags(
            self.dir.join(DB_FILE),
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|e| format!("open reader: {e}"))?;
        configure(&conn).map_err(|e| e.to_string())?;
        Ok(conn)
    }
}

pub const BACKUPS_DIR: &str = "backups";

/// `YYYY-MM-DD-HHMMSS.db`
fn is_snapshot_name(n: &str) -> bool {
    let b = n.as_bytes();
    n.len() == 20
        && n.ends_with(".db")
        && b[..17].iter().enumerate().all(|(i, c)| if [4, 7, 10].contains(&i) { *c == b'-' } else { c.is_ascii_digit() })
}

/// Whether opening this database will run a migration.
fn pending_migrations(db: &Path) -> bool {
    let Ok(conn) = Connection::open_with_flags(db, OpenFlags::SQLITE_OPEN_READ_ONLY) else { return false };
    let v: Option<String> = conn.query_row("SELECT value FROM meta WHERE key = 'schema_version'", [], |r| r.get(0)).ok();
    v.and_then(|v| v.parse::<usize>().ok()).is_none_or(|v| v < MIGRATIONS.len())
}
pub const BACKUPS_KEPT: usize = 7;

/// `YYYY-MM-DD-HHMMSS` (UTC) of a millisecond timestamp.
pub fn stamp(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Civil date from days since 1970-01-01 (H. Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}-{:02}{:02}{:02}", rem / 3600, rem % 3600 / 60, rem % 60)
}

/// Startup snapshot (D280): copies an existing `workspace.db` to `backups/<stamp>.db` with
/// `VACUUM INTO` (a consistent online copy), at most once per day, keeping the newest 7.
pub fn snapshot(dir: &Path, now: i64) -> Result<Option<PathBuf>, String> {
    let db = dir.join(DB_FILE);
    if !db.exists() {
        return Ok(None);
    }
    let backups = dir.join(BACKUPS_DIR);
    std::fs::create_dir_all(&backups).map_err(|e| e.to_string())?;
    let name = format!("{}.db", stamp(now));
    let today = &name[..10];
    // Only files this function made (#10): a user's own files in `backups/` are left alone.
    let mut existing: Vec<String> = std::fs::read_dir(&backups)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| is_snapshot_name(n))
        .collect();
    // #15: a migration is about to run — always keep a copy of the database before it.
    let pending = pending_migrations(&db);
    let made = if existing.iter().any(|n| n.starts_with(today)) && !pending {
        None
    } else {
        let target = backups.join(&name);
        if target.exists() {
            let _ = std::fs::remove_file(&target);
        }
        let conn = Connection::open(&db).map_err(|e| e.to_string())?;
        conn.execute("VACUUM INTO ?1", [target.display().to_string()]).map_err(|e| e.to_string())?;
        existing.push(name);
        Some(target)
    };
    existing.sort();
    let excess = existing.len().saturating_sub(BACKUPS_KEPT);
    for old in &existing[..excess] {
        let _ = std::fs::remove_file(backups.join(old));
    }
    Ok(made)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migration_0001_upgrades_an_empty_database_and_is_idempotent() {
        let mut conn = Connection::open_in_memory().unwrap();
        migrate(&mut conn).unwrap();
        migrate(&mut conn).unwrap();
        let v: String = conn.query_row("SELECT value FROM meta WHERE key='schema_version'", [], |r| r.get(0)).unwrap();
        assert_eq!(v, MIGRATIONS.len().to_string());
        for t in ["resources", "revisions", "audit", "resource_meta", "plugin_storage", "ui_state", "outbox", "meta"] {
            let n: i64 = conn
                .query_row("SELECT count(*) FROM sqlite_master WHERE type='table' AND name=?1", [t], |r| r.get(0))
                .unwrap();
            assert_eq!(n, 1, "table {t}");
        }
    }

    #[test]
    fn audit_table_rejects_update_and_delete() {
        let mut conn = Connection::open_in_memory().unwrap();
        migrate(&mut conn).unwrap();
        conn.execute("INSERT INTO audit (at, actor, op, object, summary, result) VALUES (1,'user','x','o','{}','ok')", [])
            .unwrap();
        assert!(conn.execute("UPDATE audit SET op = 'y'", []).is_err());
        assert!(conn.execute("DELETE FROM audit", []).is_err());
        let n: i64 = conn.query_row("SELECT count(*) FROM audit", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
    }

    #[test]
    fn workspace_open_creates_files_and_keeps_its_id() {
        let dir = tempfile::tempdir().unwrap();
        let ws_dir = dir.path().join("ws");
        let (ws, conn) = Workspace::open(&ws_dir).unwrap();
        drop(conn);
        assert!(ws_dir.join(DB_FILE).exists() && ws_dir.join(INFO_FILE).exists());
        let (again, _c) = Workspace::open(&ws_dir).unwrap();
        assert_eq!(ws.id, again.id);
        // workspace.json lost: the id comes back from the database.
        std::fs::remove_file(ws_dir.join(INFO_FILE)).unwrap();
        let (third, _c) = Workspace::open(&ws_dir).unwrap();
        assert_eq!(ws.id, third.id);
    }

    /// Round 14 review #3: `workspace.json` is read only as a small regular file; the name is bounded.
    #[test]
    fn workspace_json_is_read_only_as_a_small_regular_file() {
        let dir = tempfile::tempdir().unwrap();
        let ws_dir = dir.path().join("ws");
        let (ws, conn) = Workspace::open(&ws_dir).unwrap();
        drop(conn);
        let info = ws_dir.join(INFO_FILE);
        let write = |name: &str| {
            let f = WorkspaceFile { id: ws.id.clone(), name: name.into(), last_opened_at: 0 };
            std::fs::write(&info, serde_json::to_vec(&f).unwrap()).unwrap();
        };
        write("Fine");
        assert_eq!(ws.current_name(), "Fine");
        // A name longer than 100 characters is cut (characters, not bytes).
        write(&"名".repeat(150));
        assert_eq!(read_info(&ws_dir).unwrap().name, "名".repeat(MAX_NAME_CHARS));
        // Too large: not read, the name read at opening stays.
        let mut big = serde_json::to_vec(&WorkspaceFile { id: ws.id.clone(), name: "Big".into(), last_opened_at: 0 }).unwrap();
        big.extend(std::iter::repeat_n(b' ', MAX_INFO_BYTES as usize));
        std::fs::write(&info, &big).unwrap();
        assert!(read_info(&ws_dir).is_none());
        assert_eq!(ws.current_name(), ws.name);
        // A symbolic link (here to an endless device) is not followed.
        std::fs::remove_file(&info).unwrap();
        std::os::unix::fs::symlink("/dev/zero", &info).unwrap();
        assert!(read_info(&ws_dir).is_none());
        assert_eq!(ws.current_name(), ws.name);
        // A FIFO with no writer does not block.
        std::fs::remove_file(&info).unwrap();
        let c = std::ffi::CString::new(info.as_os_str().as_encoded_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
        assert!(read_info(&ws_dir).is_none());
        assert_eq!(ws.current_name(), ws.name);
        // Opening the workspace with such a file neither hangs nor fails; the file is replaced by a real one.
        std::fs::remove_file(&info).unwrap();
        std::os::unix::fs::symlink("/dev/zero", &info).unwrap();
        let (again, _c) = Workspace::open(&ws_dir).unwrap();
        assert_eq!(again.id, ws.id);
        assert!(std::fs::symlink_metadata(&info).unwrap().is_file());
    }

    #[test]
    fn stamp_formats_utc_dates() {
        assert_eq!(stamp(0), "1970-01-01-000000");
        assert_eq!(stamp(1_763_200_000_000), "2025-11-15-094640");
        assert_eq!(stamp(951_782_400_000), "2000-02-29-000000");
    }

    #[test]
    fn startup_snapshots_once_a_day_and_keeps_seven() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path();
        let (_w, conn) = Workspace::open(ws).unwrap();
        conn.execute("INSERT INTO meta (key, value) VALUES ('probe', 'kept')", []).unwrap();
        drop(conn);
        let backups = ws.join(BACKUPS_DIR);
        std::fs::create_dir_all(&backups).unwrap();
        for i in 1..=8 {
            std::fs::write(backups.join(format!("2020-01-0{i}-000000.db")), b"old").unwrap();
        }
        let day = 1_763_200_000_000;
        let made = snapshot(ws, day).unwrap().expect("a snapshot today");
        assert!(snapshot(ws, day + 3_600_000).unwrap().is_none(), "only once a day");
        let mut names: Vec<String> =
            std::fs::read_dir(&backups).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        assert_eq!(names.len(), BACKUPS_KEPT);
        assert_eq!(names.last().unwrap(), "2025-11-15-094640.db");
        assert!(!names.contains(&"2020-01-01-000000.db".to_string()));
        let copy = Connection::open(made).unwrap();
        let v: String = copy.query_row("SELECT value FROM meta WHERE key = 'probe'", [], |r| r.get(0)).unwrap();
        assert_eq!(v, "kept");
    }

    #[test]
    fn migration_0002_upgrades_a_0001_database_without_losing_data() {
        let mut conn = Connection::open_in_memory().unwrap();
        let tx = conn.transaction().unwrap();
        tx.execute_batch(MIGRATIONS[0].1).unwrap();
        tx.execute("INSERT INTO meta (key, value) VALUES ('schema_version', '1')", []).unwrap();
        tx.execute(
            "INSERT INTO resources (id, kind, name, rev, created_at, created_by, updated_at, updated_by)
             VALUES ('r1', 'core:group', 'Old', 1, 0, 'user', 0, 'user')",
            [],
        )
        .unwrap();
        tx.execute(
            "INSERT INTO revisions (resource_id, rev, at, actor, op, fields, snapshot) VALUES ('r1', 1, 0, 'user', 'create', '[]', '{}')",
            [],
        )
        .unwrap();
        tx.commit().unwrap();
        migrate(&mut conn).unwrap();
        let name: String = conn.query_row("SELECT name FROM resources WHERE id = 'r1'", [], |r| r.get(0)).unwrap();
        assert_eq!(name, "Old");
        let rf: Option<String> = conn.query_row("SELECT restored_from FROM revisions WHERE resource_id = 'r1'", [], |r| r.get(0)).unwrap();
        assert!(rf.is_none());
        conn.execute("INSERT INTO search (rowid, name, text) VALUES (1, 'Old', '')", []).unwrap();
        let v: String = conn.query_row("SELECT value FROM meta WHERE key='schema_version'", [], |r| r.get(0)).unwrap();
        assert_eq!(v, MIGRATIONS.len().to_string());
    }

    #[test]
    fn snapshot_failure_does_not_block_opening_and_user_files_are_kept() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path();
        drop(Workspace::open(ws).unwrap());
        // `backups` is a file: the snapshot fails, the workspace opens anyway.
        std::fs::write(ws.join(BACKUPS_DIR), b"not a folder").unwrap();
        assert!(snapshot(ws, 1_763_200_000_000).is_err());
        drop(Workspace::open(ws).unwrap());
        std::fs::remove_file(ws.join(BACKUPS_DIR)).unwrap();
        let backups = ws.join(BACKUPS_DIR);
        std::fs::create_dir_all(&backups).unwrap();
        for i in 1..=9 {
            std::fs::write(backups.join(format!("2020-01-0{i}-000000.db")), b"old").unwrap();
        }
        std::fs::write(backups.join("my-own.db"), b"mine").unwrap();
        snapshot(ws, 1_763_200_000_000).unwrap();
        assert!(backups.join("my-own.db").exists());
        let ours = std::fs::read_dir(&backups).unwrap().filter(|e| is_snapshot_name(&e.as_ref().unwrap().file_name().to_string_lossy())).count();
        assert_eq!(ours, BACKUPS_KEPT);
    }

    #[test]
    fn snapshot_is_taken_again_the_same_day_when_a_migration_is_pending() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path();
        drop(Workspace::open(ws).unwrap());
        let day = 1_763_200_000_000;
        assert!(snapshot(ws, day).unwrap().is_some());
        assert!(snapshot(ws, day + 1000).unwrap().is_none());
        let conn = Connection::open(ws.join(DB_FILE)).unwrap();
        conn.execute("UPDATE meta SET value = '1' WHERE key = 'schema_version'", []).unwrap();
        drop(conn);
        assert!(snapshot(ws, day + 2000).unwrap().is_some(), "pending migration → another copy");
    }

    #[test]
    fn migration_0003_rebuilds_search_by_rowid_without_losing_data() {
        let mut conn = Connection::open_in_memory().unwrap();
        let tx = conn.transaction().unwrap();
        tx.execute_batch(MIGRATIONS[0].1).unwrap();
        tx.execute_batch(MIGRATIONS[1].1).unwrap();
        tx.execute("INSERT INTO meta (key, value) VALUES ('schema_version', '2'), ('search_built', '1')", []).unwrap();
        tx.execute(
            "INSERT INTO resources (id, kind, name, rev, created_at, created_by, updated_at, updated_by)
             VALUES ('r1', 'core:group', 'Kept', 1, 0, 'user', 0, 'user')",
            [],
        )
        .unwrap();
        tx.execute("INSERT INTO search (id, name, text) VALUES ('r1', 'Kept', '')", []).unwrap();
        tx.commit().unwrap();
        migrate(&mut conn).unwrap();
        let name: String = conn.query_row("SELECT name FROM resources WHERE id = 'r1'", [], |r| r.get(0)).unwrap();
        assert_eq!(name, "Kept");
        assert!(conn.query_row("SELECT id FROM search", [], |r| r.get::<_, String>(0)).is_err(), "no id column any more");
        let built: i64 = conn.query_row("SELECT count(*) FROM meta WHERE key = 'search_built'", [], |r| r.get(0)).unwrap();
        assert_eq!(built, 0, "the kernel rebuilds the index on start");
        let v: String = conn.query_row("SELECT value FROM meta WHERE key='schema_version'", [], |r| r.get(0)).unwrap();
        assert_eq!(v, MIGRATIONS.len().to_string());
    }

    #[test]
    fn migration_0004_turns_on_secure_delete_for_search_and_keeps_data() {
        let mut conn = Connection::open_in_memory().unwrap();
        let tx = conn.transaction().unwrap();
        for (_, m) in &MIGRATIONS[..3] {
            tx.execute_batch(m).unwrap();
        }
        tx.execute("INSERT INTO meta (key, value) VALUES ('schema_version', '3')", []).unwrap();
        tx.execute("INSERT INTO search (rowid, name, text) VALUES (7, 'Kept', 'body')", []).unwrap();
        tx.commit().unwrap();
        migrate(&mut conn).unwrap();
        let v: i64 = conn.query_row("SELECT v FROM search_config WHERE k = 'secure-delete'", [], |r| r.get(0)).unwrap();
        assert_eq!(v, 1);
        let name: String = conn.query_row("SELECT name FROM search WHERE rowid = 7", [], |r| r.get(0)).unwrap();
        assert_eq!(name, "Kept");
    }

    #[test]
    fn migration_0005_adds_runs_and_keeps_data() {
        let mut conn = Connection::open_in_memory().unwrap();
        let tx = conn.transaction().unwrap();
        for (_, m) in &MIGRATIONS[..4] {
            tx.execute_batch(m).unwrap();
        }
        tx.execute("INSERT INTO meta (key, value) VALUES ('schema_version', '4')", []).unwrap();
        tx.execute(
            "INSERT INTO resources (id, kind, name, rev, created_at, created_by, updated_at, updated_by)
             VALUES ('r1', 'core:group', 'Kept', 1, 0, 'user', 0, 'user')",
            [],
        )
        .unwrap();
        tx.commit().unwrap();
        migrate(&mut conn).unwrap();
        let name: String = conn.query_row("SELECT name FROM resources WHERE id = 'r1'", [], |r| r.get(0)).unwrap();
        assert_eq!(name, "Kept");
        let n: i64 = conn.query_row("SELECT count(*) FROM runs", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0);
        let v: String = conn.query_row("SELECT value FROM meta WHERE key='schema_version'", [], |r| r.get(0)).unwrap();
        assert_eq!(v, MIGRATIONS.len().to_string());
    }

    #[test]
    fn migration_0006_adds_round4_tables_and_keeps_data() {
        let mut conn = Connection::open_in_memory().unwrap();
        let tx = conn.transaction().unwrap();
        for (_, m) in &MIGRATIONS[..5] {
            tx.execute_batch(m).unwrap();
        }
        tx.execute("INSERT INTO meta (key, value) VALUES ('schema_version', '5')", []).unwrap();
        tx.execute(
            "INSERT INTO resources (id, kind, name, rev, created_at, created_by, updated_at, updated_by)
             VALUES ('r1', 'core:group', 'Kept', 1, 0, 'user', 0, 'user')",
            [],
        )
        .unwrap();
        tx.commit().unwrap();
        migrate(&mut conn).unwrap();
        let name: String = conn.query_row("SELECT name FROM resources WHERE id = 'r1'", [], |r| r.get(0)).unwrap();
        assert_eq!(name, "Kept");
        for t in ["upgrade_batches", "upgrade_items", "secret_names", "audit_counts"] {
            let n: i64 = conn.query_row(&format!("SELECT count(*) FROM {t}"), [], |r| r.get(0)).unwrap();
            assert_eq!(n, 0, "{t}");
        }
    }

    #[test]
    fn migration_0011_adds_last_summary_and_failures_to_merged_audit_rows() {
        let mut conn = Connection::open_in_memory().unwrap();
        let tx = conn.transaction().unwrap();
        for (_, stmt_text) in &MIGRATIONS[..10] {
            tx.execute_batch(stmt_text).unwrap();
        }
        tx.execute("INSERT INTO meta (key, value) VALUES ('schema_version', '10')", []).unwrap();
        tx.execute(
            "INSERT INTO audit_counts (run_id, op, object, audit_seq, count, first_at, last_at) VALUES ('r', 'network.request', 'h', 1, 3, 0, 5)",
            [],
        )
        .unwrap();
        tx.commit().unwrap();
        migrate(&mut conn).unwrap();
        let row: (i64, Option<String>, i64) =
            conn.query_row("SELECT count, last_summary, failures FROM audit_counts", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap();
        assert_eq!(row, (3, None, 0));
    }

    #[test]
    fn migration_0012_indexes_parents_and_keeps_data() {
        let mut conn = Connection::open_in_memory().unwrap();
        let tx = conn.transaction().unwrap();
        for (_, stmt_text) in &MIGRATIONS[..11] {
            tx.execute_batch(stmt_text).unwrap();
        }
        tx.execute("INSERT INTO meta (key, value) VALUES ('schema_version', '11')", []).unwrap();
        for (id, parent) in [("p", None), ("c", Some("p"))] {
            tx.execute(
                "INSERT INTO resources (id, kind, tree, parent_id, name, rev, created_at, created_by, updated_at, updated_by)
                 VALUES (?1, 'k', 'resources', ?2, ?1, 1, 0, 'user', 0, 'user')",
                rusqlite::params![id, parent],
            )
            .unwrap();
        }
        tx.commit().unwrap();
        migrate(&mut conn).unwrap();
        let n: i64 = conn.query_row("SELECT count(*) FROM resources", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 2);
        // The "has children" look-up uses the new index instead of scanning the table.
        let plans: Vec<String> = conn
            .prepare("EXPLAIN QUERY PLAN SELECT 1 FROM resources WHERE parent_id = 'p' AND deleted_at IS NULL")
            .unwrap()
            .query_map([], |r| r.get::<_, String>(3))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert!(plans.iter().any(|p| p.contains("resources_parent")), "{plans:?}");
        let v: String = conn.query_row("SELECT value FROM meta WHERE key = 'schema_version'", [], |r| r.get(0)).unwrap();
        assert_eq!(v, MIGRATIONS.len().to_string());
    }

    #[test]
    fn migration_0013_adds_run_artifacts_that_go_with_their_run() {
        let mut conn = Connection::open_in_memory().unwrap();
        let tx = conn.transaction().unwrap();
        for (_, stmt_text) in &MIGRATIONS[..12] {
            tx.execute_batch(stmt_text).unwrap();
        }
        tx.execute("INSERT INTO meta (key, value) VALUES ('schema_version', '12')", []).unwrap();
        tx.execute(
            "INSERT INTO runs (id, seq, title, icon, plugin, action, action_label, actor, source, started_at, status)
             VALUES ('r1', 1, 't', 'i', 'p', 'a', '{}', 'user', 'manual', 0, 'success'), ('r2', 2, 't', 'i', 'p', 'a', '{}', 'user', 'manual', 0, 'success')",
            [],
        )
        .unwrap();
        tx.commit().unwrap();
        migrate(&mut conn).unwrap();
        let n: i64 = conn.query_row("SELECT count(*) FROM runs", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 2, "existing runs are kept");
        for (id, run) in [("a1", "r1"), ("a2", "r1"), ("a3", "r2")] {
            conn.execute("INSERT INTO run_artifacts (id, run_id, plugin, name, kind, data, created_at) VALUES (?1, ?2, 'p', 'n', 'k', '1', 0)", [id, run]).unwrap();
        }
        conn.execute("DELETE FROM runs WHERE id = 'r1'", []).unwrap();
        let left: Vec<String> =
            conn.prepare("SELECT id FROM run_artifacts").unwrap().query_map([], |r| r.get(0)).unwrap().map(|r| r.unwrap()).collect();
        assert_eq!(left, ["a3"], "the run's artifacts go with it");
        let v: String = conn.query_row("SELECT value FROM meta WHERE key = 'schema_version'", [], |r| r.get(0)).unwrap();
        assert_eq!(v, MIGRATIONS.len().to_string());
    }

    #[test]
    fn migration_0007_records_the_previous_active_version_and_keeps_batches() {
        let mut conn = Connection::open_in_memory().unwrap();
        let tx = conn.transaction().unwrap();
        for (_, m) in &MIGRATIONS[..6] {
            tx.execute_batch(m).unwrap();
        }
        tx.execute("INSERT INTO meta (key, value) VALUES ('schema_version', '6')", []).unwrap();
        tx.execute("INSERT INTO upgrade_batches (id, plugin, from_version, to_version, at) VALUES ('b', 'p', '0.1.0', '0.2.0', 1)", []).unwrap();
        tx.commit().unwrap();
        migrate(&mut conn).unwrap();
        let (to, prev): (String, Option<String>) =
            conn.query_row("SELECT to_version, prev_active FROM upgrade_batches WHERE id = 'b'", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!((to.as_str(), prev), ("0.2.0", None));
    }

    #[test]
    fn second_lock_on_the_same_workspace_is_busy() {
        let dir = tempfile::tempdir().unwrap();
        let _held = lock_workspace(dir.path()).unwrap();
        assert!(matches!(lock_workspace(dir.path()), Err(LockError::Busy)));
    }
}
