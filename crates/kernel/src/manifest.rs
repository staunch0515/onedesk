//! Plugin packages: `<plugins>/<id>/<version>/manifest.json` (manifest v2, week-1 subset, D267).
//! Validation is strict: unknown or missing fields, a wrong `apiVersion`, an id or version that
//! does not match its folder, dangling references — the package is not loaded.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};

use onedesk_protocol::{ActionRole, JsonMap, Label, TreeSource};
use serde::Deserialize;

use crate::pipeline::KindRule;
use crate::store::TREE_RESOURCES;

/// Kernel names a manifest may reference with their full name.
pub const KERNEL_COMMANDS: &[&str] = &["plugin.grantFolder", "node.newGroup"];
pub const KERNEL_TREES: &[&str] = &[TREE_RESOURCES];

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub id: String,
    pub version: String,
    pub api_version: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    pub icon: String,
    pub main: String,
    #[serde(default)]
    pub requires: Requires,
    #[serde(default)]
    pub contributes: Contributes,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Requires {
    #[serde(default)]
    pub files: bool,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Contributes {
    #[serde(default)]
    pub kinds: Vec<KindDecl>,
    #[serde(default)]
    pub pages: Vec<PageDecl>,
    #[serde(default)]
    pub trees: Vec<TreeDecl>,
    #[serde(default)]
    pub commands: Vec<CommandDecl>,
    #[serde(default)]
    pub menus: Menus,
    #[serde(default)]
    pub locales: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KindDecl {
    pub id: String,
    pub label: String,
    pub icon: String,
    #[serde(default)]
    pub tree: Option<String>,
    #[serde(default)]
    pub page: Option<String>,
    #[serde(default)]
    pub new_name: Option<String>,
    #[serde(default)]
    pub defaults: JsonMap,
    #[serde(default)]
    pub draggable: bool,
    #[serde(default)]
    pub accepts: Vec<String>,
    #[serde(default)]
    pub menu: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PageDecl {
    pub id: String,
    #[serde(default)]
    pub actions: Vec<ActionDeclM>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActionDeclM {
    pub id: String,
    pub role: ActionRole,
    pub label: String,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub primary: Option<bool>,
    #[serde(default)]
    pub danger: Option<bool>,
    #[serde(default)]
    pub shortcut: Option<Vec<String>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TreeDecl {
    pub id: String,
    pub label: String,
    pub icon: String,
    pub source: TreeSource,
    #[serde(default)]
    pub page: Option<String>,
    #[serde(default)]
    pub toolbar: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommandDecl {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub icon: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Menus {
    #[serde(default)]
    pub new: Vec<String>,
}

/// A loaded, validated plugin package.
#[derive(Debug, Clone)]
pub struct Plugin {
    pub id: String,
    pub version: String,
    pub dir: PathBuf,
    pub manifest: Manifest,
    /// Locale → (key → text).
    pub locales: BTreeMap<String, BTreeMap<String, String>>,
}

impl Plugin {
    pub fn actor(&self) -> crate::pipeline::Actor {
        crate::pipeline::Actor::Plugin { id: self.id.clone(), version: self.version.clone() }
    }

    /// The multi-language form of a manifest text key; the key itself when no locale has it.
    pub fn label(&self, key: &str) -> Label {
        let m: BTreeMap<String, String> =
            self.locales.iter().filter_map(|(loc, t)| t.get(key).map(|v| (loc.clone(), v.clone()))).collect();
        if m.is_empty() {
            Label::Text(key.to_string())
        } else {
            Label::Localized(m)
        }
    }

    /// The text of `key` in `locale`, falling back to `en-US`, then the key.
    pub fn text(&self, key: &str, locale: Option<&str>) -> String {
        locale
            .and_then(|l| self.locales.get(l))
            .and_then(|t| t.get(key))
            .or_else(|| self.locales.get("en-US").and_then(|t| t.get(key)))
            .cloned()
            .unwrap_or_else(|| key.to_string())
    }

    /// Every text key in the package, as `Label`s (handed to the sandbox for `ctx.t`).
    pub fn all_labels(&self) -> BTreeMap<String, Label> {
        let keys: HashSet<&String> = self.locales.values().flat_map(|t| t.keys()).collect();
        keys.into_iter().map(|k| (k.clone(), self.label(k))).collect()
    }

    pub fn full(&self, short: &str) -> String {
        format!("{}:{short}", self.id)
    }

    pub fn kind(&self, short: &str) -> Option<&KindDecl> {
        self.manifest.contributes.kinds.iter().find(|k| k.id == short)
    }
    pub fn page(&self, short: &str) -> Option<&PageDecl> {
        self.manifest.contributes.pages.iter().find(|p| p.id == short)
    }
    pub fn tree(&self, short: &str) -> Option<&TreeDecl> {
        self.manifest.contributes.trees.iter().find(|t| t.id == short)
    }
    pub fn command(&self, short: &str) -> Option<&CommandDecl> {
        self.manifest.contributes.commands.iter().find(|c| c.id == short)
    }

    /// A tree reference from the manifest: kernel trees by full name, own trees by short name.
    pub fn tree_ref(&self, name: &str) -> String {
        if KERNEL_TREES.contains(&name) {
            name.to_string()
        } else {
            self.full(name)
        }
    }

    /// A kind reference (`accepts`): `*`, a full name, or one of this plugin's short names.
    pub fn kind_ref(&self, name: &str) -> String {
        if name == "*" || name.contains(':') {
            name.to_string()
        } else {
            self.full(name)
        }
    }

    /// A command reference: kernel commands by full name, own commands by short name.
    pub fn command_ref(&self, name: &str) -> String {
        if KERNEL_COMMANDS.contains(&name) {
            name.to_string()
        } else {
            self.full(name)
        }
    }
}

/// Why a package was not loaded. `reason` is a stable code, not a sentence.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rejection {
    pub path: PathBuf,
    pub reason: String,
    pub detail: String,
}

fn reject(path: &Path, reason: &str, detail: impl Into<String>) -> Rejection {
    Rejection { path: path.to_path_buf(), reason: reason.into(), detail: detail.into() }
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '-' || c == '_')
        && !id.starts_with('.')
        && !id.ends_with('.')
        && id != "core"
}

fn valid_short(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
}

/// A relative path inside the package (no `..`, not absolute).
fn inside(dir: &Path, rel: &str) -> Option<PathBuf> {
    let p = Path::new(rel);
    if p.is_absolute() || p.components().any(|c| !matches!(c, std::path::Component::Normal(_) | std::path::Component::CurDir)) {
        return None;
    }
    let full = dir.join(p);
    full.is_file().then_some(full)
}

/// Loads and validates the package in `dir` (= `<plugins>/<id>/<version>`).
pub fn load_package(dir: &Path) -> Result<Plugin, Rejection> {
    let folder_version = dir.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let folder_id = dir.parent().and_then(|p| p.file_name()).map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let mpath = dir.join("manifest.json");
    let bytes = std::fs::read(&mpath).map_err(|e| reject(dir, "noManifest", e.to_string()))?;
    let raw: serde_json::Value = serde_json::from_slice(&bytes).map_err(|e| reject(dir, "badJson", e.to_string()))?;
    let m: Manifest = serde_json::from_value(raw).map_err(|e| reject(dir, "schema", e.to_string()))?;

    if m.api_version != "2" {
        return Err(reject(dir, "apiVersion", m.api_version.clone()));
    }
    if !valid_id(&m.id) {
        return Err(reject(dir, "badId", m.id.clone()));
    }
    if m.id != folder_id {
        return Err(reject(dir, "idMismatch", format!("{} in folder {folder_id}", m.id)));
    }
    if semver::Version::parse(&m.version).is_err() {
        return Err(reject(dir, "badVersion", m.version.clone()));
    }
    if m.version != folder_version {
        return Err(reject(dir, "versionMismatch", format!("{} in folder {folder_version}", m.version)));
    }
    if inside(dir, &m.main).is_none() || !m.main.ends_with(".js") {
        return Err(reject(dir, "mainMissing", m.main.clone()));
    }

    let c = &m.contributes;
    let mut seen = HashSet::new();
    for (group, ids) in [
        ("kind", c.kinds.iter().map(|k| k.id.as_str()).collect::<Vec<_>>()),
        ("page", c.pages.iter().map(|p| p.id.as_str()).collect()),
        ("tree", c.trees.iter().map(|t| t.id.as_str()).collect()),
        ("command", c.commands.iter().map(|x| x.id.as_str()).collect()),
    ] {
        for id in ids {
            if !valid_short(id) {
                return Err(reject(dir, "badName", format!("{group} {id}")));
            }
            if !seen.insert((group, id)) {
                return Err(reject(dir, "duplicate", format!("{group} {id}")));
            }
        }
    }
    let has_page = |p: &str| c.pages.iter().any(|x| x.id == p);
    let has_cmd = |x: &str| KERNEL_COMMANDS.contains(&x) || c.commands.iter().any(|y| y.id == x);
    for k in &c.kinds {
        if let Some(p) = &k.page {
            if !has_page(p) {
                return Err(reject(dir, "unknownPage", format!("kind {} page {p}", k.id)));
            }
        }
        if let Some(t) = &k.tree {
            let own_stored = c.trees.iter().any(|x| &x.id == t && x.source == TreeSource::Stored);
            if !KERNEL_TREES.contains(&t.as_str()) && !own_stored {
                return Err(reject(dir, "unknownTree", format!("kind {} tree {t}", k.id)));
            }
        }
        for x in &k.menu {
            if !has_cmd(x) {
                return Err(reject(dir, "unknownCommand", format!("kind {} command {x}", k.id)));
            }
        }
        for a in &k.accepts {
            if a != "*" && !a.contains(':') && !c.kinds.iter().any(|y| &y.id == a) {
                return Err(reject(dir, "unknownKind", format!("kind {} accepts {a}", k.id)));
            }
        }
    }
    for t in &c.trees {
        if let Some(p) = &t.page {
            if !has_page(p) {
                return Err(reject(dir, "unknownPage", format!("tree {} page {p}", t.id)));
            }
        }
        for x in &t.toolbar {
            if !has_cmd(x) {
                return Err(reject(dir, "unknownCommand", format!("tree {} command {x}", t.id)));
            }
        }
    }
    for n in &c.menus.new {
        if !c.kinds.iter().any(|k| &k.id == n) {
            return Err(reject(dir, "unknownKind", format!("menus.new {n}")));
        }
    }

    let mut locales = BTreeMap::new();
    if !c.locales.is_empty() && !c.locales.contains_key("en-US") {
        return Err(reject(dir, "localeMissing", "en-US"));
    }
    for (loc, rel) in &c.locales {
        let p = inside(dir, rel).ok_or_else(|| reject(dir, "badLocale", format!("{loc}: {rel}")))?;
        let table: BTreeMap<String, String> = std::fs::read(&p)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .ok_or_else(|| reject(dir, "badLocale", format!("{loc}: {rel}")))?;
        locales.insert(loc.clone(), table);
    }

    Ok(Plugin { id: m.id.clone(), version: m.version.clone(), dir: dir.to_path_buf(), manifest: m, locales })
}

/// Every valid plugin under the plugins folder (highest version of each id), plus what was refused.
#[derive(Debug, Default)]
pub struct Registry {
    pub plugins: Vec<Plugin>,
    pub rejected: Vec<Rejection>,
}

impl Registry {
    pub fn scan(root: &Path) -> Registry {
        let mut reg = Registry::default();
        let mut best: HashMap<String, Plugin> = HashMap::new();
        let mut ids: Vec<PathBuf> = std::fs::read_dir(root)
            .map(|rd| rd.filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| p.is_dir()).collect())
            .unwrap_or_default();
        ids.sort();
        for id_dir in ids {
            let mut versions: Vec<PathBuf> = std::fs::read_dir(&id_dir)
                .map(|rd| rd.filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| p.is_dir()).collect())
                .unwrap_or_default();
            versions.sort();
            for vdir in versions {
                match load_package(&vdir) {
                    Ok(p) => {
                        let newer = best.get(&p.id).is_none_or(|old| {
                            semver::Version::parse(&p.version).ok() > semver::Version::parse(&old.version).ok()
                        });
                        if newer {
                            best.insert(p.id.clone(), p);
                        }
                    }
                    Err(r) => reg.rejected.push(r),
                }
            }
        }
        let mut plugins: Vec<Plugin> = best.into_values().collect();
        plugins.sort_by(|a, b| a.id.cmp(&b.id));
        reg.plugins = plugins;
        reg
    }

    pub fn plugin(&self, id: &str) -> Option<&Plugin> {
        self.plugins.iter().find(|p| p.id == id)
    }

    /// Splits `<pluginId>:<name>` (plugin ids contain no `:`).
    pub fn split(full: &str) -> Option<(&str, &str)> {
        full.split_once(':')
    }

    pub fn kind(&self, full: &str) -> Option<(&Plugin, &KindDecl)> {
        let (pid, k) = Self::split(full)?;
        let p = self.plugin(pid)?;
        Some((p, p.kind(k)?))
    }

    pub fn tree(&self, full: &str) -> Option<(&Plugin, &TreeDecl)> {
        let (pid, t) = Self::split(full)?;
        let p = self.plugin(pid)?;
        Some((p, p.tree(t)?))
    }

    /// Write rules of every plugin kind (tree and accepted children, full names).
    pub fn rules(&self) -> HashMap<String, KindRule> {
        let mut m = crate::pipeline::core_rules();
        for p in &self.plugins {
            for k in &p.manifest.contributes.kinds {
                m.insert(
                    p.full(&k.id),
                    KindRule {
                        tree: k.tree.as_deref().map(|t| p.tree_ref(t)),
                        accepts: k.accepts.iter().map(|a| p.kind_ref(a)).collect(),
                    },
                );
            }
        }
        m
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn good() -> Value {
        json!({
            "id": "test.alpha", "version": "0.1.0", "apiVersion": "2", "name": "plugin.name", "icon": "box",
            "main": "main.js", "requires": { "files": true },
            "contributes": {
                "kinds": [{ "id": "item", "label": "kind.item", "icon": "box", "tree": "resources", "page": "editor",
                            "newName": "kind.item.new", "defaults": { "text": "" }, "draggable": true,
                            "accepts": [], "menu": ["dup"] }],
                "pages": [{ "id": "editor", "actions": [{ "id": "save", "role": "save", "label": "action.save" }] }],
                "trees": [{ "id": "disk", "label": "tree.disk", "icon": "folder", "source": "provided", "page": "editor",
                            "toolbar": ["plugin.grantFolder"] }],
                "commands": [{ "id": "dup", "label": "command.dup" }],
                "menus": { "new": ["item"] },
                "locales": { "en-US": "locales/en-US.json" }
            }
        })
    }

    fn write(root: &Path, folder_id: &str, folder_ver: &str, m: &Value) -> PathBuf {
        let dir = root.join(folder_id).join(folder_ver);
        std::fs::create_dir_all(dir.join("locales")).unwrap();
        std::fs::write(dir.join("manifest.json"), serde_json::to_vec(m).unwrap()).unwrap();
        std::fs::write(dir.join("main.js"), "export default { activate() {} };").unwrap();
        std::fs::write(dir.join("locales/en-US.json"), r#"{"kind.item":"Item"}"#).unwrap();
        dir
    }

    fn reason(m: Value) -> String {
        reason_in("test.alpha", "0.1.0", m)
    }

    fn reason_in(fid: &str, fver: &str, m: Value) -> String {
        let tmp = tempfile::tempdir().unwrap();
        let dir = write(tmp.path(), fid, fver, &m);
        match load_package(&dir) {
            Ok(_) => "ok".into(),
            Err(r) => r.reason,
        }
    }

    fn with(mut m: Value, path: &[&str], v: Value) -> Value {
        let parent: String = path[..path.len() - 1].iter().map(|p| format!("/{p}")).collect();
        let last = path[path.len() - 1];
        match m.pointer_mut(&parent).unwrap() {
            Value::Array(a) => a[last.parse::<usize>().unwrap()] = v,
            Value::Object(o) => {
                o.insert(last.to_string(), v);
            }
            _ => panic!("bad path"),
        }
        m
    }

    fn without(mut m: Value, key: &str) -> Value {
        m.as_object_mut().unwrap().remove(key);
        m
    }

    #[test]
    fn valid_manifest_loads_with_localized_labels() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = write(tmp.path(), "test.alpha", "0.1.0", &good());
        let p = load_package(&dir).unwrap();
        assert_eq!(p.label("kind.item"), Label::Localized(BTreeMap::from([("en-US".into(), "Item".into())])));
        assert_eq!(p.label("missing.key"), Label::Text("missing.key".into()));
    }

    #[test]
    fn manifest_rejects_each_kind_of_error() {
        assert_eq!(reason(with(good(), &["apiVersion"], json!("1"))), "apiVersion");
        assert_eq!(reason(with(good(), &["surprise"], json!(1))), "schema", "unknown top-level field");
        assert_eq!(reason(with(good(), &["contributes", "kinds", "0", "style"], json!("x"))), "schema");
        assert_eq!(reason(without(good(), "icon")), "schema", "missing field");
        assert_eq!(reason_in("test.other", "0.1.0", good()), "idMismatch");
        assert_eq!(reason_in("test.alpha", "0.2.0", good()), "versionMismatch");
        assert_eq!(reason_in("test.alpha", "x", with(good(), &["version"], json!("x"))), "badVersion");
        assert_eq!(reason_in("Bad:Id", "0.1.0", with(good(), &["id"], json!("Bad:Id"))), "badId");
        assert_eq!(reason(with(good(), &["main"], json!("../evil.js"))), "mainMissing");
        assert_eq!(reason(with(good(), &["main"], json!("nope.js"))), "mainMissing");
        assert_eq!(reason(with(good(), &["contributes", "kinds", "0", "page"], json!("nope"))), "unknownPage");
        assert_eq!(reason(with(good(), &["contributes", "kinds", "0", "tree"], json!("nope"))), "unknownTree");
        assert_eq!(reason(with(good(), &["contributes", "kinds", "0", "tree"], json!("disk"))), "unknownTree", "provided tree cannot hold kinds");
        assert_eq!(reason(with(good(), &["contributes", "kinds", "0", "menu"], json!(["nope"]))), "unknownCommand");
        assert_eq!(reason(with(good(), &["contributes", "kinds", "0", "accepts"], json!(["nope"]))), "unknownKind");
        assert_eq!(reason(with(good(), &["contributes", "trees", "0", "toolbar"], json!(["nope"]))), "unknownCommand");
        assert_eq!(reason(with(good(), &["contributes", "trees", "0", "page"], json!("nope"))), "unknownPage");
        assert_eq!(reason(with(good(), &["contributes", "menus", "new"], json!(["nope"]))), "unknownKind");
        assert_eq!(reason(with(good(), &["contributes", "commands", "0", "id"], json!("a:b"))), "badName");
        assert_eq!(
            reason(with(good(), &["contributes", "pages"], json!([{ "id": "editor" }, { "id": "editor" }]))),
            "duplicate"
        );
        assert_eq!(reason(with(good(), &["contributes", "locales"], json!({ "zh-CN": "locales/en-US.json" }))), "localeMissing");
        assert_eq!(reason(with(good(), &["contributes", "locales"], json!({ "en-US": "locales/nope.json" }))), "badLocale");
        assert_eq!(reason(with(good(), &["contributes", "pages", "0", "actions", "0", "role"], json!("explode"))), "schema");
    }

    #[test]
    fn registry_keeps_the_highest_version_and_lists_rejections() {
        let tmp = tempfile::tempdir().unwrap();
        write(tmp.path(), "test.alpha", "0.1.0", &good());
        write(tmp.path(), "test.alpha", "0.10.0", &with(good(), &["version"], json!("0.10.0")));
        write(tmp.path(), "test.alpha", "0.2.0", &good()); // version mismatch: rejected
        let reg = Registry::scan(tmp.path());
        assert_eq!(reg.plugins.len(), 1);
        assert_eq!(reg.plugins[0].version, "0.10.0");
        assert_eq!(reg.rejected.len(), 1);
        let rules = reg.rules();
        assert_eq!(rules["test.alpha:item"].tree.as_deref(), Some("resources"));
    }
}
