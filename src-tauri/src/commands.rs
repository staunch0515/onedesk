//! Tauri commands. Names, arguments and results follow `src/platform/contract.ts` exactly.
//! Commands are `async` so they run off the main thread; every error is a Chinese string.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use rusqlite::Connection;
use serde::Serialize;
use serde_json::Value;
use tauri::State;

use crate::db::{self, DataPaths, Migration, Param, Statement};
use crate::plugins::{self, ScannedPlugin};
use crate::secrets::{self, Keychain, SecretBackend};
use crate::time::UtcTime;
use crate::transfer::{self, ExportFile, ImportData};

pub const DB_FILE: &str = "onedesk.db";

/// The single connection (D20). `None` when the database could not be opened.
pub type SharedConn = Arc<Mutex<Option<Connection>>>;

/// Shared backend state.
pub struct AppState {
    pub paths: DataPaths,
    pub latest_version: i64,
    conn: SharedConn,
    /// Set once at startup when directories, open, snapshot-before-migrate or migration failed. Immutable
    /// afterwards, so it is checked without taking the connection lock. Data commands refuse while set.
    migration_error: Option<String>,
    secrets: Box<dyn SecretBackend>,
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
    pub fn new(
        paths: DataPaths,
        latest_version: i64,
        conn: SharedConn,
        migration_error: Option<String>,
        secrets: Box<dyn SecretBackend>,
    ) -> Self {
        AppState {
            paths,
            latest_version,
            conn,
            migration_error,
            secrets,
        }
    }

    /// Startup: ensure directories → snapshot → migrate (D21–D23).
    pub fn init(
        data_dir: PathBuf,
        db_file: &str,
        migrations: &[Migration],
        secrets: Box<dyn SecretBackend>,
    ) -> Self {
        let paths = DataPaths::new(data_dir, db_file);
        let latest = db::latest_version(migrations);
        if let Err(e) = paths.ensure() {
            eprintln!("[onedesk] {e}");
            return Self::new(paths, latest, Arc::default(), Some(e), secrets);
        }
        let opened = db::open_and_migrate(&paths.db_path, &paths.backups_dir, migrations);
        if let Some(e) = &opened.migration_error {
            eprintln!("[onedesk] {e}");
        }
        Self::new(
            paths,
            latest,
            Arc::new(Mutex::new(opened.conn)),
            opened.migration_error,
            secrets,
        )
    }

    /// Production state at `dirs::data_dir()/onedesk` (D22) with the macOS Keychain.
    pub fn init_default() -> Self {
        match dirs::data_dir() {
            Some(d) => Self::init(
                d.join("onedesk"),
                DB_FILE,
                db::MIGRATIONS,
                Box::new(Keychain),
            ),
            None => Self::new(
                DataPaths::new(PathBuf::new(), DB_FILE),
                db::latest_version(db::MIGRATIONS),
                Arc::default(),
                Some("无法确定用户数据目录。".into()),
                Box::new(Keychain),
            ),
        }
    }

    /// A panic while holding the lock must not make the database unusable for the rest of the session:
    /// rusqlite rolls back any open transaction on drop, so the connection is still consistent.
    fn lock(&self) -> MutexGuard<'_, Option<Connection>> {
        self.conn.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Refuses data access after a failed startup. Does not touch the connection lock.
    pub fn ready(&self) -> Result<(), String> {
        match &self.migration_error {
            Some(e) => Err(format!("数据库不可用：{e}")),
            None => Ok(()),
        }
    }

    /// Runs `f` with the connection, refusing when startup failed.
    pub fn with_conn<T>(
        &self,
        f: impl FnOnce(&mut Connection) -> Result<T, String>,
    ) -> Result<T, String> {
        self.ready()?;
        let mut guard = self.lock();
        let conn = guard.as_mut().ok_or_else(|| "数据库未打开。".to_string())?;
        f(conn)
    }

    pub fn status(&self) -> Result<AppStatus, String> {
        let schema_version = match self.lock().as_ref() {
            Some(c) => db::schema_version(c)?,
            // Only when the database could not be opened; migration_error then explains why.
            None => 0,
        };
        Ok(AppStatus {
            data_dir: self.paths.data_dir.to_string_lossy().into_owned(),
            db_path: self.paths.db_path.to_string_lossy().into_owned(),
            schema_version,
            latest_schema_version: self.latest_version,
            migration_error: self.migration_error.clone(),
            backups: db::list_backups(&self.paths.backups_dir),
        })
    }

    /// Keychain only; never takes the connection lock.
    pub fn secret_get(&self, name: &str) -> Result<Option<String>, String> {
        self.ready()?;
        secrets::check_name(name)?;
        self.secrets.get(name)
    }

    /// Keychain first (without the lock), then a short lock for the index write, so the index never names a
    /// value that was not stored.
    pub fn secret_set(&self, name: &str, value: &str) -> Result<(), String> {
        self.ready()?;
        secrets::check_name(name)?;
        self.secrets.set(name, value)?;
        self.with_conn(|c| secrets::index_add(c, name))
    }

    pub fn secret_delete(&self, name: &str) -> Result<(), String> {
        self.ready()?;
        secrets::check_name(name)?;
        self.secrets.delete(name)?;
        self.with_conn(|c| secrets::index_remove(c, name))
    }
}

/// The invoke handler with every command, shared by `run()` and the IPC tests.
pub fn handler<R: tauri::Runtime>() -> impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static
{
    tauri::generate_handler![
        app_status,
        db_select,
        db_execute,
        db_batch,
        secrets_list,
        secrets_get,
        secrets_set,
        secrets_delete,
        plugins_scan,
        export_write,
        import_read,
    ]
}

#[tauri::command]
pub async fn app_status(state: State<'_, AppState>) -> Result<AppStatus, String> {
    state.status()
}

/// `params` may be omitted (treated as `[]`), like `Statement.params`.
#[tauri::command]
pub async fn db_select(
    state: State<'_, AppState>,
    sql: String,
    params: Option<Vec<Param>>,
) -> Result<Vec<Value>, String> {
    let params = params.unwrap_or_default();
    state.with_conn(|c| db::select(c, &sql, &params))
}

#[tauri::command]
pub async fn db_execute(
    state: State<'_, AppState>,
    sql: String,
    params: Option<Vec<Param>>,
) -> Result<RowsAffected, String> {
    let params = params.unwrap_or_default();
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
    state.secret_get(&name)
}

#[tauri::command]
pub async fn secrets_set(
    state: State<'_, AppState>,
    name: String,
    value: String,
) -> Result<(), String> {
    state.secret_set(&name, &value)
}

#[tauri::command]
pub async fn secrets_delete(state: State<'_, AppState>, name: String) -> Result<(), String> {
    state.secret_delete(&name)
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
    use crate::db::{check_test_db_path, migrate, test_db_enabled, MIGRATIONS};
    use serde_json::json;
    use std::collections::HashMap;

    /// In-memory secret store. With `probe` set, every call asserts the connection lock is free.
    #[derive(Default)]
    struct Memory {
        map: Mutex<HashMap<String, String>>,
        probe: Option<SharedConn>,
        fail: bool,
    }

    impl Memory {
        fn check_unlocked(&self) {
            if let Some(c) = &self.probe {
                assert!(c.try_lock().is_ok(), "钥匙串调用期间持有了数据库锁");
            }
        }
    }

    impl SecretBackend for Memory {
        fn get(&self, name: &str) -> Result<Option<String>, String> {
            self.check_unlocked();
            Ok(self.map.lock().unwrap().get(name).cloned())
        }
        fn set(&self, name: &str, value: &str) -> Result<(), String> {
            self.check_unlocked();
            if self.fail {
                return Err("写入钥匙串失败".into());
            }
            self.map.lock().unwrap().insert(name.into(), value.into());
            Ok(())
        }
        fn delete(&self, name: &str) -> Result<(), String> {
            self.check_unlocked();
            self.map.lock().unwrap().remove(name);
            Ok(())
        }
    }

    fn memory_conn() -> SharedConn {
        let mut c = Connection::open_in_memory().unwrap();
        migrate(&mut c, MIGRATIONS).unwrap();
        Arc::new(Mutex::new(Some(c)))
    }

    fn state_with(conn: SharedConn, error: Option<&str>, secrets: Memory) -> AppState {
        AppState::new(
            DataPaths::new(PathBuf::from("/nonexistent"), "test.db"),
            1,
            conn,
            error.map(String::from),
            Box::new(secrets),
        )
    }

    fn memory_state() -> AppState {
        let conn = memory_conn();
        let probe = Memory {
            probe: Some(conn.clone()),
            ..Default::default()
        };
        state_with(conn, None, probe)
    }

    #[test]
    fn init_creates_dirs_and_reports_status() {
        if !test_db_enabled() {
            eprintln!("跳过：需要 ONEDESK_TEST_DB=1");
            return;
        }
        let t = tempfile::tempdir().unwrap();
        let data = t.path().join("data");
        check_test_db_path(&data.join("test.db")).unwrap();
        let init = || {
            AppState::init(
                data.clone(),
                "test.db",
                MIGRATIONS,
                Box::new(Memory::default()),
            )
        };
        let s = init();
        assert!(data.join("backups").is_dir() && data.join("plugins").is_dir());
        let st = s.status().unwrap();
        assert_eq!(st.schema_version, 1);
        assert_eq!(st.latest_schema_version, 1);
        assert!(st.migration_error.is_none());
        drop(s);
        let s = init();
        assert_eq!(s.status().unwrap().backups.len(), 1);
    }

    #[test]
    fn data_commands_refused_after_failed_startup() {
        let s = state_with(
            memory_conn(),
            Some("数据库迁移 0002 失败，已回滚"),
            Memory::default(),
        );
        let err = s.with_conn(|_| Ok(())).unwrap_err();
        assert!(err.contains("0002"), "{err}");
        assert!(s.secret_get("k").unwrap_err().contains("0002"));
        assert!(s.secret_set("k", "v").unwrap_err().contains("0002"));
        assert!(s.secret_delete("k").unwrap_err().contains("0002"));
        // Status still works and reports the real version.
        assert_eq!(s.status().unwrap().schema_version, 1);
    }

    #[test]
    fn secrets_index_names_only_and_keychain_runs_unlocked() {
        let s = memory_state();
        s.secret_set("github_token", "s3cret-value").unwrap();
        s.secret_set("github_token", "s3cret-value-2").unwrap();
        s.secret_set("a_key", "v").unwrap();
        let list = s.with_conn(|c| secrets::list(c)).unwrap();
        assert_eq!(list, vec!["a_key", "github_token"]);
        assert_eq!(
            s.secret_get("github_token").unwrap().as_deref(),
            Some("s3cret-value-2")
        );
        let dump = s
            .with_conn(|c| db::select(c, "SELECT * FROM secret_names", &[]))
            .unwrap();
        assert!(!serde_json::to_string(&dump).unwrap().contains("s3cret"));
        s.secret_delete("github_token").unwrap();
        assert_eq!(s.with_conn(|c| secrets::list(c)).unwrap(), vec!["a_key"]);
        assert_eq!(s.secret_get("github_token").unwrap(), None);
        assert!(s.secret_set(" ", "v").is_err());
    }

    #[test]
    fn keychain_failure_leaves_index_untouched() {
        let s = state_with(
            memory_conn(),
            None,
            Memory {
                fail: true,
                ..Default::default()
            },
        );
        assert!(s.secret_set("k", "v").is_err());
        assert!(s.with_conn(|c| secrets::list(c)).unwrap().is_empty());
    }

    #[test]
    fn poisoned_lock_recovers() {
        let s = Arc::new(memory_state());
        let s2 = s.clone();
        let r = std::thread::spawn(move || {
            let _g = s2.lock();
            panic!("panic while holding the lock");
        })
        .join();
        assert!(r.is_err());
        assert!(s.conn.is_poisoned());
        let rows = s
            .with_conn(|c| db::select(c, "SELECT 1 AS x", &[]))
            .unwrap();
        assert_eq!(rows, vec![json!({"x": 1})]);
        assert_eq!(s.status().unwrap().schema_version, 1);
    }

    #[test]
    fn status_reports_read_errors() {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            "CREATE TABLE schema_version (version TEXT); INSERT INTO schema_version VALUES ('x');",
        )
        .unwrap();
        let s = state_with(Arc::new(Mutex::new(Some(c))), None, Memory::default());
        assert!(s.status().is_err());
        // No connection at all → 0, explained by migrationError.
        let s = state_with(Arc::default(), Some("无法打开数据库"), Memory::default());
        let st = s.status().unwrap();
        assert_eq!(st.schema_version, 0);
        assert!(st.migration_error.is_some());
    }

    // ------------------------------------------------------------------ IPC (mock runtime)

    fn invoke(
        webview: &tauri::WebviewWindow<tauri::test::MockRuntime>,
        cmd: &str,
        body: Value,
    ) -> Result<Value, Value> {
        tauri::test::get_ipc_response(
            webview,
            tauri::webview::InvokeRequest {
                cmd: cmd.into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: "tauri://localhost".parse().unwrap(),
                body: tauri::ipc::InvokeBody::Json(body),
                headers: Default::default(),
                invoke_key: tauri::test::INVOKE_KEY.to_string(),
            },
        )
        .map(|b| b.deserialize::<Value>().unwrap())
    }

    #[test]
    fn ipc_contract_shapes_and_optional_params() {
        let app = tauri::test::mock_builder()
            .manage(memory_state())
            .invoke_handler(handler())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let w = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();

        // params omitted → []
        let r = invoke(
            &w,
            "db_execute",
            json!({"sql": "INSERT INTO app_settings (key, value) VALUES ('a', 'b')"}),
        );
        assert_eq!(r, Ok(json!({"rowsAffected": 1})));
        let r = invoke(
            &w,
            "db_select",
            json!({"sql": "SELECT key, value FROM app_settings"}),
        );
        assert_eq!(r, Ok(json!([{"key": "a", "value": "b"}])));
        // params given
        let r = invoke(
            &w,
            "db_select",
            json!({"sql": "SELECT value FROM app_settings WHERE key = ?", "params": ["a"]}),
        );
        assert_eq!(r, Ok(json!([{"value": "b"}])));
        let r = invoke(
            &w,
            "db_batch",
            json!({"statements": [{"sql": "DELETE FROM app_settings"}, {"sql": "SELECT ?", "params": [1]}]}),
        );
        assert!(r.unwrap_err().as_str().unwrap().contains("回滚"));

        assert_eq!(
            invoke(&w, "secrets_set", json!({"name": "k", "value": "v"})),
            Ok(Value::Null)
        );
        assert_eq!(
            invoke(&w, "secrets_get", json!({"name": "k"})),
            Ok(json!("v"))
        );
        assert_eq!(invoke(&w, "secrets_list", json!({})), Ok(json!(["k"])));
        assert_eq!(
            invoke(&w, "secrets_delete", json!({"name": "k"})),
            Ok(Value::Null)
        );
        assert_eq!(
            invoke(&w, "secrets_get", json!({"name": "k"})),
            Ok(Value::Null)
        );

        let st = invoke(&w, "app_status", json!({})).unwrap();
        for k in [
            "dataDir",
            "dbPath",
            "schemaVersion",
            "latestSchemaVersion",
            "migrationError",
            "backups",
        ] {
            assert!(st.get(k).is_some(), "{k}");
        }
    }
}
