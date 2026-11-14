//! Secrets: values only in the macOS Keychain (service "onedesk", account = name); names indexed in
//! `secret_names` (D14, D53). Secret values are never logged or written to the database.

use rusqlite::{params, Connection};

use crate::time::UtcTime;

pub const SERVICE: &str = "onedesk";

/// Where secret values live. The real implementation is the Keychain; tests use an in-memory map.
pub trait SecretBackend {
    fn get(&self, name: &str) -> Result<Option<String>, String>;
    fn set(&self, name: &str, value: &str) -> Result<(), String>;
    /// Deleting a missing entry is not an error.
    fn delete(&self, name: &str) -> Result<(), String>;
}

/// macOS Keychain via `keyring`.
pub struct Keychain;

impl Keychain {
    fn entry(name: &str) -> Result<keyring::Entry, String> {
        keyring::Entry::new(SERVICE, name).map_err(|e| format!("无法访问钥匙串：{e}"))
    }
}

impl SecretBackend for Keychain {
    fn get(&self, name: &str) -> Result<Option<String>, String> {
        match Self::entry(name)?.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(format!("读取钥匙串失败：{e}")),
        }
    }

    fn set(&self, name: &str, value: &str) -> Result<(), String> {
        Self::entry(name)?
            .set_password(value)
            .map_err(|e| format!("写入钥匙串失败：{e}"))
    }

    fn delete(&self, name: &str) -> Result<(), String> {
        match Self::entry(name)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(format!("删除钥匙串项失败：{e}")),
        }
    }
}

fn check_name(name: &str) -> Result<(), String> {
    if name.trim().is_empty() || name.trim() != name {
        return Err("密钥名不能为空，且首尾不能有空格。".into());
    }
    if name.chars().count() > 128 {
        return Err("密钥名不能超过 128 个字符。".into());
    }
    Ok(())
}

fn db_err(e: rusqlite::Error) -> String {
    format!("读写密钥索引失败：{e}")
}

pub fn list(conn: &Connection) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare("SELECT name FROM secret_names ORDER BY name")
        .map_err(db_err)?;
    let names = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(db_err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_err)?;
    Ok(names)
}

pub fn get(backend: &dyn SecretBackend, name: &str) -> Result<Option<String>, String> {
    check_name(name)?;
    backend.get(name)
}

/// Writes the Keychain first, then the index, so the index never names a value that was not stored.
pub fn set(
    conn: &Connection,
    backend: &dyn SecretBackend,
    name: &str,
    value: &str,
) -> Result<(), String> {
    check_name(name)?;
    backend.set(name, value)?;
    conn.execute(
        "INSERT OR IGNORE INTO secret_names (name, created_at) VALUES (?1, ?2)",
        params![name, UtcTime::now().iso()],
    )
    .map_err(db_err)?;
    Ok(())
}

pub fn delete(conn: &Connection, backend: &dyn SecretBackend, name: &str) -> Result<(), String> {
    check_name(name)?;
    backend.delete(name)?;
    conn.execute("DELETE FROM secret_names WHERE name = ?1", [name])
        .map_err(db_err)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{migrate, MIGRATIONS};
    use std::cell::RefCell;
    use std::collections::HashMap;

    #[derive(Default)]
    struct Memory(RefCell<HashMap<String, String>>);

    impl SecretBackend for Memory {
        fn get(&self, name: &str) -> Result<Option<String>, String> {
            Ok(self.0.borrow().get(name).cloned())
        }
        fn set(&self, name: &str, value: &str) -> Result<(), String> {
            self.0.borrow_mut().insert(name.into(), value.into());
            Ok(())
        }
        fn delete(&self, name: &str) -> Result<(), String> {
            self.0.borrow_mut().remove(name);
            Ok(())
        }
    }

    struct Failing;
    impl SecretBackend for Failing {
        fn get(&self, _: &str) -> Result<Option<String>, String> {
            Err("x".into())
        }
        fn set(&self, _: &str, _: &str) -> Result<(), String> {
            Err("写入钥匙串失败".into())
        }
        fn delete(&self, _: &str) -> Result<(), String> {
            Err("x".into())
        }
    }

    fn conn() -> Connection {
        let mut c = Connection::open_in_memory().unwrap();
        migrate(&mut c, MIGRATIONS).unwrap();
        c
    }

    #[test]
    fn index_tracks_names_but_never_values() {
        let c = conn();
        let m = Memory::default();
        set(&c, &m, "github_token", "s3cret-value").unwrap();
        set(&c, &m, "github_token", "s3cret-value-2").unwrap();
        set(&c, &m, "a_key", "v").unwrap();
        assert_eq!(list(&c).unwrap(), vec!["a_key", "github_token"]);
        assert_eq!(
            get(&m, "github_token").unwrap().as_deref(),
            Some("s3cret-value-2")
        );
        let dump: String = c
            .query_row(
                "SELECT group_concat(name || created_at) FROM secret_names",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(!dump.contains("s3cret"));
        delete(&c, &m, "github_token").unwrap();
        assert_eq!(list(&c).unwrap(), vec!["a_key"]);
        assert_eq!(get(&m, "github_token").unwrap(), None);
        assert!(set(&c, &m, " ", "v").is_err());
    }

    #[test]
    fn keychain_failure_leaves_index_untouched() {
        let c = conn();
        assert!(set(&c, &Failing, "k", "v").is_err());
        assert!(list(&c).unwrap().is_empty());
    }

    /// Writes to the user's real Keychain; run manually with `cargo test -- --ignored`.
    #[test]
    #[ignore]
    fn real_keychain_roundtrip() {
        let name = "onedesk-test-roundtrip";
        let k = Keychain;
        k.set(name, "value").unwrap();
        assert_eq!(k.get(name).unwrap().as_deref(), Some("value"));
        k.delete(name).unwrap();
        assert_eq!(k.get(name).unwrap(), None);
        k.delete(name).unwrap();
    }
}
