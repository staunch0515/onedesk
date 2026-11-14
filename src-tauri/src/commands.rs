//! Tauri commands. Names, arguments and results follow `src/platform/contract.ts` exactly.
//! Commands are `async` so they run off the main thread; every error is a Chinese string.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use rusqlite::Connection;
use serde::Serialize;
use serde_json::Value;
use tauri::State;

use crate::db::{self, DataPaths, Migration, Param, Statement};
use crate::plugins::{self, ScannedPlugin};
use crate::secrets::{self, Keychain};
use crate::time::UtcTime;
use crate::transfer::{self, ExportFile, ImportData};

pub const DB_FILE: &str = "onedesk.db";

/// Shared backend state: one connection behind a mutex (D20).
pub struct AppState {
    pub paths: DataPaths,
    pub latest_version: i64,
    pub conn: Mutex<Option<Connection>>,
    /// Set when startup failed (directories, open, snapshot-before-migrate or migration). Data commands refuse.
    pub migration_error: Option<String>,
}

/// Mirrors `AppStatus` in src/kernel/contracts.ts.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppStatus {
    pub data_dir: String,
    pub db_path: String,
    pub schema_version: i64,
    pub latest_schema_version: i64,
    pub migration_error: Option<String>,
    pub backups: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RowsAffected {
    pub rows_affected: usize,
}

impl AppState {
    /// Startup: ensure directories → snapshot → migrate (D21–D23).
    pub fn init(data_dir: PathBuf, db_file: &str, migrations: &[Migration]) -> Self {
        let paths = DataPaths::new(data_dir, db_file);
        let latest_version = db::latest_version(migrations);
        if let Err(e) = paths.ensure() {
            return AppState {
                paths,
                latest_version,
                conn: Mutex::new(None),
                migration_error: Some(e),
            };
        }
        let opened = db::open_and_migrate(&paths.db_path, &paths.backups_dir, migrations);
        if let Some(e) = &opened.migration_error {
            eprintln!("[onedesk] {e}");
        }
        AppState {
            paths,
            latest_version,
            conn: Mutex::new(opened.conn),
            migration_error: opened.migration_error,
        }
    }

    /// Production state at `dirs::data_dir()/onedesk` (D22).
    pub fn init_default() -> Self {
        match dirs::data_dir() {
            Some(d) => Self::init(d.join("onedesk"), DB_FILE, db::MIGRATIONS),
            None => AppState {
                paths: DataPaths::new(PathBuf::new(), DB_FILE),
                latest_version: db::latest_version(db::MIGRATIONS),
                conn: Mutex::new(None),
                migration_error: Some("无法确定用户数据目录。".into()),
            },
        }
    }

    fn lock(&self) -> Result<MutexGuard<'_, Option<Connection>>, String> {
        self.conn
            .lock()
            .map_err(|_| "数据库连接不可用，请重启 OneDesk。".to_string())
    }

    /// Runs `f` with the connection, refusing when startup failed.
    pub fn with_conn<T>(
        &self,
        f: impl FnOnce(&mut Connection) -> Result<T, String>,
    ) -> Result<T, String> {
        if let Some(e) = &self.migration_error {
            return Err(format!("数据库不可用：{e}"));
        }
        let mut guard = self.lock()?;
        let conn = guard.as_mut().ok_or_else(|| "数据库未打开。".to_string())?;
        f(conn)
    }

    pub fn status(&self) -> AppStatus {
        let schema_version = self
            .lock()
            .ok()
            .and_then(|g| g.as_ref().and_then(|c| db::schema_version(c).ok()))
            .unwrap_or(0);
        AppStatus {
            data_dir: self.paths.data_dir.to_string_lossy().into_owned(),
            db_path: self.paths.db_path.to_string_lossy().into_owned(),
            schema_version,
            latest_schema_version: self.latest_version,
            migration_error: self.migration_error.clone(),
            backups: db::list_backups(&self.paths.backups_dir),
        }
    }
}

#[tauri::command]
pub async fn app_status(state: State<'_, AppState>) -> Result<AppStatus, String> {
    Ok(state.status())
}

#[tauri::command]
pub async fn db_select(
    state: State<'_, AppState>,
    sql: String,
    params: Vec<Param>,
) -> Result<Vec<Value>, String> {
    state.with_conn(|c| db::select(c, &sql, &params))
}

#[tauri::command]
pub async fn db_execute(
    state: State<'_, AppState>,
    sql: String,
    params: Vec<Param>,
) -> Result<RowsAffected, String> {
    state.with_conn(|c| {
        db::execute(c, &sql, &params).map(|rows_affected| RowsAffected { rows_affected })
    })
}

#[tauri::command]
pub async fn db_batch(
    state: State<'_, AppState>,
    statements: Vec<Statement>,
) -> Result<Vec<usize>, String> {
    state.with_conn(|c| db::batch(c, &statements))
}

#[tauri::command]
pub async fn secrets_list(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    state.with_conn(|c| secrets::list(c))
}

#[tauri::command]
pub async fn secrets_get(
    state: State<'_, AppState>,
    name: String,
) -> Result<Option<String>, String> {
    // Same gate as the other data commands: the index lives in the database.
    state.with_conn(|_| secrets::get(&Keychain, &name))
}

#[tauri::command]
pub async fn secrets_set(
    state: State<'_, AppState>,
    name: String,
    value: String,
) -> Result<(), String> {
    state.with_conn(|c| secrets::set(c, &Keychain, &name, &value))
}

#[tauri::command]
pub async fn secrets_delete(state: State<'_, AppState>, name: String) -> Result<(), String> {
    state.with_conn(|c| secrets::delete(c, &Keychain, &name))
}

#[tauri::command]
pub async fn plugins_scan(state: State<'_, AppState>) -> Result<Vec<ScannedPlugin>, String> {
    plugins::scan(&state.paths.plugins_dir)
}

#[tauri::command]
pub async fn export_write(parent_dir: String, files: Vec<ExportFile>) -> Result<String, String> {
    transfer::export_write(Path::new(&parent_dir), &files, UtcTime::now())
}

#[tauri::command]
pub async fn import_read(dir: String) -> Result<ImportData, String> {
    transfer::import_read(Path::new(&dir))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{check_test_db_path, test_db_enabled, MIGRATIONS};

    #[test]
    fn init_creates_dirs_and_reports_status() {
        if !test_db_enabled() {
            eprintln!("跳过：需要 ONEDESK_TEST_DB=1");
            return;
        }
        let t = tempfile::tempdir().unwrap();
        let data = t.path().join("data");
        check_test_db_path(&data.join("test.db")).unwrap();
        let s = AppState::init(data.clone(), "test.db", MIGRATIONS);
        assert!(data.join("backups").is_dir() && data.join("plugins").is_dir());
        let st = s.status();
        assert_eq!(st.schema_version, 1);
        assert_eq!(st.latest_schema_version, 1);
        assert!(st.migration_error.is_none());
        let rows = s
            .with_conn(|c| db::select(c, "SELECT version FROM schema_version", &[]))
            .unwrap();
        assert_eq!(rows.len(), 1);
        drop(s);
        let s = AppState::init(data.clone(), "test.db", MIGRATIONS);
        assert_eq!(s.status().backups.len(), 1);
        let json = serde_json::to_value(s.status()).unwrap();
        for k in [
            "dataDir",
            "dbPath",
            "schemaVersion",
            "latestSchemaVersion",
            "migrationError",
            "backups",
        ] {
            assert!(json.get(k).is_some(), "{k}");
        }
    }

    #[test]
    fn data_commands_refused_after_failed_startup() {
        let s = AppState {
            paths: DataPaths::new(PathBuf::from("/nonexistent"), "test.db"),
            latest_version: 1,
            conn: Mutex::new(Some(Connection::open_in_memory().unwrap())),
            migration_error: Some("数据库迁移 0002 失败，已回滚".into()),
        };
        let err = s.with_conn(|_| Ok(())).unwrap_err();
        assert!(err.contains("0002"), "{err}");
    }
}
