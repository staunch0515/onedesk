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
pub const MIGRATIONS: &[(&str, &str)] = &[("0001_init", include_str!("../migrations/0001_init.sql"))];

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

fn configure(conn: &Connection) -> rusqlite::Result<()> {
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    conn.pragma_update(None, "foreign_keys", true)?;
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
    for (i, (_, sql)) in MIGRATIONS.iter().enumerate().skip(current) {
        let tx = conn.transaction()?;
        tx.execute_batch(sql)?;
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
        let mut conn = Connection::open(dir.join(DB_FILE)).map_err(|e| format!("open db: {e}"))?;
        conn.pragma_update(None, "journal_mode", "WAL").map_err(|e| format!("wal: {e}"))?;
        configure(&conn).map_err(|e| e.to_string())?;
        migrate(&mut conn).map_err(|e| format!("migrate: {e}"))?;

        let db_id: Option<String> =
            conn.query_row("SELECT value FROM meta WHERE key = 'workspace_id'", [], |r| r.get(0)).ok();
        let file: Option<WorkspaceFile> =
            std::fs::read(dir.join(INFO_FILE)).ok().and_then(|b| serde_json::from_slice(&b).ok());
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
            .filter(|n| !n.is_empty())
            .or_else(|| dir.file_name().map(|n| n.to_string_lossy().into_owned()))
            .unwrap_or_else(|| "workspace".into());
        let info = WorkspaceFile { id: id.clone(), name: name.clone(), last_opened_at: crate::util::now_ms() };
        let tmp = dir.join(".workspace.json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(&info).expect("serializes"))
            .and_then(|_| std::fs::rename(&tmp, dir.join(INFO_FILE)))
            .map_err(|e| format!("write workspace.json: {e}"))?;
        Ok((Workspace { dir: dir.to_path_buf(), id, name }, conn))
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

    #[test]
    fn second_lock_on_the_same_workspace_is_busy() {
        let dir = tempfile::tempdir().unwrap();
        let _held = lock_workspace(dir.path()).unwrap();
        assert!(matches!(lock_workspace(dir.path()), Err(LockError::Busy)));
    }
}
