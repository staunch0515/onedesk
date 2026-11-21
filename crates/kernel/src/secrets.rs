//! Secrets (kernel-design §7.5, D305–D306): values live only in the keychain; the database,
//! history, audit and search hold names. Plugins get values substituted (`{{secret:name}}`), or —
//! with a separate, declared permission — in plain text, scrubbed from run output afterwards.

use std::collections::{BTreeSet, HashMap};
use std::sync::{Arc, Mutex};

use onedesk_protocol::*;
use serde_json::{json, Value};

use crate::kernel::Inner;
use crate::manifest::{valid_secret_name, Plugin};
use crate::pipeline::{Actor, Command};
use crate::sandbox::CallInfo;
use crate::store;
use crate::util::*;

/// Where secret values are kept. `account` is `<workspace id>/<name>`.
pub trait SecretStore: Send + Sync {
    fn get(&self, account: &str) -> Result<Option<String>, String>;
    fn set(&self, account: &str, value: &str) -> Result<(), String>;
    fn delete(&self, account: &str) -> Result<(), String>;
    /// Deletes every entry whose account starts with `prefix` (the main process removes `<workspace id>/` when it
    /// deletes a workspace, without opening its database, D404). Returns how many went.
    fn delete_prefix(&self, prefix: &str) -> Result<usize, String>;
}

/// The macOS keychain (generic passwords of one service).
pub struct KeychainStore {
    pub service: String,
}

impl SecretStore for KeychainStore {
    fn get(&self, account: &str) -> Result<Option<String>, String> {
        let e = keyring::Entry::new(&self.service, account).map_err(|e| e.to_string())?;
        match e.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }
    fn set(&self, account: &str, value: &str) -> Result<(), String> {
        keyring::Entry::new(&self.service, account).and_then(|e| e.set_password(value)).map_err(|e| e.to_string())
    }
    fn delete(&self, account: &str) -> Result<(), String> {
        let e = keyring::Entry::new(&self.service, account).map_err(|e| e.to_string())?;
        match e.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
    fn delete_prefix(&self, prefix: &str) -> Result<usize, String> {
        let accounts = self.accounts_with_prefix(prefix)?;
        for a in &accounts {
            self.delete(a)?;
        }
        Ok(accounts.len())
    }
}

impl KeychainStore {
    /// The accounts of this service that start with `prefix` (attributes only: no secret value is read, so no prompt).
    fn accounts_with_prefix(&self, prefix: &str) -> Result<Vec<String>, String> {
        use security_framework::item::{ItemClass, ItemSearchOptions, Limit};
        /// errSecItemNotFound: nothing stored under this service.
        const NOT_FOUND: i32 = -25300;
        let found = ItemSearchOptions::new().class(ItemClass::generic_password()).service(&self.service).load_attributes(true).limit(Limit::All).search();
        let results = match found {
            Ok(r) => r,
            Err(e) if e.code() == NOT_FOUND => return Ok(Vec::new()),
            Err(e) => return Err(e.to_string()),
        };
        Ok(results.iter().filter_map(|r| r.simplify_dict()).filter_map(|d| d.get("acct").cloned()).filter(|a| a.starts_with(prefix)).collect())
    }
}

/// In memory (tests, and `ONEDESK_SECRET_STORE=memory`). Never touches the keychain.
#[derive(Default)]
pub struct MemoryStore(Mutex<HashMap<String, String>>);

impl MemoryStore {
    pub fn accounts(&self) -> Vec<String> {
        let mut v: Vec<String> = self.0.lock().unwrap().keys().cloned().collect();
        v.sort();
        v
    }
}

impl SecretStore for MemoryStore {
    fn get(&self, account: &str) -> Result<Option<String>, String> {
        Ok(self.0.lock().unwrap().get(account).cloned())
    }
    fn set(&self, account: &str, value: &str) -> Result<(), String> {
        self.0.lock().unwrap().insert(account.into(), value.into());
        Ok(())
    }
    fn delete(&self, account: &str) -> Result<(), String> {
        self.0.lock().unwrap().remove(account);
        Ok(())
    }
    fn delete_prefix(&self, prefix: &str) -> Result<usize, String> {
        let mut map = self.0.lock().unwrap();
        let before = map.len();
        map.retain(|k, _| !k.starts_with(prefix));
        Ok(before - map.len())
    }
}

/// A cloneable handle (KernelConfig derives Clone/Debug).
#[derive(Clone)]
pub struct SecretStoreHandle(pub Arc<dyn SecretStore>);

impl std::fmt::Debug for SecretStoreHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SecretStore")
    }
}

impl SecretStoreHandle {
    pub fn memory() -> (SecretStoreHandle, Arc<MemoryStore>) {
        let m = Arc::new(MemoryStore::default());
        (SecretStoreHandle(m.clone()), m)
    }

    /// D305: service `onedesk` (release) or `onedesk-dev` (debug builds); `ONEDESK_SECRET_STORE=memory`
    /// keeps everything in memory (process tests).
    pub fn from_env() -> SecretStoreHandle {
        if std::env::var("ONEDESK_SECRET_STORE").is_ok_and(|v| v == "memory") {
            return Self::memory().0;
        }
        let service = if cfg!(debug_assertions) { "onedesk-dev" } else { "onedesk" };
        SecretStoreHandle(Arc::new(KeychainStore { service: service.into() }))
    }
}

/// `{{secret:name}}` references in a text.
pub fn references(text: &str) -> Vec<String> {
    reference_specs(text).into_iter().map(|r| r.name).collect()
}

/// One `{{secret:<name>}}` in a text. Round 17: `{{secret:<name>|base64}}` puts the value in
/// base64; `{{secret:<name>|basic:<user>}}` puts `<user>:<value>` in base64 (HTTP Basic). The
/// plugin never sees the value either way.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reference {
    /// The whole `{{…}}` as written.
    pub token: String,
    pub name: String,
    pub encode: Encode,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Encode {
    Plain,
    Base64,
    Basic(String),
    /// D433: percent-encoded (a query parameter's value).
    Url,
    /// A modifier the kernel does not know (refused when substituted).
    Unknown,
}

pub fn reference_specs(text: &str) -> Vec<Reference> {
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(i) = rest.find("{{secret:") {
        let after = &rest[i + 9..];
        match after.find("}}") {
            Some(j) => {
                let inner = &after[..j];
                let (name, encode) = match inner.split_once('|') {
                    None => (inner, Encode::Plain),
                    Some((n, "base64")) => (n, Encode::Base64),
                    Some((n, "url")) => (n, Encode::Url),
                    Some((n, m)) => match m.strip_prefix("basic:") {
                        Some(user) if !user.contains(':') => (n, Encode::Basic(user.to_string())),
                        _ => (n, Encode::Unknown),
                    },
                };
                out.push(Reference { token: format!("{{{{secret:{inner}}}}}"), name: name.trim().to_string(), encode });
                rest = &after[j + 2..];
            }
            None => break,
        }
    }
    out
}

/// D433: percent-encoding of everything but RFC 3986's unreserved characters.
pub fn percent(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// Standard base64 with padding (RFC 4648 §4).
pub fn base64(bytes: &[u8]) -> String {
    const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for c in bytes.chunks(3) {
        let n = (u32::from(c[0]) << 16) | (u32::from(*c.get(1).unwrap_or(&0)) << 8) | u32::from(*c.get(2).unwrap_or(&0));
        out.push(A[(n >> 18) as usize & 63] as char);
        out.push(A[(n >> 12) as usize & 63] as char);
        out.push(if c.len() > 1 { A[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if c.len() > 2 { A[n as usize & 63] as char } else { '=' });
    }
    out
}

/// Replaces every known secret value in all strings of `v` by `***` (§7.5: a remedy, not a guarantee).
pub fn scrub(v: &mut Value, values: &[String]) {
    match v {
        Value::String(s) => {
            for val in values.iter().filter(|x| x.len() >= 3) {
                if s.contains(val.as_str()) {
                    *s = s.replace(val.as_str(), "***");
                }
            }
        }
        Value::Array(a) => a.iter_mut().for_each(|x| scrub(x, values)),
        Value::Object(o) => o.values_mut().for_each(|x| scrub(x, values)),
        _ => {}
    }
}

impl Inner {
    fn account(&self, name: &str) -> String {
        format!("{}/{name}", self.ws.id)
    }

    /// The value of a secret (cached in memory for the life of the worker, §7.5).
    pub fn secret_value(&self, name: &str) -> KResult<Option<String>> {
        if let Some(v) = self.secret_cache.lock().unwrap().get(name) {
            return Ok(Some(v.clone()));
        }
        let known = self.read(|c| c.query_row("SELECT EXISTS(SELECT 1 FROM secret_names WHERE name = ?1)", [name], |r| r.get::<_, bool>(0)))?;
        if !known {
            return Ok(None);
        }
        let v = self.cfg.secrets.0.get(&self.account(name)).map_err(|e| err_d(ErrorCode::Internal, e))?;
        if let Some(v) = &v {
            self.secret_cache.lock().unwrap().insert(name.into(), v.clone());
        }
        Ok(v)
    }

    pub async fn secret_set(&self, name: &str, value: &str, audit: bool) -> KResult<()> {
        if !valid_secret_name(name) {
            return Err(invalid("badSecretName"));
        }
        self.cfg.secrets.0.set(&self.account(name), value).map_err(|e| err_d(ErrorCode::Internal, e))?;
        self.secret_cache.lock().unwrap().insert(name.into(), value.into());
        self.pipeline.execute(Actor::User, Command::SecretName { name: name.into(), present: true, audit }).await?;
        Ok(())
    }

    pub async fn secret_delete(&self, name: &str, audit: bool) -> KResult<()> {
        self.cfg.secrets.0.delete(&self.account(name)).map_err(|e| err_d(ErrorCode::Internal, e))?;
        self.secret_cache.lock().unwrap().remove(name);
        self.pipeline.execute(Actor::User, Command::SecretName { name: name.into(), present: false, audit }).await?;
        Ok(())
    }

    pub fn secrets_list(&self) -> KResult<Vec<SecretInfo>> {
        let rows: Vec<(String, i64)> = self.read(|c| {
            let mut st = c.prepare("SELECT name, updated_at FROM secret_names ORDER BY name")?;
            let v = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
            v.collect()
        })?;
        let plugins = self.registry.plugins();
        Ok(rows
            .into_iter()
            .map(|(name, updated_at)| {
                let mut used_by: Vec<String> = plugins
                    .iter()
                    .filter(|p| p.manifest.requires.secrets.as_ref().is_some_and(|s| s.names.contains(&name)))
                    .map(|p| p.id.clone())
                    .collect();
                // Resources that point at it (form secret fields `{secret: name}`, secret parameters).
                let pattern = format!("%\"{}\"%", name.replace('%', "").replace('_', "\\_"));
                let refs: Vec<String> = self
                    .read(|c| {
                        let mut st = c.prepare("SELECT id FROM resources WHERE deleted_at IS NULL AND body LIKE ?1 ESCAPE '\\'")?;
                        let v = st.query_map([&pattern], |r| r.get(0))?;
                        v.collect()
                    })
                    .unwrap_or_default();
                used_by.extend(refs);
                SecretInfo { name, updated_at, used_by }
            })
            .collect())
    }

    /// Secret names a plugin version may use in one call: its manifest's, plus — when the call is
    /// about one of its own resources — the names that resource *as saved* points at (secret
    /// fields, and `{{secret:…}}` in text fields declared `"secrets": true`; D306, D318).
    pub fn plugin_secret_names(&self, p: &Plugin, resource: Option<&str>) -> KResult<BTreeSet<String>> {
        let mut names: BTreeSet<String> = p.manifest.requires.secrets.as_ref().map(|s| s.names.iter().cloned().collect()).unwrap_or_default();
        let Some(r) = resource.and_then(|id| self.read(|c| store::get(c, id)).ok().flatten()) else { return Ok(names) };
        let Some((pid, short)) = crate::manifest::Registry::split(&r.kind) else { return Ok(names) };
        if pid != p.id {
            return Ok(names);
        }
        let Some(k) = self.registry.kind_at(&r.kind, r.plugin_version.as_deref()).map(|(_, k)| k).or_else(|| p.kind(short)) else {
            return Ok(names);
        };
        names.extend(resource_secret_names(k, &r.body));
        Ok(names)
    }

    /// Replaces `{{secret:name}}` in `text`; a name the plugin may not use, or that does not exist,
    /// refuses the whole call. Returns the text and the values used (to scrub responses).
    pub fn substitute(&self, p: &Plugin, text: &str, allowed: &BTreeSet<String>, used: &mut Vec<String>) -> KResult<String> {
        let mut out = text.to_string();
        for r in reference_specs(text) {
            if !allowed.contains(&r.name) {
                return Err(denied("secretNotAllowed"));
            }
            if r.encode == Encode::Unknown {
                return Err(invalid("badSecretFormat"));
            }
            let v = self.secret_value(&r.name)?.ok_or_else(|| denied("unknownSecret"))?;
            let put = match &r.encode {
                Encode::Plain | Encode::Unknown => v.clone(),
                Encode::Base64 => base64(v.as_bytes()),
                Encode::Basic(user) => base64(format!("{user}:{v}").as_bytes()),
                Encode::Url => percent(&v),
            };
            out = out.replace(&r.token, &put);
            // Both are scrubbed from what comes back (the encoded form is what a server echoes).
            if put != v {
                used.push(put);
            }
            used.push(v);
        }
        let _ = p;
        Ok(out)
    }

    /// `ctx.host.secrets.get(name)`: only with `requires.secrets.plaintext` (§7.5).
    pub async fn host_secret_get(&self, p: &Plugin, info: &CallInfo, args: &Value) -> KResult<Value> {
        if !p.manifest.requires.secrets.as_ref().is_some_and(|s| s.plaintext) {
            return Err(denied("plaintextUndeclared"));
        }
        let name = args.get(0).and_then(Value::as_str).ok_or_else(|| invalid_params("name"))?.to_string();
        if !self.plugin_secret_names(p, info.resource_id.as_deref())?.contains(&name) {
            return Err(denied("secretNotAllowed"));
        }
        let v = self.secret_value(&name)?.ok_or_else(|| denied("unknownSecret"))?;
        // Remembered for this run: its output, progress and summary get the value scrubbed.
        if let Some(run) = &info.run_id {
            if let Some(a) = self.runs_active.lock().unwrap().get_mut(run) {
                a.secrets.push(v.clone());
            }
        }
        Ok(json!(v))
    }

    /// Secret fields of a kind (body keys declared `{"type": "secret"}`), for a resource or `new:` kind.
    pub fn secret_fields(&self, kind: &str, version: Option<&str>) -> Vec<String> {
        self.registry
            .kind_at(kind, version)
            .map(|(_, k)| k.fields.iter().filter(|(_, f)| f.ty == crate::manifest::DeclType::Secret).map(|(n, _)| format!("body.{n}")).collect())
            .unwrap_or_default()
    }

    /// D306: secret field values are taken out of `changes` (the resource keeps `{secret: <name>}`)
    /// and returned as `(name, value)` to write to the keychain once the database change is
    /// committed (review #14). An empty value leaves the stored secret as it is.
    pub fn take_secret_fields(&self, resource_id: &str, fields: &[String], changes: &mut JsonMap, current: Option<&JsonMap>) -> KResult<Vec<(String, String)>> {
        let mut pending = Vec::new();
        for path in fields {
            let Some(v) = changes.remove(path) else { continue };
            let key = &path["body.".len()..];
            let value = match &v {
                Value::String(s) => s.clone(),
                // Already a reference (e.g. sent back unchanged): keep as is.
                Value::Object(o) if o.contains_key("secret") => {
                    changes.insert(path.clone(), v.clone());
                    continue;
                }
                Value::Null | Value::Bool(_) => continue,
                other => other.to_string(),
            };
            if value.is_empty() {
                continue;
            }
            let name = current
                .and_then(|b| b.get(key))
                .and_then(|x| x.get("secret"))
                .and_then(Value::as_str)
                .map(String::from)
                .unwrap_or_else(|| format!("{resource_id}.{key}"));
            if !valid_secret_name(&name) {
                return Err(invalid("badSecretName"));
            }
            changes.insert(path.clone(), json!({ "secret": name.clone() }));
            pending.push((name, value));
        }
        Ok(pending)
    }

    /// Writes taken secret values after the commit; a failure is reported (the field counts as not saved).
    pub async fn write_secrets(&self, pending: Vec<(String, String)>) -> KResult<()> {
        for (name, value) in pending {
            self.secret_set(&name, &value, false).await?;
        }
        Ok(())
    }

    /// Secrets owned by resources (`<resource id>.<field>`), removed with a permanent deletion.
    pub async fn delete_owned_secrets(&self, ids: &[String]) {
        for id in ids {
            let pattern = format!("{}.%", id.replace('%', "").replace('_', "\\_"));
            let names: Vec<String> = self
                .read(|c| {
                    let mut st = c.prepare("SELECT name FROM secret_names WHERE name LIKE ?1 ESCAPE '\\'")?;
                    let v = st.query_map([&pattern], |r| r.get(0))?;
                    v.collect()
                })
                .unwrap_or_default();
            for n in names {
                let _ = self.secret_delete(&n, true).await;
            }
        }
    }
}

/// Secret names a resource body points at: secret fields (`{secret: name}`) and references in
/// text fields that may hold them (D318).
pub fn resource_secret_names(k: &crate::manifest::KindDecl, body: &JsonMap) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    for (name, f) in &k.fields {
        let Some(v) = body.get(name) else { continue };
        if f.ty == crate::manifest::DeclType::Secret {
            if let Some(n) = v.get("secret").and_then(Value::as_str) {
                out.insert(n.to_string());
            }
        } else if f.secrets {
            if let Some(text) = v.as_str() {
                out.extend(references(text));
            }
        }
    }
    out
}

#[cfg(test)]
mod prefix_tests {
    use super::*;

    #[test]
    fn round17_basic_and_base64_references() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"Aladdin:open sesame"), "QWxhZGRpbjpvcGVuIHNlc2FtZQ==");
        let r = reference_specs("Basic {{secret:pw|basic:Aladdin}} and {{secret:tok|base64}} {{secret:x}} {{secret:y|rot13}} {{secret:z|basic:a:b}}");
        assert_eq!(r[0], Reference { token: "{{secret:pw|basic:Aladdin}}".into(), name: "pw".into(), encode: Encode::Basic("Aladdin".into()) });
        assert_eq!(r[1].encode, Encode::Base64);
        assert_eq!((r[2].name.as_str(), &r[2].encode), ("x", &Encode::Plain));
        assert_eq!(r[3].encode, Encode::Unknown);
        assert_eq!(r[4].encode, Encode::Unknown, "a user name cannot hold ':'");
        assert_eq!(references("{{secret:pw|basic:u}}"), vec!["pw".to_string()]);
        // D433.
        assert_eq!(reference_specs("{{secret:k|url}}")[0].encode, Encode::Url);
        assert_eq!(percent("a b&c=d/é~"), "a%20b%26c%3Dd%2F%C3%A9~");
    }

    #[test]
    fn the_memory_store_deletes_by_prefix_and_leaves_other_workspaces_alone() {
        let (handle, memory) = SecretStoreHandle::memory();
        for a in ["ws1/token", "ws1/key", "ws10/token", "ws2/token"] {
            handle.0.set(a, "v").unwrap();
        }
        assert_eq!(handle.0.delete_prefix("ws1/").unwrap(), 2);
        assert_eq!(memory.accounts(), ["ws10/token", "ws2/token"]);
        assert_eq!(handle.0.delete_prefix("ws1/").unwrap(), 0);
    }
}
