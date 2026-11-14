//! SQLite access: migrations, startup snapshots, query helpers (D20, D21, D23, D26, D59).

use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::types::{Value as SqlValue, ValueRef};
use rusqlite::{params_from_iter, Connection};
use serde::Deserialize;
use serde_json::{Map, Number, Value};

use crate::time::UtcTime;

/// A migration: version number and SQL text.
pub type Migration = (i64, &'static str);

/// All migrations, embedded at compile time. Never edit a published one; add `NNNN_name.sql` instead.
pub const MIGRATIONS: &[Migration] = &[(1, include_str!("../migrations/0001_init.sql"))];

/// Number of startup snapshots kept in `backups/`.
pub const BACKUPS_KEPT: usize = 7;
const BACKUP_PREFIX: &str = "onedesk-";
const BACKUP_SUFFIX: &str = ".db";

pub fn latest_version(migrations: &[Migration]) -> i64 {
    migrations.iter().map(|m| m.0).max().unwrap_or(0)
}

// ------------------------------------------------------------------ test-database guard (D26)

/// Environment switch that must be `1` before any test rebuilds a database file.
pub const TEST_DB_ENV: &str = "ONEDESK_TEST_DB";

/// Refuses paths that look like the real OneDesk database (D26). Used by every test that writes a DB file.
pub fn check_test_db_path(path: &Path) -> Result<(), String> {
    let s = path.to_string_lossy();
    // macOS file systems are case-insensitive by default, so compare lowercased.
    let lower = s.to_lowercase();
    if lower.contains("application support/onedesk") {
        return Err(format!("拒绝在正式数据目录中运行测试：{s}"));
    }
    if path
        .file_name()
        .is_some_and(|n| n.to_string_lossy().to_lowercase() == "onedesk.db")
    {
        return Err(format!("拒绝在名为 onedesk.db 的数据库上运行测试：{s}"));
    }
    Ok(())
}

/// Test builds only: refuse to open any database file unless `ONEDESK_TEST_DB=1` and the path passes
/// `check_test_db_path` (deny by default, D26).
#[cfg(test)]
fn test_open_guard(path: &Path) -> Result<(), String> {
    if !test_db_enabled() {
        return Err(format!("测试需要 {TEST_DB_ENV}=1 才能打开数据库文件"));
    }
    check_test_db_path(path)
}

#[cfg(not(test))]
fn test_open_guard(_path: &Path) -> Result<(), String> {
    Ok(())
}

/// True when `ONEDESK_TEST_DB=1`.
pub fn test_db_enabled() -> bool {
    std::env::var(TEST_DB_ENV).is_ok_and(|v| v == "1")
}

// ------------------------------------------------------------------ migrations

fn current_version(conn: &Connection) -> rusqlite::Result<i64> {
    let exists: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_version')",
        [],
        |r| r.get(0),
    )?;
    if !exists {
        return Ok(0);
    }
    // Read errors propagate (never silently reported as version 0); an empty table means 0.
    let v: Option<i64> =
        conn.query_row("SELECT MAX(version) FROM schema_version", [], |r| r.get(0))?;
    Ok(v.unwrap_or(0))
}

/// Schema version recorded in the database (0 when never migrated).
pub fn schema_version(conn: &Connection) -> Result<i64, String> {
    current_version(conn).map_err(|e| format!("读取数据库版本失败：{e}"))
}

/// True when at least one migration has not been applied yet.
pub fn needs_migration(conn: &Connection, migrations: &[Migration]) -> Result<bool, String> {
    Ok(schema_version(conn)? < latest_version(migrations))
}

/// Applies pending migrations, each in its own transaction. On failure the failing migration is rolled back
/// (earlier ones stay committed) and a Chinese message is returned.
pub fn migrate(conn: &mut Connection, migrations: &[Migration]) -> Result<i64, String> {
    let mut version = schema_version(conn)?;
    let latest = latest_version(migrations);
    if version > latest {
        return Err(format!(
            "数据库版本（{version}）高于当前应用支持的版本（{latest}），请升级 OneDesk。"
        ));
    }
    let mut sorted: Vec<&Migration> = migrations.iter().collect();
    sorted.sort_by_key(|m| m.0);
    for (v, sql) in sorted {
        if *v <= version {
            continue;
        }
        let mut run = || -> rusqlite::Result<()> {
            let tx = conn.transaction()?;
            tx.execute_batch(
                "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);",
            )?;
            tx.execute_batch(sql)?;
            tx.execute("DELETE FROM schema_version", [])?;
            tx.execute("INSERT INTO schema_version (version) VALUES (?1)", [*v])?;
            tx.commit()
        };
        run().map_err(|e| format!("数据库迁移 {v:04} 失败，已回滚：{e}"))?;
        version = *v;
    }
    Ok(version)
}

// ------------------------------------------------------------------ snapshots (D23)

/// Lists snapshot file names in `backups/`, newest first.
pub fn list_backups(backups_dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(backups_dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| n.starts_with(BACKUP_PREFIX) && n.ends_with(BACKUP_SUFFIX))
        .collect();
    names.sort();
    names.reverse();
    names
}

/// Writes `backups/onedesk-YYYYMMDD-HHMMSS.db` with `VACUUM INTO`, then keeps only the newest `keep`.
/// Returns the new file name.
pub fn snapshot(
    conn: &Connection,
    backups_dir: &Path,
    now: UtcTime,
    keep: usize,
) -> Result<String, String> {
    fs::create_dir_all(backups_dir).map_err(|e| format!("无法创建备份文件夹：{e}"))?;
    let base = format!("{BACKUP_PREFIX}{}", now.compact());
    let mut name = format!("{base}{BACKUP_SUFFIX}");
    let mut n = 2;
    while backups_dir.join(&name).exists() {
        name = format!("{base}-{n}{BACKUP_SUFFIX}");
        n += 1;
    }
    let target = backups_dir.join(&name);
    conn.execute("VACUUM INTO ?1", [target.to_string_lossy()])
        .map_err(|e| format!("写入启动快照失败：{e}"))?;
    prune_backups(backups_dir, keep);
    Ok(name)
}

fn prune_backups(backups_dir: &Path, keep: usize) {
    for old in list_backups(backups_dir).into_iter().skip(keep) {
        if let Err(e) = fs::remove_file(backups_dir.join(&old)) {
            eprintln!("[onedesk] 删除旧快照 {old} 失败：{e}");
        }
    }
}

// ------------------------------------------------------------------ startup

/// Result of opening the database at startup.
pub struct Opened {
    pub conn: Option<Connection>,
    pub migration_error: Option<String>,
}

/// Startup sequence: open → snapshot (when the DB already existed) → migrate.
/// A snapshot failure blocks pending migrations (no migration without a backup).
pub fn open_and_migrate(db_path: &Path, backups_dir: &Path, migrations: &[Migration]) -> Opened {
    if let Err(e) = test_open_guard(db_path) {
        return Opened {
            conn: None,
            migration_error: Some(e),
        };
    }
    let existed = db_path.is_file() && fs::metadata(db_path).map(|m| m.len() > 0).unwrap_or(false);
    let mut conn = match Connection::open(db_path) {
        Ok(c) => c,
        Err(e) => {
            return Opened {
                conn: None,
                migration_error: Some(format!("无法打开数据库 {}：{e}", db_path.display())),
            }
        }
    };
    if let Err(e) = conn.execute_batch("PRAGMA foreign_keys = ON;") {
        eprintln!("[onedesk] 设置 PRAGMA 失败：{e}");
    }
    let pending = match needs_migration(&conn, migrations) {
        Ok(p) => p,
        Err(e) => {
            return Opened {
                conn: Some(conn),
                migration_error: Some(e),
            }
        }
    };
    if existed {
        if let Err(e) = snapshot(&conn, backups_dir, UtcTime::now(), BACKUPS_KEPT) {
            if pending {
                return Opened {
                    conn: Some(conn),
                    migration_error: Some(format!("{e}；为保护数据，未执行迁移。")),
                };
            }
            eprintln!("[onedesk] {e}");
        }
    }
    let migration_error = if pending {
        migrate(&mut conn, migrations).err()
    } else {
        None
    };
    Opened {
        conn: Some(conn),
        migration_error,
    }
}

// ------------------------------------------------------------------ queries

/// `SqlParam = string | number | null` from the front end.
#[derive(Debug, Clone, Deserialize)]
#[serde(transparent)]
pub struct Param(pub Value);

/// One statement in `db_batch`.
#[derive(Debug, Clone, Deserialize)]
pub struct Statement {
    pub sql: String,
    #[serde(default)]
    pub params: Vec<Param>,
}

fn to_sql_value(p: &Param) -> Result<SqlValue, String> {
    Ok(match &p.0 {
        Value::Null => SqlValue::Null,
        Value::String(s) => SqlValue::Text(s.clone()),
        Value::Bool(b) => SqlValue::Integer(i64::from(*b)),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                SqlValue::Integer(i)
            } else if let Some(f) = n.as_f64() {
                // Integral numbers bind as INTEGER (contracts.ts SqlDriver).
                if f.fract() == 0.0 && f.abs() < 9.007_199_254_740_992e15 {
                    SqlValue::Integer(f as i64)
                } else {
                    SqlValue::Real(f)
                }
            } else {
                return Err(format!("不支持的数字参数：{n}"));
            }
        }
        other => return Err(format!("不支持的 SQL 参数类型：{other}")),
    })
}

fn bind(params: &[Param]) -> Result<Vec<SqlValue>, String> {
    params.iter().map(to_sql_value).collect()
}

fn to_json(v: ValueRef<'_>) -> Value {
    match v {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => Value::from(i),
        ValueRef::Real(f) => Number::from_f64(f)
            .map(Value::Number)
            .unwrap_or(Value::Null),
        ValueRef::Text(t) => Value::String(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(b) => Value::Array(b.iter().map(|x| Value::from(*x)).collect()),
    }
}

fn sql_err(e: rusqlite::Error) -> String {
    format!("数据库操作失败：{e}")
}

/// Runs a query and returns rows as `{ column: value }` objects.
pub fn select(conn: &Connection, sql: &str, params: &[Param]) -> Result<Vec<Value>, String> {
    let values = bind(params)?;
    let mut stmt = conn.prepare(sql).map_err(sql_err)?;
    let cols: Vec<String> = stmt.column_names().map(|c| c.to_string()).collect();
    let mut rows = stmt.query(params_from_iter(values)).map_err(sql_err)?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().map_err(sql_err)? {
        let mut obj = Map::with_capacity(cols.len());
        for (i, c) in cols.iter().enumerate() {
            obj.insert(c.clone(), to_json(row.get_ref(i).map_err(sql_err)?));
        }
        out.push(Value::Object(obj));
    }
    Ok(out)
}

/// Runs one statement and returns the number of affected rows.
pub fn execute(conn: &Connection, sql: &str, params: &[Param]) -> Result<usize, String> {
    let values = bind(params)?;
    let mut stmt = conn.prepare(sql).map_err(sql_err)?;
    stmt.execute(params_from_iter(values)).map_err(sql_err)
}

/// Runs all statements in one transaction; any failure rolls everything back.
pub fn batch(conn: &mut Connection, statements: &[Statement]) -> Result<Vec<usize>, String> {
    let tx = conn.transaction().map_err(sql_err)?;
    let mut counts = Vec::with_capacity(statements.len());
    for (i, s) in statements.iter().enumerate() {
        let n = execute(&tx, &s.sql, &s.params)
            .map_err(|e| format!("批量操作第 {} 条失败，已全部回滚：{e}", i + 1))?;
        counts.push(n);
    }
    tx.commit().map_err(sql_err)?;
    Ok(counts)
}

/// Paths derived from the data directory.
#[derive(Debug, Clone)]
pub struct DataPaths {
    pub data_dir: PathBuf,
    pub db_path: PathBuf,
    pub backups_dir: PathBuf,
    pub plugins_dir: PathBuf,
}

impl DataPaths {
    pub fn new(data_dir: PathBuf, db_file: &str) -> Self {
        DataPaths {
            db_path: data_dir.join(db_file),
            backups_dir: data_dir.join("backups"),
            plugins_dir: data_dir.join("plugins"),
            data_dir,
        }
    }

    /// Creates the data dir, `backups/` and `plugins/`.
    pub fn ensure(&self) -> Result<(), String> {
        for d in [&self.data_dir, &self.backups_dir, &self.plugins_dir] {
            fs::create_dir_all(d).map_err(|e| format!("无法创建文件夹 {}：{e}", d.display()))?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const BAD: &[Migration] = &[
        (1, include_str!("../migrations/0001_init.sql")),
        (
            2,
            "CREATE TABLE half_done (x INTEGER); INSERT INTO resources_missing VALUES (1);",
        ),
    ];

    fn p(v: Value) -> Param {
        Param(v)
    }

    /// Returns a temp dir and a guarded DB path, or None when `ONEDESK_TEST_DB` is not `1`.
    fn test_db() -> Option<(tempfile::TempDir, PathBuf)> {
        if !test_db_enabled() {
            eprintln!("跳过：需要 {TEST_DB_ENV}=1 才运行会重建数据库的测试");
            return None;
        }
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.db");
        check_test_db_path(&path).unwrap();
        Some((dir, path))
    }

    fn tables(conn: &Connection) -> Vec<String> {
        let mut s = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .unwrap();
        s.query_map([], |r| r.get(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect()
    }

    fn insert_resource(conn: &Connection, id: &str) {
        conn.execute(
            "INSERT INTO resources (id, kind, name, created_at, updated_at) VALUES (?1, 'link', 'n', 't', 't')",
            [id],
        )
        .unwrap();
    }

    #[test]
    fn guard_rejects_real_paths() {
        let home = Path::new("/Users/me/Library/Application Support/onedesk/x.db");
        assert!(check_test_db_path(home).is_err());
        assert!(check_test_db_path(Path::new("/tmp/abc/onedesk.db")).is_err());
        assert!(check_test_db_path(Path::new("/tmp/abc/test.db")).is_ok());
        // Case variants (case-insensitive file systems).
        for p in [
            "/Users/me/Library/application support/OneDesk/x.db",
            "/Users/me/LIBRARY/APPLICATION SUPPORT/ONEDESK/x.db",
            "/tmp/abc/OneDesk.DB",
            "/tmp/abc/ONEDESK.db",
        ] {
            assert!(check_test_db_path(Path::new(p)).is_err(), "{p}");
        }
    }

    #[test]
    fn open_and_migrate_refuses_real_db_names_in_tests() {
        let t = tempfile::tempdir().unwrap();
        for name in ["onedesk.db", "OneDesk.DB"] {
            let path = t.path().join(name);
            let opened = open_and_migrate(&path, &t.path().join("backups"), MIGRATIONS);
            assert!(opened.conn.is_none(), "{name}");
            assert!(opened.migration_error.unwrap().contains("拒绝") || !test_db_enabled());
            assert!(!path.exists(), "{name} must not be created");
        }
        let real = t.path().join("Application Support/onedesk/x.db");
        assert!(open_and_migrate(&real, t.path(), MIGRATIONS).conn.is_none());
    }

    #[test]
    fn migrates_empty_db_to_latest() {
        let Some((_d, path)) = test_db() else { return };
        let mut conn = Connection::open(&path).unwrap();
        assert_eq!(schema_version(&conn).unwrap(), 0);
        assert_eq!(
            migrate(&mut conn, MIGRATIONS).unwrap(),
            latest_version(MIGRATIONS)
        );
        let t = tables(&conn);
        for name in [
            "app_settings",
            "collections",
            "plugin_storage",
            "plugins",
            "resources",
            "schema_version",
            "secret_names",
        ] {
            assert!(t.contains(&name.to_string()), "missing {name}");
        }
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM schema_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 1);
    }

    #[test]
    fn upgrade_from_pre_0001_and_existing_0001_is_idempotent() {
        let Some((_d, path)) = test_db() else { return };
        // Database that predates 0001: a file with no tables at all.
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch("PRAGMA user_version = 0;").unwrap();
        }
        let mut conn = Connection::open(&path).unwrap();
        assert_eq!(migrate(&mut conn, MIGRATIONS).unwrap(), 1);
        insert_resource(&conn, "r1");
        drop(conn);
        // Database that already has 0001 and data: migrating again changes nothing.
        let mut conn = Connection::open(&path).unwrap();
        assert!(!needs_migration(&conn, MIGRATIONS).unwrap());
        assert_eq!(migrate(&mut conn, MIGRATIONS).unwrap(), 1);
        assert_eq!(migrate(&mut conn, MIGRATIONS).unwrap(), 1);
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM resources WHERE id='r1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(n, 1);
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM schema_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 1);
    }

    #[test]
    fn failed_migration_rolls_back() {
        let Some((_d, path)) = test_db() else { return };
        let mut conn = Connection::open(&path).unwrap();
        migrate(&mut conn, MIGRATIONS).unwrap();
        insert_resource(&conn, "keep");
        let err = migrate(&mut conn, BAD).unwrap_err();
        assert!(err.contains("0002") && err.contains("回滚"), "{err}");
        assert_eq!(schema_version(&conn).unwrap(), 1);
        assert!(!tables(&conn).contains(&"half_done".to_string()));
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM resources", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1);
    }

    #[test]
    fn failed_migration_reported_at_startup() {
        let Some((d, path)) = test_db() else { return };
        let opened = open_and_migrate(&path, &d.path().join("backups"), BAD);
        let err = opened.migration_error.expect("should fail");
        assert!(err.contains("0002"), "{err}");
        // 0001 committed, 0002 rolled back.
        assert_eq!(schema_version(opened.conn.as_ref().unwrap()).unwrap(), 1);
    }

    #[test]
    fn rejects_newer_database() {
        let Some((_d, path)) = test_db() else { return };
        let mut conn = Connection::open(&path).unwrap();
        migrate(&mut conn, MIGRATIONS).unwrap();
        conn.execute("UPDATE schema_version SET version = 99", [])
            .unwrap();
        assert!(migrate(&mut conn, MIGRATIONS).unwrap_err().contains("高于"));
    }

    #[test]
    fn snapshot_keeps_seven() {
        let Some((d, path)) = test_db() else { return };
        let backups = d.path().join("backups");
        let mut conn = Connection::open(&path).unwrap();
        migrate(&mut conn, MIGRATIONS).unwrap();
        insert_resource(&conn, "r1");
        for i in 0..10 {
            let t = UtcTime::from_unix_millis(1_700_000_000_000 + i * 1000);
            snapshot(&conn, &backups, t, BACKUPS_KEPT).unwrap();
        }
        let list = list_backups(&backups);
        assert_eq!(list.len(), 7);
        assert_eq!(list[0], "onedesk-20231114-221329.db");
        assert_eq!(list[6], "onedesk-20231114-221323.db");
        // Same second twice → unique name.
        let t = UtcTime::from_unix_millis(1_700_000_009_000);
        assert_eq!(
            snapshot(&conn, &backups, t, BACKUPS_KEPT).unwrap(),
            "onedesk-20231114-221329-2.db"
        );
        // Snapshot is a usable copy.
        let copy = Connection::open(backups.join(&list[0])).unwrap();
        let n: i64 = copy
            .query_row("SELECT COUNT(*) FROM resources", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1);
    }

    #[test]
    fn startup_snapshots_existing_db_only() {
        let Some((d, path)) = test_db() else { return };
        let backups = d.path().join("backups");
        let first = open_and_migrate(&path, &backups, MIGRATIONS);
        assert!(first.migration_error.is_none());
        assert!(list_backups(&backups).is_empty());
        drop(first);
        let second = open_and_migrate(&path, &backups, MIGRATIONS);
        assert!(second.migration_error.is_none());
        assert_eq!(list_backups(&backups).len(), 1);
    }

    #[test]
    fn select_execute_and_param_binding() {
        let mut conn = Connection::open_in_memory().unwrap();
        migrate(&mut conn, MIGRATIONS).unwrap();
        let n = execute(
            &conn,
            "INSERT INTO resources (id, kind, name, created_at, updated_at, version, ai_visible) VALUES (?, ?, ?, ?, ?, ?, ?)",
            &[p(json!("a")), p(json!("link")), p(json!("名字")), p(json!("t")), p(json!("t")), p(json!(3.0)), p(json!(1))],
        )
        .unwrap();
        assert_eq!(n, 1);
        let rows = select(
            &conn,
            "SELECT id, name, version, typeof(version) AS vt, 1.5 AS f, NULL AS z FROM resources WHERE id = ?",
            &[p(json!("a"))],
        )
        .unwrap();
        assert_eq!(
            rows,
            vec![
                json!({"id": "a", "name": "名字", "version": 3, "vt": "integer", "f": 1.5, "z": null})
            ]
        );
        assert!(select(&conn, "SELECT ?", &[p(json!([1]))]).is_err());
        assert!(execute(&conn, "INSERT INTO nope VALUES (1)", &[]).is_err());
    }

    #[test]
    fn batch_commits_or_rolls_back() {
        let mut conn = Connection::open_in_memory().unwrap();
        migrate(&mut conn, MIGRATIONS).unwrap();
        let ins = |k: &str| Statement {
            sql: "INSERT INTO app_settings (key, value) VALUES (?, 'v')".into(),
            params: vec![p(json!(k))],
        };
        let ok = batch(&mut conn, &[ins("a"), ins("b")]).unwrap();
        assert_eq!(ok, vec![1, 1]);
        let err = batch(&mut conn, &[ins("c"), ins("a")]).unwrap_err();
        assert!(err.contains("第 2 条"), "{err}");
        let rows = select(&conn, "SELECT key FROM app_settings ORDER BY key", &[]).unwrap();
        assert_eq!(rows, vec![json!({"key": "a"}), json!({"key": "b"})]);
    }
}
