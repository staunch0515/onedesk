//! Secrets: values only in the macOS Keychain (service "onedesk", account = name); names indexed in
//! `secret_names` (D14, D53). Secret values are never logged or written to the database.
//!
//! Keychain calls and index writes are separate functions so callers can make the (possibly slow, possibly
//! prompting) Keychain call without holding the database lock; see `AppState::secret_*` in commands.rs.

use rusqlite::{params, Connection};

use crate::time::UtcTime;

pub const SERVICE: &str = "onedesk";

/// Where secret values live. The real implementation is the Keychain; tests use an in-memory map.
pub trait SecretBackend: Send + Sync {
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

/// Secret names: non-empty, no surrounding whitespace, at most 128 characters.
pub fn check_name(name: &str) -> Result<(), String> {
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

/// Adds a name to the index (no-op when present). Only the name and a timestamp are stored.
pub fn index_add(conn: &Connection, name: &str) -> Result<(), String> {
    conn.execute(
        "INSERT OR IGNORE INTO secret_names (name, created_at) VALUES (?1, ?2)",
        params![name, UtcTime::now().iso()],
    )
    .map_err(db_err)?;
    Ok(())
}

pub fn index_remove(conn: &Connection, name: &str) -> Result<(), String> {
    conn.execute("DELETE FROM secret_names WHERE name = ?1", [name])
        .map_err(db_err)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn name_rules() {
        assert!(check_name("github_token").is_ok());
        assert!(check_name("").is_err());
        assert!(check_name(" a").is_err());
        assert!(check_name(&"x".repeat(129)).is_err());
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
