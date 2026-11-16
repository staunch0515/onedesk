//! Plugin packages: `<plugins>/<id>/<version>/manifest.json` (manifest v2, week-1 subset, D267).
//! Validation is strict: unknown or missing fields, a wrong `apiVersion`, an id or version that
//! does not match its folder, dangling references — the package is not loaded.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
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
    #[serde(default)]
    pub author: String,
    #[serde(default)]
    pub license: String,
    #[serde(default)]
    pub homepage: String,
    /// Versions whose data this one can take over (semver range, §7.6).
    #[serde(default)]
    pub upgrades_from: Option<String>,
    /// Round 7 (D342): `[{ "id", "version" }]`, checked by hand (`badDepends`); see `deps`.
    #[serde(default, rename = "depends")]
    pub depends_raw: Option<serde_json::Value>,
    /// Round 7 (D342): `{ "kinds": [{ "id", "actions", "read" }] }` (`badExports`); see `exported`.
    #[serde(default, rename = "exports")]
    pub exports_raw: Option<serde_json::Value>,
    /// The validated `depends`.
    #[serde(skip)]
    pub deps: Vec<Depend>,
    /// The validated `exports.kinds`.
    #[serde(skip)]
    pub exported: Vec<ExportKind>,
    /// Round 8 (D356): the validated `exports.trees` — short names of its own stored trees.
    #[serde(skip)]
    pub exported_trees: Vec<String>,
    /// Round 8 (D357): the validated `exports.pages` — short names of its own pages.
    #[serde(skip)]
    pub exported_pages: Vec<String>,
}

/// One dependency (round 7): another plugin's id and a semver range of its active version.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Depend {
    pub id: String,
    pub range: String,
    pub req: semver::VersionReq,
}

/// One exported kind (round 7, D342): what plugins depending on this one may do with it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExportKind {
    /// Short name of one of this plugin's kinds.
    pub id: String,
    /// Dependents may add actions to it.
    pub actions: bool,
    /// Dependents may read its resources.
    pub read: bool,
}

/// Most dependencies one manifest may list.
pub const MAX_DEPENDS: usize = 32;

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Requires {
    #[serde(default)]
    pub files: bool,
    /// D307: hosts written here, and/or hosts taken from this plugin's own resources.
    #[serde(default)]
    pub network: Option<NetworkReq>,
    /// D305/D306: secret names it may use; `plaintext` lets it read values (a separate permission).
    #[serde(default)]
    pub secrets: Option<SecretsReq>,
    /// Round 6 (D331): external programs `host.process` may run, by name.
    #[serde(default)]
    pub programs: Vec<ProgramDecl>,
    #[serde(default)]
    pub resources: bool,
    /// Round 7 (D342): `{ "install": true }` — may ask the user to install other plugins.
    /// Checked by hand (`badPlugins`).
    #[serde(default)]
    pub plugins: Option<serde_json::Value>,
}

impl Requires {
    /// `requires.plugins.install: true`.
    pub fn plugins_install(&self) -> bool {
        self.plugins.as_ref().and_then(|v| v.get("install")).and_then(serde_json::Value::as_bool) == Some(true)
    }
}

/// One declared external program (D331): `system` (found in the fixed system folders) or
/// `plugin` (its own: `plugin-data/<id>/bin/<name>`, then `path` inside the package).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProgramDecl {
    pub name: String,
    pub source: String,
    #[serde(default)]
    pub path: Option<String>,
}

pub const PROGRAM_SYSTEM: &str = "system";
pub const PROGRAM_PLUGIN: &str = "plugin";

/// Round 6 (D335): the events a plugin can subscribe to.
pub const EVENTS: &[&str] = &["resource.changed", "run.ended"];

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NetworkReq {
    /// `host`, `host:port`, or `*.domain` (any subdomain).
    #[serde(default)]
    pub hosts: Vec<String>,
    /// Hosts of fields declared `"grants": "network"` in its own resources (I.10h).
    #[serde(default)]
    pub from_resources: bool,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SecretsReq {
    #[serde(default)]
    pub names: Vec<String>,
    #[serde(default)]
    pub plaintext: bool,
}

/// A body field of a kind with a meaning the kernel acts on (round 4).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FieldDecl {
    #[serde(rename = "type")]
    pub ty: DeclType,
    /// `network`: the host of this field's URL is granted to the plugin (D307).
    #[serde(default)]
    pub grants: Option<String>,
    /// D318: text that may contain `{{secret:name}}`; names in the *saved* text are the secrets the
    /// user lets the plugin use for this resource.
    #[serde(default)]
    pub secrets: bool,
    /// Round 5 (D321): a text field whose `[[name]]` marks are references to other resources.
    #[serde(default)]
    pub refs: bool,
    /// Round 6: a label key (or text) for the field, shown e.g. in the reference panel.
    #[serde(default)]
    pub label: Option<String>,
}

/// Type of a declared body field: the view field kinds plus `ref` (a single reference stored as
/// `{ "ref": "<id>" }`, round 5). Manifest-only; the protocol's `FieldKind` is unchanged.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DeclType {
    Text,
    Longtext,
    Code,
    Number,
    Boolean,
    Date,
    Datetime,
    Enum,
    Secret,
    Ref,
}

impl FieldDecl {
    /// A text field holding `[[name]]` references.
    pub fn text_refs(&self) -> bool {
        self.refs && matches!(self.ty, DeclType::Text | DeclType::Longtext | DeclType::Code)
    }

    pub fn holds_secret_refs(&self) -> bool {
        self.secrets
    }
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
    /// D284: things a page or the palette can run.
    #[serde(default)]
    pub actions: Vec<ActionDef>,
    #[serde(default)]
    pub settings: Vec<SettingDecl>,
    /// Round 6 (D335): events it subscribes to (`host.events.on` only for these).
    #[serde(default)]
    pub events: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OutputType {
    Table,
    Text,
    Link,
    None,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActionDef {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub icon: Option<String>,
    /// Kinds (short names) this action applies to; absent = not bound to a resource.
    #[serde(default)]
    pub kinds: Option<Vec<String>>,
    pub output: OutputType,
    #[serde(default)]
    pub shortcut: Option<Vec<String>>,
    #[serde(default)]
    pub save_first: bool,
    /// A text key the shell shows before running (D289).
    #[serde(default)]
    pub confirm: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SettingType {
    Text,
    Number,
    Boolean,
    Enum,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SettingOption {
    pub value: String,
    pub label: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SettingDecl {
    pub name: String,
    pub label: String,
    #[serde(rename = "type")]
    pub ty: SettingType,
    pub default: String,
    #[serde(default)]
    pub options: Option<Vec<SettingOption>>,
    #[serde(default)]
    pub hint: Option<String>,
}

impl SettingDecl {
    /// Whether `v` is a valid value of this setting (text form).
    pub fn accepts(&self, v: &str) -> bool {
        match self.ty {
            SettingType::Text => true,
            SettingType::Number => v.trim().parse::<f64>().is_ok_and(f64::is_finite),
            SettingType::Boolean => v == "true" || v == "false",
            SettingType::Enum => self.options.as_ref().is_some_and(|o| o.iter().any(|x| x.value == v)),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResultTabM {
    pub id: String,
    #[serde(rename = "type")]
    pub tab_type: onedesk_protocol::ResultTabType,
    pub label: String,
    #[serde(default)]
    pub icon: Option<String>,
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
    /// Body keys with a kernel meaning: secret fields, granting fields.
    #[serde(default)]
    pub fields: BTreeMap<String, FieldDecl>,
}

impl KindDecl {
    /// D311: body keys a plugin may not write — fields granting network access and secret fields.
    pub fn protected_fields(&self) -> Vec<String> {
        self.fields
            .iter()
            .filter(|(_, f)| f.grants.is_some() || f.secrets || f.ty == DeclType::Secret)
            .map(|(n, _)| n.clone())
            .collect()
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PageDecl {
    pub id: String,
    #[serde(default)]
    pub actions: Vec<ActionDeclM>,
    #[serde(default)]
    pub result_tabs: Vec<ResultTabM>,
    /// Re-render with the draft ~300 ms after bound content stops changing (§9.3).
    #[serde(default)]
    pub recompute: bool,
    #[serde(default)]
    pub uses_env: bool,
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
    /// `run` / `save-run`: the action (short id in `contributes.actions`) this item runs.
    #[serde(default)]
    pub action: Option<String>,
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
    /// D296: listed in the command palette (needs no node). Default false.
    #[serde(default)]
    pub palette: bool,
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
    /// Fingerprint of `manifest.json` (a re-installed version with other content is reloaded).
    pub manifest_hash: String,
    pub manifest: Manifest,
    /// Locale → (key → text).
    pub locales: BTreeMap<String, BTreeMap<String, String>>,
}

/// One permission atom; a version's permission set is a set of these (D299).
pub fn permission_atoms(m: &Manifest) -> BTreeSet<String> {
    let mut a = BTreeSet::new();
    let r = &m.requires;
    if r.files {
        a.insert("files".to_string());
    }
    if let Some(n) = &r.network {
        for h in &n.hosts {
            a.insert(format!("network:{}", h.to_ascii_lowercase()));
        }
        if n.from_resources {
            a.insert("network:@resources".to_string());
        }
    }
    if let Some(sec) = &r.secrets {
        for n in &sec.names {
            a.insert(format!("secrets:{n}"));
        }
        if sec.plaintext {
            a.insert("secrets.plaintext".to_string());
        }
    }
    // D331: the program list is part of the fingerprint; the plugin's own are marked.
    for p in &r.programs {
        if p.source == PROGRAM_PLUGIN {
            a.insert(format!("programs:{} (plugin)", p.name));
        } else {
            a.insert(format!("programs:{}", p.name));
        }
    }
    if r.resources {
        a.insert("resources".to_string());
    }
    if r.plugins_install() {
        a.insert("plugins".to_string());
    }
    // D347: kinds of other plugins it reads through their exports are a permission.
    for k in foreign_kinds(m) {
        a.insert(format!("resources:{k}"));
    }
    // D357: kinds shown with another plugin's page let that plugin's code read them.
    for k in &m.contributes.kinds {
        if let Some(pg) = k.page.as_deref().filter(|pg| is_foreign(m, pg)) {
            a.insert(format!("pages:{pg}"));
        }
    }
    a
}

/// A `tree` / `page` written as another plugin's full name `<plugin>:<name>` (round 8).
pub fn is_foreign(m: &Manifest, name: &str) -> bool {
    Registry::split(name).is_some_and(|(pid, _)| pid != m.id)
}

/// Full names of other plugins' trees and pages a kind is declared with (round 8, D356–D357).
pub fn foreign_refs(m: &Manifest, k: &KindDecl) -> Vec<String> {
    [k.tree.as_deref(), k.page.as_deref()].into_iter().flatten().filter(|n| is_foreign(m, n)).map(String::from).collect()
}

/// Full names (`<plugin>:<kind>`) of other plugins' kinds this manifest's actions name (round 7):
/// the kinds it may add actions to and read, when the other plugin exports them.
pub fn foreign_kinds(m: &Manifest) -> BTreeSet<String> {
    m.contributes
        .actions
        .iter()
        .flat_map(|a| a.kinds.iter().flatten())
        .filter(|k| k.contains(':') && Registry::split(k).is_some_and(|(pid, _)| pid != m.id))
        .cloned()
        .collect()
}

/// The permission id an atom belongs to (`network:x` → `network`).
pub fn atom_id(atom: &str) -> &str {
    atom.split(':').next().unwrap_or(atom)
}

/// The permission fingerprint shown and confirmed (D312): a hash of the atom list (SHA-256, D359).
pub fn perm_fingerprint(atoms: &BTreeSet<String>) -> String {
    crate::util::sha256_hex(atoms_fingerprint(atoms).as_bytes())
}

/// Atom list stored when a version's permissions are confirmed.
pub fn atoms_fingerprint(atoms: &BTreeSet<String>) -> String {
    atoms.iter().cloned().collect::<Vec<_>>().join("\n")
}

impl Plugin {
    pub fn permissions(&self) -> BTreeSet<String> {
        permission_atoms(&self.manifest)
    }

    /// Display form (`PluginPermission`): one entry per id, details joined.
    pub fn permission_list(&self, granted: impl Fn(&str) -> bool) -> Vec<onedesk_protocol::PluginPermission> {
        let mut by_id: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for a in self.permissions() {
            let id = atom_id(&a).to_string();
            let detail = a.split_once(':').map(|(_, d)| d.to_string());
            let e = by_id.entry(id).or_default();
            if let Some(d) = detail {
                e.push(d);
            }
        }
        by_id
            .into_iter()
            .map(|(id, details)| onedesk_protocol::PluginPermission {
                granted: granted(&id),
                required: true,
                detail: details.join(", "),
                id,
            })
            .collect()
    }

    pub fn semver(&self) -> semver::Version {
        semver::Version::parse(&self.version).unwrap_or(semver::Version::new(0, 0, 0))
    }

    /// Whether this version can take over data bound to `from` (§7.6).
    pub fn upgrades_from(&self, from: &str) -> bool {
        let (Some(req), Ok(v)) = (self.manifest.upgrades_from.as_deref(), semver::Version::parse(from)) else { return false };
        semver::VersionReq::parse(req).is_ok_and(|r| r.matches(&v)) && v < self.semver()
    }

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
    /// The plugin and short name of the page a kind's `page` names (round 8: another plugin's,
    /// by full name; else its own).
    pub fn page_ref(&self, name: &str) -> (String, String) {
        match Registry::split(name) {
            Some((pid, short)) => (pid.to_string(), short.to_string()),
            None => (self.id.clone(), name.to_string()),
        }
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
    pub fn action(&self, short: &str) -> Option<&ActionDef> {
        self.manifest.contributes.actions.iter().find(|a| a.id == short)
    }
    pub fn program(&self, name: &str) -> Option<&ProgramDecl> {
        self.manifest.requires.programs.iter().find(|p| p.name == name)
    }
    pub fn setting(&self, name: &str) -> Option<&SettingDecl> {
        self.manifest.contributes.settings.iter().find(|x| x.name == name)
    }

    /// A tree reference from the manifest: kernel trees by full name, own trees by short name.
    pub fn tree_ref(&self, name: &str) -> String {
        // Round 8: another plugin's exported tree, by its full name.
        if KERNEL_TREES.contains(&name) || name.contains(':') {
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

/// `host`, `host:port`, `*.domain`, an IPv4 address; lower case letters, digits, `-`, `.`.
pub fn valid_host_pattern(h: &str) -> bool {
    let (host, port) = match h.rsplit_once(':') {
        Some((a, p)) => (a, Some(p)),
        None => (h, None),
    };
    if port.is_some_and(|p| p.parse::<u16>().is_err()) {
        return false;
    }
    let host = host.strip_prefix("*.").unwrap_or(host);
    !host.is_empty()
        && host.len() <= 253
        && host.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '.')
        && !host.starts_with('.')
        && !host.ends_with('.')
}

/// Secret names: letters, digits, `.`, `-`, `_`; at most 128.
pub fn valid_secret_name(n: &str) -> bool {
    !n.is_empty() && n.len() <= 128 && n.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_')
}

fn valid_short(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
}

/// D331: `[A-Za-z0-9._-]{1,64}`.
pub fn valid_program_name(n: &str) -> bool {
    !n.is_empty() && n.len() <= 64 && n != "." && n != ".." && n.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// A plugin program's path in the package: relative, no `..`; when the file exists, it (after
/// following links) must stay inside the package. A missing file is allowed (reported at run time).
pub fn package_program(dir: &Path, rel: &str) -> Option<PathBuf> {
    let p = Path::new(rel);
    if rel.is_empty() || p.is_absolute() || p.components().any(|c| !matches!(c, std::path::Component::Normal(_) | std::path::Component::CurDir)) {
        return None;
    }
    let full = dir.join(p);
    if full.symlink_metadata().is_ok() {
        let real = full.canonicalize().ok()?;
        let root = dir.canonicalize().ok()?;
        if !real.starts_with(&root) {
            return None;
        }
    }
    Some(full)
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
    load_package_opts(dir, true)
}

/// `check_folder = false` for a package the user picked to install (any folder name).
pub fn load_package_opts(dir: &Path, check_folder: bool) -> Result<Plugin, Rejection> {
    let mpath = dir.join("manifest.json");
    let bytes = std::fs::read(&mpath).map_err(|e| reject(dir, "noManifest", e.to_string()))?;
    parse_package(dir, &bytes, check_folder)
}

/// Validates a package from its manifest's text (read from the folder, or from `plugins/.index`).
/// Language files are still read from the package.
pub fn parse_package(dir: &Path, bytes: &[u8], check_folder: bool) -> Result<Plugin, Rejection> {
    let folder_version = dir.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let folder_id = dir.parent().and_then(|p| p.file_name()).map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let raw: serde_json::Value = serde_json::from_slice(bytes).map_err(|e| reject(dir, "badJson", e.to_string()))?;
    let m: Manifest = serde_json::from_value(raw).map_err(|e| reject(dir, "schema", e.to_string()))?;
    let manifest_hash = crate::util::fingerprint(bytes);

    if m.api_version != "2" {
        return Err(reject(dir, "apiVersion", m.api_version.clone()));
    }
    if !valid_id(&m.id) {
        return Err(reject(dir, "badId", m.id.clone()));
    }
    if check_folder && m.id != folder_id {
        return Err(reject(dir, "idMismatch", format!("{} in folder {folder_id}", m.id)));
    }
    if semver::Version::parse(&m.version).is_err() {
        return Err(reject(dir, "badVersion", m.version.clone()));
    }
    if check_folder && m.version != folder_version {
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
        ("action", c.actions.iter().map(|x| x.id.as_str()).collect()),
        ("setting", c.settings.iter().map(|x| x.name.as_str()).collect()),
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
    let deps = parse_depends(dir, &m)?;
    // Round 8 (D356–D357): `tree` / `page` may name another plugin's by full name; that plugin
    // must be in `depends` (whether it exports them is judged when used, against its active version).
    let foreign_ok = |what: &str, k: &KindDecl, name: &str| -> Result<(), Rejection> {
        let (pid, short) = Registry::split(name).ok_or_else(|| reject(dir, "badName", format!("kind {} {what} {name}", k.id)))?;
        if !valid_id(pid) || !valid_short(short) {
            return Err(reject(dir, "badName", format!("kind {} {what} {name}", k.id)));
        }
        if !deps.iter().any(|d| d.id == pid) {
            return Err(reject(dir, "undeclaredDepend", format!("kind {} {what} {name}", k.id)));
        }
        Ok(())
    };
    for k in &c.kinds {
        if let Some(p) = &k.page {
            if p.contains(':') {
                foreign_ok("page", k, p)?;
            } else if !has_page(p) {
                return Err(reject(dir, "unknownPage", format!("kind {} page {p}", k.id)));
            }
        }
        if let Some(t) = &k.tree {
            if t.contains(':') {
                foreign_ok("tree", k, t)?;
                // A kind in another plugin's tree accepts only kinds of its own plugin.
                if let Some(a) = k.accepts.iter().find(|a| *a == "*" || (a.contains(':') && !a.starts_with(&format!("{}:", m.id)))) {
                    return Err(reject(dir, "unknownKind", format!("kind {} accepts {a}", k.id)));
                }
            } else {
                let own_stored = c.trees.iter().any(|x| &x.id == t && x.source == TreeSource::Stored);
                if !KERNEL_TREES.contains(&t.as_str()) && !own_stored {
                    return Err(reject(dir, "unknownTree", format!("kind {} tree {t}", k.id)));
                }
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
    let has_kind = |k: &str| c.kinds.iter().any(|y| y.id == k);
    let (exported, exported_trees, exported_pages) = parse_exports(dir, &m)?;
    check_requires_plugins(dir, &m)?;
    for a in &c.actions {
        for k in a.kinds.iter().flatten() {
            // Round 7: `<dependency>:<kind>` names a kind of a plugin this one depends on.
            if let Some((pid, short)) = Registry::split(k) {
                if pid == m.id || !deps.iter().any(|d| d.id == pid) || !valid_short(short) {
                    return Err(reject(dir, "unknownKind", format!("action {} kind {k}", a.id)));
                }
                continue;
            }
            if !has_kind(k) {
                return Err(reject(dir, "unknownKind", format!("action {} kind {k}", a.id)));
            }
        }
    }
    for pg in &c.pages {
        let mut ids = HashSet::new();
        for item in &pg.actions {
            if !ids.insert(item.id.as_str()) {
                return Err(reject(dir, "duplicate", format!("page {} action {}", pg.id, item.id)));
            }
            let runs = matches!(item.role, ActionRole::Run | ActionRole::SaveRun);
            match (&item.action, runs) {
                (None, true) => return Err(reject(dir, "missingAction", format!("page {} item {}", pg.id, item.id))),
                (Some(a), _) if !c.actions.iter().any(|x| &x.id == a) => {
                    return Err(reject(dir, "unknownAction", format!("page {} item {} action {a}", pg.id, item.id)))
                }
                _ => {}
            }
        }
        let mut tabs = HashSet::new();
        for t in &pg.result_tabs {
            if !valid_short(&t.id) || !tabs.insert(t.id.as_str()) {
                return Err(reject(dir, "duplicate", format!("page {} tab {}", pg.id, t.id)));
            }
        }
    }
    for st in &c.settings {
        let options_ok = match st.ty {
            SettingType::Enum => st.options.as_ref().is_some_and(|o| !o.is_empty()),
            _ => st.options.is_none(),
        };
        if !options_ok || !st.accepts(&st.default) {
            return Err(reject(dir, "badSetting", st.name.clone()));
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

    if let Some(r) = &m.upgrades_from {
        if semver::VersionReq::parse(r).is_err() {
            return Err(reject(dir, "badUpgradesFrom", r.clone()));
        }
    }
    if let Some(n) = &m.requires.network {
        for h in &n.hosts {
            if !valid_host_pattern(h) {
                return Err(reject(dir, "badHost", h.clone()));
            }
        }
    }
    if let Some(sec) = &m.requires.secrets {
        for n in &sec.names {
            if !valid_secret_name(n) {
                return Err(reject(dir, "badSecretName", n.clone()));
            }
        }
    }
    for k in &c.kinds {
        for (name, f) in &k.fields {
            use DeclType as F;
            if f.secrets && (f.grants.is_some() || !matches!(f.ty, F::Text | F::Longtext | F::Code)) {
                return Err(reject(dir, "badSecretsField", format!("kind {} field {name}", k.id)));
            }
            // Round 5: `refs` only on text fields, never together with `grants` (a reference is not
            // a grant); a single-reference field carries no other marks.
            if (f.refs && (f.grants.is_some() || !matches!(f.ty, F::Text | F::Longtext | F::Code)))
                || (f.ty == F::Ref && (f.refs || f.grants.is_some()))
            {
                return Err(reject(dir, "badRefsField", format!("kind {} field {name}", k.id)));
            }
            match f.grants.as_deref() {
                None => {}
                Some("network") if f.ty == DeclType::Text => {
                    if !m.requires.network.as_ref().is_some_and(|n| n.from_resources) {
                        return Err(reject(dir, "grantsUndeclared", format!("kind {} field {name}", k.id)));
                    }
                }
                Some(g) => return Err(reject(dir, "badGrants", format!("kind {} field {name}: {g}", k.id))),
            }
        }
    }
    // D331: programs by name; system ones without a path, the plugin's own with one inside the package.
    let mut names = HashSet::new();
    for pr in &m.requires.programs {
        let bad = |why: &str| reject(dir, "badPrograms", format!("{}: {why}", pr.name));
        if !valid_program_name(&pr.name) {
            return Err(bad("name"));
        }
        if !names.insert(pr.name.as_str()) {
            return Err(bad("duplicate"));
        }
        match (pr.source.as_str(), &pr.path) {
            (PROGRAM_SYSTEM, None) => {}
            (PROGRAM_SYSTEM, Some(_)) => return Err(bad("a system program has no path")),
            (PROGRAM_PLUGIN, Some(rel)) => {
                if package_program(dir, rel).is_none() {
                    return Err(bad("path"));
                }
            }
            (PROGRAM_PLUGIN, None) => return Err(bad("path missing")),
            _ => return Err(bad("source")),
        }
    }
    let mut evs = HashSet::new();
    for e in &c.events {
        if !EVENTS.contains(&e.as_str()) || !evs.insert(e.as_str()) {
            return Err(reject(dir, "badEvents", e.clone()));
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

    let mut m = m;
    m.deps = deps;
    m.exported = exported;
    m.exported_trees = exported_trees;
    m.exported_pages = exported_pages;
    Ok(Plugin { id: m.id.clone(), version: m.version.clone(), dir: dir.to_path_buf(), manifest_hash, manifest: m, locales })
}

/// Round 7 (D342): `depends` is a list of `{ "id", "version" }`; not itself, no repeats, a valid range.
fn parse_depends(dir: &Path, m: &Manifest) -> Result<Vec<Depend>, Rejection> {
    let bad = |why: String| reject(dir, "badDepends", why);
    let Some(raw) = &m.depends_raw else { return Ok(vec![]) };
    let list = raw.as_array().ok_or_else(|| bad("not a list".into()))?;
    if list.len() > MAX_DEPENDS {
        return Err(bad("too many".into()));
    }
    let mut out: Vec<Depend> = Vec::new();
    for e in list {
        let o = e.as_object().ok_or_else(|| bad("entry is not an object".into()))?;
        if let Some(k) = o.keys().find(|k| *k != "id" && *k != "version") {
            return Err(bad(format!("unknown field {k}")));
        }
        let id = o.get("id").and_then(serde_json::Value::as_str).ok_or_else(|| bad("id missing".into()))?;
        let range = o.get("version").and_then(serde_json::Value::as_str).ok_or_else(|| bad(format!("{id}: version missing")))?;
        if !valid_id(id) {
            return Err(bad(format!("bad id {id}")));
        }
        if id == m.id {
            return Err(bad("depends on itself".into()));
        }
        if out.iter().any(|d| d.id == id) {
            return Err(bad(format!("{id} twice")));
        }
        let req = semver::VersionReq::parse(range).map_err(|_| bad(format!("{id}: range {range}")))?;
        out.push(Depend { id: id.into(), range: range.into(), req });
    }
    Ok(out)
}

/// What `exports` lists (round 7 kinds; round 8 trees and pages).
type Exports = (Vec<ExportKind>, Vec<String>, Vec<String>);

/// Round 7 (D342): `exports.kinds[]` names this plugin's own kinds, each once, with `actions` / `read`.
/// Round 8 (D356–D357): `exports.trees[]` its own stored trees, `exports.pages[]` its own pages,
/// each `{ "id" }`, each once.
fn parse_exports(dir: &Path, m: &Manifest) -> Result<Exports, Rejection> {
    let bad = |why: String| reject(dir, "badExports", why);
    let Some(raw) = &m.exports_raw else { return Ok((vec![], vec![], vec![])) };
    let o = raw.as_object().ok_or_else(|| bad("not an object".into()))?;
    if let Some(k) = o.keys().find(|k| !matches!(k.as_str(), "kinds" | "trees" | "pages")) {
        return Err(bad(format!("unknown field {k}")));
    }
    let list = |name: &str| -> Result<Vec<serde_json::Value>, Rejection> {
        match o.get(name) {
            None => Ok(vec![]),
            Some(v) => v.as_array().cloned().ok_or_else(|| bad(format!("{name} is not a list"))),
        }
    };
    let mut out: Vec<ExportKind> = Vec::new();
    for e in list("kinds")? {
        let o = e.as_object().ok_or_else(|| bad("entry is not an object".into()))?;
        if let Some(k) = o.keys().find(|k| !matches!(k.as_str(), "id" | "actions" | "read")) {
            return Err(bad(format!("unknown field {k}")));
        }
        let id = o.get("id").and_then(serde_json::Value::as_str).ok_or_else(|| bad("id missing".into()))?;
        let flag = |name: &str| -> Result<bool, Rejection> {
            match o.get(name) {
                None => Ok(false),
                Some(v) => v.as_bool().ok_or_else(|| bad(format!("{id}: {name} is not true/false"))),
            }
        };
        let (actions, read) = (flag("actions")?, flag("read")?);
        if !m.contributes.kinds.iter().any(|k| k.id == id) {
            return Err(bad(format!("{id} is not its own kind")));
        }
        if out.iter().any(|x| x.id == id) {
            return Err(bad(format!("{id} twice")));
        }
        out.push(ExportKind { id: id.into(), actions, read });
    }
    let ids = |name: &str, ok: &dyn Fn(&str) -> bool| -> Result<Vec<String>, Rejection> {
        let mut ids: Vec<String> = Vec::new();
        for e in list(name)? {
            let o = e.as_object().ok_or_else(|| bad(format!("{name}: entry is not an object")))?;
            if let Some(k) = o.keys().find(|k| *k != "id") {
                return Err(bad(format!("{name}: unknown field {k}")));
            }
            let id = o.get("id").and_then(serde_json::Value::as_str).ok_or_else(|| bad(format!("{name}: id missing")))?;
            if !ok(id) {
                return Err(bad(format!("{name}: {id} is not its own")));
            }
            if ids.iter().any(|x| x == id) {
                return Err(bad(format!("{name}: {id} twice")));
            }
            ids.push(id.into());
        }
        Ok(ids)
    };
    let c = &m.contributes;
    // D356: only its own stored trees (a provided tree has no resources to put a kind into).
    let trees = ids("trees", &|id| c.trees.iter().any(|t| t.id == id && t.source == TreeSource::Stored))?;
    let pages = ids("pages", &|id| c.pages.iter().any(|p| p.id == id))?;
    Ok((out, trees, pages))
}

/// Round 7 (D342): `requires.plugins` is `{ "install": true|false }`.
fn check_requires_plugins(dir: &Path, m: &Manifest) -> Result<(), Rejection> {
    let Some(raw) = &m.requires.plugins else { return Ok(()) };
    let ok = raw.as_object().is_some_and(|o| o.keys().all(|k| k == "install") && o.get("install").is_none_or(serde_json::Value::is_boolean));
    if ok {
        Ok(())
    } else {
        Err(reject(dir, "badPlugins", raw.to_string()))
    }
}

#[derive(Default)]
struct RegState {
    /// id → every installed version, ascending. Entries are leaked once per (id, version, manifest):
    /// they are tiny, live for the process, and let callers hold `&'static Plugin` across awaits.
    all: BTreeMap<String, Vec<&'static Plugin>>,
    rejected: Vec<Rejection>,
}

/// Every valid plugin version under the plugins folder, the active version of each, and what was refused.
#[derive(Default)]
pub struct Registry {
    root: PathBuf,
    state: std::sync::RwLock<RegState>,
    /// id → active version (set by the kernel from the workspace's plugin state).
    active: std::sync::RwLock<HashMap<String, String>>,
}

/// Versions added and removed by a rescan.
#[derive(Debug, Default)]
pub struct RescanDiff {
    pub added: Vec<(String, String)>,
    pub removed: Vec<(String, String)>,
}

/// D364: the manifest cache the main process keeps at `<plugins>/.index` (the kernel only reads it).
pub const INDEX_FILE: &str = ".index";
/// The only cache format the kernel knows.
pub const INDEX_VERSION: u64 = 1;

#[derive(Deserialize)]
struct IndexFile {
    version: u64,
    #[serde(default)]
    entries: Vec<IndexEntry>,
}

/// One package in `.index`. `mtime` and `size` are the main process's business.
#[derive(Deserialize)]
struct IndexEntry {
    dir: String,
    #[serde(default)]
    manifest: Option<String>,
    #[serde(default)]
    error: Option<String>,
}

/// `<plugins>/.index`, when it is there and readable as version 1. Missing → `None` (scan the
/// folder); present but unreadable, not JSON or another version → also `None`, with a log line:
/// the folder is the truth, the cache only saves reading it.
fn read_index(root: &Path) -> Option<Vec<IndexEntry>> {
    let path = root.join(INDEX_FILE);
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return None,
        Err(e) => {
            eprintln!("onedesk: {} unreadable ({e}); scanning the plugins folder", path.display());
            return None;
        }
    };
    match serde_json::from_slice::<IndexFile>(&bytes) {
        Ok(f) if f.version == INDEX_VERSION => Some(f.entries),
        Ok(f) => {
            eprintln!("onedesk: {} has version {}; scanning the plugins folder", path.display(), f.version);
            None
        }
        Err(e) => {
            eprintln!("onedesk: {} is not a valid cache ({e}); scanning the plugins folder", path.display());
            None
        }
    }
}

/// `<id>/<version>` of an index entry as a folder under `root`: exactly two plain parts, neither
/// hidden (anything else is not a package the kernel loads).
fn index_dir(root: &Path, rel: &str) -> Option<PathBuf> {
    let parts: Vec<&str> = rel.split('/').collect();
    let plain = |p: &&str| !p.is_empty() && !p.starts_with('.') && *p != ".." && !p.contains('\\');
    (parts.len() == 2 && parts.iter().all(plain)).then(|| root.join(parts[0]).join(parts[1]))
}

fn read_root(root: &Path, old: &BTreeMap<String, Vec<&'static Plugin>>) -> (BTreeMap<String, Vec<&'static Plugin>>, Vec<Rejection>) {
    let mut all: BTreeMap<String, Vec<&'static Plugin>> = BTreeMap::new();
    let mut rejected = Vec::new();
    let mut add = |res: Result<Plugin, Rejection>| match res {
        Ok(p) => {
            let reuse = old
                .get(&p.id)
                .and_then(|vs| vs.iter().find(|o| o.version == p.version && o.manifest_hash == p.manifest_hash))
                .copied();
            let leaked: &'static Plugin = reuse.unwrap_or_else(|| Box::leak(Box::new(p)));
            all.entry(leaked.id.clone()).or_default().push(leaked);
        }
        Err(r) => rejected.push(r),
    };
    if let Some(entries) = read_index(root) {
        // D364: with a cache, no folder is listed and no `manifest.json` opened; the manifests
        // are validated here exactly as if read from the folders.
        let mut seen = HashSet::new();
        for e in entries {
            let Some(vdir) = index_dir(root, &e.dir) else {
                eprintln!("onedesk: {} entry {:?} is not <id>/<version>; ignored", INDEX_FILE, e.dir);
                continue;
            };
            if !seen.insert(vdir.clone()) {
                continue;
            }
            add(match e.manifest {
                Some(text) => parse_package(&vdir, text.as_bytes(), true),
                None => Err(reject(&vdir, "noManifest", e.error.unwrap_or_else(|| "unreadable".into()))),
            });
        }
    } else {
        let dirs = |p: &Path| -> Vec<PathBuf> {
            let mut v: Vec<PathBuf> = std::fs::read_dir(p)
                // Review #4: a symbolic link is not a package folder (the main process's cache
                // does not follow them either), at the id level and the version level.
                .map(|rd| {
                    rd.filter_map(|e| e.ok()).filter(|e| e.file_type().is_ok_and(|t| t.is_dir())).map(|e| e.path()).collect()
                })
                .unwrap_or_default();
            v.sort();
            v
        };
        for id_dir in dirs(root) {
            // `.removed`, `.index` and other dot folders belong to the main process.
            if id_dir.file_name().is_some_and(|n| n.to_string_lossy().starts_with('.')) {
                continue;
            }
            for vdir in dirs(&id_dir) {
                // Temporary or hidden folders (`.tmp`, `.removed`…) are the main process's (#13).
                if vdir.file_name().is_some_and(|n| n.to_string_lossy().starts_with('.')) {
                    continue;
                }
                add(load_package(&vdir));
            }
        }
    }
    for vs in all.values_mut() {
        vs.sort_by_key(|p| p.semver());
    }
    (all, rejected)
}

impl Registry {
    pub fn scan(root: &Path) -> Registry {
        let (all, rejected) = read_root(root, &BTreeMap::new());
        Registry { root: root.to_path_buf(), state: std::sync::RwLock::new(RegState { all, rejected }), active: Default::default() }
    }

    /// Reads the folder again (plugin.rescan); returns which versions appeared and went.
    pub fn rescan(&self) -> RescanDiff {
        let old = self.state.read().unwrap().all.clone();
        let (all, rejected) = read_root(&self.root, &old);
        let key = |m: &BTreeMap<String, Vec<&'static Plugin>>| -> BTreeSet<(String, String)> {
            m.values().flatten().map(|p| (p.id.clone(), p.version.clone())).collect()
        };
        let (before, after) = (key(&old), key(&all));
        *self.state.write().unwrap() = RegState { all, rejected };
        RescanDiff {
            added: after.difference(&before).cloned().collect(),
            removed: before.difference(&after).cloned().collect(),
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn ids(&self) -> Vec<String> {
        self.state.read().unwrap().all.keys().cloned().collect()
    }

    /// Installed versions of a plugin, ascending.
    pub fn versions(&self, id: &str) -> Vec<&'static Plugin> {
        self.state.read().unwrap().all.get(id).cloned().unwrap_or_default()
    }

    pub fn version(&self, id: &str, version: &str) -> Option<&'static Plugin> {
        self.versions(id).into_iter().find(|p| p.version == version)
    }

    pub fn set_active(&self, id: &str, version: Option<&str>) {
        let mut a = self.active.write().unwrap();
        match version {
            Some(v) => {
                a.insert(id.to_string(), v.to_string());
            }
            None => {
                a.remove(id);
            }
        }
    }

    pub fn active_version(&self, id: &str) -> Option<String> {
        self.active.read().unwrap().get(id).cloned()
    }

    /// The active version (the one used for new resources, trees, commands, settings).
    pub fn plugin(&self, id: &str) -> Option<&'static Plugin> {
        let vs = self.versions(id);
        match self.active.read().unwrap().get(id) {
            Some(v) => vs.into_iter().find(|p| &p.version == v),
            None => vs.last().copied(),
        }
    }

    /// The active version of every plugin, by id.
    pub fn plugins(&self) -> Vec<&'static Plugin> {
        self.ids().iter().filter_map(|id| self.plugin(id)).collect()
    }

    pub fn rejected(&self) -> Vec<Rejection> {
        self.state.read().unwrap().rejected.clone()
    }

    /// Splits `<pluginId>:<name>` (plugin ids contain no `:`).
    pub fn split(full: &str) -> Option<(&str, &str)> {
        full.split_once(':')
    }

    pub fn kind(&self, full: &str) -> Option<(&'static Plugin, &'static KindDecl)> {
        let (pid, k) = Self::split(full)?;
        let p = self.plugin(pid)?;
        Some((p, p.kind(k)?))
    }

    /// The kind as a given version declares it (a resource is handled by the version it is bound to).
    pub fn kind_at(&self, full: &str, version: Option<&str>) -> Option<(&'static Plugin, &'static KindDecl)> {
        let Some(v) = version else { return self.kind(full) };
        let (pid, k) = Self::split(full)?;
        let p = self.version(pid, v)?;
        Some((p, p.kind(k)?))
    }

    pub fn tree(&self, full: &str) -> Option<(&'static Plugin, &'static TreeDecl)> {
        let (pid, t) = Self::split(full)?;
        let p = self.plugin(pid)?;
        Some((p, p.tree(t)?))
    }

    /// Write rules of every kind of every installed version (tree and accepted children, full names).
    pub fn rules(&self) -> HashMap<String, KindRule> {
        let mut m = crate::pipeline::core_rules();
        let all = self.state.read().unwrap().all.clone();
        for p in all.values().flatten() {
            for k in &p.manifest.contributes.kinds {
                // A field protected by any installed version stays protected.
                let mut protected = k.protected_fields();
                if let Some(prev) = m.get(&p.full(&k.id)) {
                    protected.extend(prev.protected.iter().cloned());
                    protected.sort();
                    protected.dedup();
                }
                // Reference fields: those of any installed version (a resource may be bound to any).
                let (mut text_refs, mut ref_fields): (Vec<String>, Vec<String>) = (
                    k.fields.iter().filter(|(_, f)| f.text_refs()).map(|(n, _)| n.clone()).collect(),
                    k.fields.iter().filter(|(_, f)| f.ty == DeclType::Ref).map(|(n, _)| n.clone()).collect(),
                );
                if let Some(prev) = m.get(&p.full(&k.id)) {
                    text_refs.extend(prev.text_refs.iter().cloned());
                    ref_fields.extend(prev.ref_fields.iter().cloned());
                }
                for v in [&mut text_refs, &mut ref_fields] {
                    v.sort();
                    v.dedup();
                }
                m.insert(
                    p.full(&k.id),
                    KindRule {
                        tree: k.tree.as_deref().map(|t| p.tree_ref(t)),
                        accepts: k.accepts.iter().map(|a| p.kind_ref(a)).collect(),
                        protected,
                        text_refs,
                        ref_fields,
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
    fn round8_exports_trees_and_pages() {
        // An own stored tree and an own page.
        let m = with(good(), &["contributes", "trees"], json!([
            { "id": "disk", "label": "t", "icon": "folder", "source": "provided", "page": "editor" },
            { "id": "board", "label": "t", "icon": "folder", "source": "stored" }
        ]));
        let exp = |v: Value| with(m.clone(), &["exports"], v);
        assert_eq!(reason(exp(json!({ "trees": [{ "id": "board" }], "pages": [{ "id": "editor" }] }))), "ok");
        let tmp = tempfile::tempdir().unwrap();
        let p = load_package(&write(tmp.path(), "test.alpha", "0.1.0", &exp(json!({ "trees": [{ "id": "board" }], "pages": [{ "id": "editor" }] })))).unwrap();
        assert_eq!((p.manifest.exported_trees.clone(), p.manifest.exported_pages.clone()), (vec!["board".to_string()], vec!["editor".to_string()]));
        for bad in [
            json!({ "trees": [{ "id": "disk" }] }),
            json!({ "trees": [{ "id": "resources" }] }),
            json!({ "trees": [{ "id": "nope" }] }),
            json!({ "trees": [{ "id": "board" }, { "id": "board" }] }),
            json!({ "trees": [{ "id": "board", "write": true }] }),
            json!({ "trees": [{}] }),
            json!({ "trees": { "id": "board" } }),
            json!({ "trees": ["board"] }),
            json!({ "pages": [{ "id": "nope" }] }),
            json!({ "pages": [{ "id": "test.beta:editor" }] }),
            json!({ "pages": [{ "id": "editor" }, { "id": "editor" }] }),
            json!({ "pages": [{ "id": "editor", "x": 1 }] }),
        ] {
            assert_eq!(reason(exp(bad.clone())), "badExports", "{bad}");
        }
    }

    #[test]
    fn round8_full_name_tree_and_page() {
        let dep = with(good(), &["depends"], json!([{ "id": "test.beta", "version": "*" }]));
        let kind = |m: &Value, tree: Value, page: Value, accepts: Value| {
            with(m.clone(), &["contributes", "kinds", "0"], json!({ "id": "item", "label": "kind.item", "icon": "box",
                "tree": tree, "page": page, "accepts": accepts }))
        };
        // Each alone or both, when the plugin is in `depends`.
        assert_eq!(reason(kind(&dep, json!("test.beta:board"), json!("test.beta:card"), json!([]))), "ok");
        assert_eq!(reason(kind(&dep, json!("test.beta:board"), json!("editor"), json!(["item"]))), "ok");
        assert_eq!(reason(kind(&dep, json!("resources"), json!("test.beta:card"), json!([]))), "ok");
        // Not in `depends`.
        assert_eq!(reason(kind(&good(), json!("test.beta:board"), json!("editor"), json!([]))), "undeclaredDepend");
        assert_eq!(reason(kind(&good(), json!("resources"), json!("test.beta:card"), json!([]))), "undeclaredDepend");
        assert_eq!(reason(kind(&dep, json!("test.gamma:board"), json!("editor"), json!([]))), "undeclaredDepend");
        // Malformed names.
        assert_eq!(reason(kind(&dep, json!("test.beta:"), json!("editor"), json!([]))), "badName");
        assert_eq!(reason(kind(&dep, json!("resources"), json!("Bad Id:card"), json!([]))), "badName");
        // In another plugin's tree it accepts only its own kinds.
        assert_eq!(reason(kind(&dep, json!("test.beta:board"), json!("editor"), json!(["test.beta:card"]))), "unknownKind");
        assert_eq!(reason(kind(&dep, json!("test.beta:board"), json!("editor"), json!(["*"]))), "unknownKind");
        assert_eq!(reason(kind(&dep, json!("test.beta:board"), json!("editor"), json!(["test.alpha:item"]))), "ok");
        // Another plugin's page is a permission (`pages`), in the fingerprint; its tree is not.
        let tmp = tempfile::tempdir().unwrap();
        let both = load_package(&write(tmp.path(), "test.alpha", "0.1.0", &kind(&dep, json!("test.beta:board"), json!("test.beta:card"), json!([])))).unwrap();
        let tree_only = load_package(&write(tempfile::tempdir().unwrap().path(), "test.alpha", "0.1.0", &kind(&dep, json!("test.beta:board"), json!("editor"), json!([])))).unwrap();
        let plain = load_package(&write(tempfile::tempdir().unwrap().path(), "test.alpha", "0.1.0", &dep)).unwrap();
        assert!(both.permissions().contains("pages:test.beta:card"), "{:?}", both.permissions());
        assert_eq!(tree_only.permissions(), plain.permissions());
        assert_ne!(perm_fingerprint(&both.permissions()), perm_fingerprint(&plain.permissions()));
        let list = both.permission_list(|_| false);
        let pages = list.iter().find(|x| x.id == "pages").unwrap();
        assert_eq!(pages.detail, "test.beta:card");
        assert_eq!(both.tree_ref("test.beta:board"), "test.beta:board");
        assert_eq!(both.page_ref("test.beta:card"), ("test.beta".to_string(), "card".to_string()));
        assert_eq!(both.page_ref("editor"), ("test.alpha".to_string(), "editor".to_string()));
    }

    #[test]
    fn round7_depends_exports_and_requires_plugins() {
        let dep = |v: Value| with(good(), &["depends"], v);
        let ok = dep(json!([{ "id": "test.beta", "version": ">=0.1.0, <0.3.0" }]));
        assert_eq!(reason(ok.clone()), "ok");
        for bad in [
            json!({ "id": "test.beta" }),
            json!(["test.beta"]),
            json!([{ "id": "test.beta" }]),
            json!([{ "version": "1" }]),
            json!([{ "id": "test.beta", "version": "1", "optional": true }]),
            json!([{ "id": "Bad Id", "version": "1" }]),
            json!([{ "id": "test.alpha", "version": "1" }]),
            json!([{ "id": "test.beta", "version": "1" }, { "id": "test.beta", "version": "2" }]),
            json!([{ "id": "test.beta", "version": "not a range" }]),
            json!([{ "id": "test.beta", "version": 1 }]),
        ] {
            assert_eq!(reason(dep(bad.clone())), "badDepends", "{bad}");
        }
        let exp = |v: Value| with(good(), &["exports"], v);
        assert_eq!(reason(exp(json!({ "kinds": [{ "id": "item", "actions": true, "read": true }] }))), "ok");
        assert_eq!(reason(exp(json!({ "kinds": [] }))), "ok");
        for bad in [
            json!([]),
            json!({ "kinds": [], "outputs": [] }),
            json!({ "kinds": {} }),
            json!({ "kinds": [{ "id": "item", "write": true }] }),
            json!({ "kinds": [{ "id": "other", "read": true }] }),
            json!({ "kinds": [{ "id": "test.beta:item", "read": true }] }),
            json!({ "kinds": [{ "id": "item" }, { "id": "item" }] }),
            json!({ "kinds": [{ "id": "item", "read": "yes" }] }),
            json!({ "kinds": [{ "actions": true }] }),
        ] {
            assert_eq!(reason(exp(bad.clone())), "badExports", "{bad}");
        }
        let req = |v: Value| with(good(), &["requires", "plugins"], v);
        assert_eq!(reason(req(json!({ "install": true }))), "ok");
        assert_eq!(reason(req(json!({}))), "ok");
        for bad in [json!(true), json!({ "install": "yes" }), json!({ "install": true, "remove": true }), json!([])] {
            assert_eq!(reason(req(bad.clone())), "badPlugins", "{bad}");
        }
        // An action may name a kind of a plugin it depends on, by full name; nothing else.
        let action = |kinds: Value| {
            with(ok.clone(), &["contributes", "actions"], json!([{ "id": "count", "label": "a", "output": "text", "kinds": kinds }]))
        };
        let tmp = tempfile::tempdir().unwrap();
        let dir = write(tmp.path(), "test.alpha", "0.1.0", &action(json!(["test.beta:note", "item"])));
        let p = load_package(&dir).unwrap();
        assert_eq!(p.manifest.deps.len(), 1);
        assert!(p.permissions().contains("resources:test.beta:note"), "{:?}", p.permissions());
        assert_eq!(reason(action(json!(["test.gamma:note"]))), "unknownKind");
        assert_eq!(reason(action(json!(["test.alpha:item"]))), "unknownKind");
        // `read` enters the fingerprint; `depends` alone does not.
        let plain = load_package(&write(tempfile::tempdir().unwrap().path(), "test.alpha", "0.1.0", &good())).unwrap();
        let with_dep = load_package(&write(tempfile::tempdir().unwrap().path(), "test.alpha", "0.1.0", &ok)).unwrap();
        assert_eq!(perm_fingerprint(&plain.permissions()), perm_fingerprint(&with_dep.permissions()));
        assert_ne!(perm_fingerprint(&plain.permissions()), perm_fingerprint(&p.permissions()));
        let inst = load_package(&write(tempfile::tempdir().unwrap().path(), "test.alpha", "0.1.0", &req(json!({ "install": true })))).unwrap();
        assert!(inst.permissions().contains("plugins"));
        assert!(inst.manifest.requires.plugins_install());
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
        // Round 3 (D284): actions, page run items, result tabs, settings.
        let run_item = json!([{ "id": "go", "role": "run", "label": "a" }]);
        assert_eq!(reason(with(good(), &["contributes", "pages", "0", "actions"], run_item)), "missingAction");
        let run_item = json!([{ "id": "go", "role": "run", "label": "a", "action": "nope" }]);
        assert_eq!(reason(with(good(), &["contributes", "pages", "0", "actions"], run_item)), "unknownAction");
        let act = |o: Value| with(good(), &["contributes", "actions"], json!([o]));
        assert_eq!(reason(act(json!({ "id": "run", "label": "a", "output": "table", "kinds": ["nope"] }))), "unknownKind");
        assert_eq!(reason(act(json!({ "id": "run", "label": "a", "output": "chart" }))), "schema");
        assert_eq!(reason(act(json!({ "id": "run", "label": "a", "output": "table", "extra": 1 }))), "schema");
        assert_eq!(reason(act(json!({ "id": "run", "label": "a", "output": "table", "kinds": ["item"], "confirm": "k" }))), "ok");
        let tabs = json!([{ "id": "r", "type": "output", "label": "t" }, { "id": "r", "type": "view", "label": "t" }]);
        assert_eq!(reason(with(good(), &["contributes", "pages", "0", "resultTabs"], tabs)), "duplicate");
        assert_eq!(reason(with(good(), &["contributes", "pages", "0", "resultTabs"], json!([{ "id": "r", "type": "chart", "label": "t" }]))), "schema");
        let set = |o: Value| with(good(), &["contributes", "settings"], json!([o]));
        assert_eq!(reason(set(json!({ "name": "n", "label": "l", "type": "number", "default": "x" }))), "badSetting");
        assert_eq!(reason(set(json!({ "name": "n", "label": "l", "type": "boolean", "default": "yes" }))), "badSetting");
        assert_eq!(reason(set(json!({ "name": "n", "label": "l", "type": "enum", "default": "a" }))), "badSetting");
        assert_eq!(reason(set(json!({ "name": "n", "label": "l", "type": "enum", "default": "b", "options": [{ "value": "a", "label": "x" }] }))), "badSetting");
        assert_eq!(reason(set(json!({ "name": "n", "label": "l", "type": "text", "default": "", "options": [] }))), "badSetting");
        assert_eq!(reason(set(json!({ "name": "n", "label": "l", "type": "color", "default": "" }))), "schema");
        assert_eq!(reason(with(good(), &["contributes", "settings"], json!([{ "name": "n", "label": "l", "type": "text", "default": "" }, { "name": "n", "label": "l", "type": "text", "default": "" }]))), "duplicate");
        assert_eq!(reason(with(good(), &["author"], json!(5))), "schema");
        assert_eq!(reason(with(good(), &["contributes", "commands", "0", "palette"], json!("yes"))), "schema");
        // Round 4.
        assert_eq!(reason(with(good(), &["upgradesFrom"], json!("not a range"))), "badUpgradesFrom");
        assert_eq!(reason(with(good(), &["upgradesFrom"], json!(">=0.1.0"))), "ok");
        assert_eq!(reason(with(good(), &["requires", "network"], json!({ "hosts": ["Bad Host"] }))), "badHost");
        assert_eq!(reason(with(good(), &["requires", "network"], json!({ "hosts": ["a.com:99999"] }))), "badHost");
        assert_eq!(reason(with(good(), &["requires", "network"], json!({ "hosts": ["*.a.com", "b.com:8080"], "other": 1 }))), "schema");
        assert_eq!(reason(with(good(), &["requires", "secrets"], json!({ "names": ["no spaces"] }))), "badSecretName");
        assert_eq!(reason(with(good(), &["requires", "secrets"], json!({ "names": ["ok-name"], "plaintext": true }))), "ok");
        let field = |f: Value| with(good(), &["contributes", "kinds", "0", "fields"], json!({ "url": f }));
        assert_eq!(reason(field(json!({ "type": "text", "grants": "network" }))), "grantsUndeclared");
        assert_eq!(reason(with(field(json!({ "type": "text", "grants": "files" })), &["requires", "network"], json!({ "fromResources": true }))), "badGrants");
        assert_eq!(reason(with(field(json!({ "type": "secret", "grants": "network" })), &["requires", "network"], json!({ "fromResources": true }))), "badGrants");
        assert_eq!(reason(with(field(json!({ "type": "text", "grants": "network" })), &["requires", "network"], json!({ "fromResources": true }))), "ok");
        assert_eq!(reason(field(json!({ "type": "colour" }))), "schema");
        assert_eq!(reason(field(json!({ "type": "text", "secrets": true }))), "ok");
        assert_eq!(reason(field(json!({ "type": "number", "secrets": true }))), "badSecretsField");
        assert_eq!(reason(with(field(json!({ "type": "text", "grants": "network", "secrets": true })), &["requires", "network"], json!({ "fromResources": true }))), "badSecretsField");
        assert_eq!(reason(with(good(), &["contributes", "commands", "0", "palette"], json!(true))), "ok");
        assert_eq!(reason(with(with(good(), &["author"], json!("me")), &["license"], json!("MIT"))), "ok");
    }

    #[test]
    fn program_and_event_declarations_and_their_rejections() {
        let progs = |v: Value| with(good(), &["requires", "programs"], v);
        assert_eq!(reason(progs(json!([{ "name": "echo", "source": "system" }]))), "ok");
        assert_eq!(reason(progs(json!([{ "name": "x", "source": "plugin", "path": "bin/x.sh" }]))), "ok", "a missing file is reported at run time");
        for bad in [
            json!([{ "name": "echo", "source": "system", "path": "bin/echo" }]),
            json!([{ "name": "x", "source": "plugin" }]),
            json!([{ "name": "x", "source": "plugin", "path": "../x" }]),
            json!([{ "name": "x", "source": "plugin", "path": "/bin/echo" }]),
            json!([{ "name": "x", "source": "plugin", "path": "" }]),
            json!([{ "name": "x", "source": "elsewhere" }]),
            json!([{ "name": "a b", "source": "system" }]),
            json!([{ "name": "a/b", "source": "system" }]),
            json!([{ "name": "", "source": "system" }]),
            json!([{ "name": "x".repeat(65), "source": "system" }]),
            json!([{ "name": "echo", "source": "system" }, { "name": "echo", "source": "system" }]),
        ] {
            assert_eq!(reason(progs(bad.clone())), "badPrograms", "{bad}");
        }
        // A link that leads out of the package.
        let tmp = tempfile::tempdir().unwrap();
        let dir = write(tmp.path(), "test.alpha", "0.1.0", &progs(json!([{ "name": "x", "source": "plugin", "path": "bin/x" }])));
        std::fs::create_dir_all(dir.join("bin")).unwrap();
        std::os::unix::fs::symlink("/bin/echo", dir.join("bin/x")).unwrap();
        assert_eq!(load_package(&dir).unwrap_err().reason, "badPrograms");

        let evs = |v: Value| with(good(), &["contributes", "events"], v);
        assert_eq!(reason(evs(json!(["resource.changed", "run.ended"]))), "ok");
        assert_eq!(reason(evs(json!(["resource.saved"]))), "badEvents");
        assert_eq!(reason(evs(json!(["run.ended", "run.ended"]))), "badEvents");

        // The program list is part of the permissions and of their fingerprint (D331).
        let tmp = tempfile::tempdir().unwrap();
        let one = load_package(&write(tmp.path(), "test.alpha", "0.1.0", &progs(json!([{ "name": "echo", "source": "system" }])))).unwrap();
        let tmp2 = tempfile::tempdir().unwrap();
        let two = load_package(&write(
            tmp2.path(),
            "test.alpha",
            "0.1.0",
            &progs(json!([{ "name": "echo", "source": "system" }, { "name": "hello", "source": "plugin", "path": "bin/hello.sh" }])),
        ))
        .unwrap();
        assert_ne!(perm_fingerprint(&one.permissions()), perm_fingerprint(&two.permissions()));
        let list = two.permission_list(|_| false);
        let programs = list.iter().find(|p| p.id == "programs").unwrap();
        assert_eq!(programs.detail, "echo, hello (plugin)");
    }

    #[test]
    fn reference_field_declarations_and_their_rejections() {
        let field = |f: Value| with(good(), &["contributes", "kinds", "0", "fields"], json!({ "body": f }));
        let net = |m: Value| with(m, &["requires", "network"], json!({ "fromResources": true }));
        for ty in ["text", "longtext", "code"] {
            assert_eq!(reason(field(json!({ "type": ty, "refs": true }))), "ok", "{ty}");
        }
        assert_eq!(reason(field(json!({ "type": "ref" }))), "ok");
        // refs and secrets on one field: two different marks, allowed.
        assert_eq!(reason(field(json!({ "type": "longtext", "refs": true, "secrets": true }))), "ok");
        for ty in ["number", "boolean", "date", "datetime", "enum", "secret", "ref"] {
            assert_eq!(reason(field(json!({ "type": ty, "refs": true }))), "badRefsField", "{ty}");
        }
        assert_eq!(reason(net(field(json!({ "type": "text", "refs": true, "grants": "network" })))), "badRefsField");
        assert_eq!(reason(net(field(json!({ "type": "ref", "grants": "network" })))), "badRefsField");
        assert_eq!(reason(field(json!({ "type": "ref", "secrets": true }))), "badSecretsField");
        assert_eq!(reason(field(json!({ "type": "text", "refs": "yes" }))), "schema");
        // The write rules carry the reference fields.
        let tmp = tempfile::tempdir().unwrap();
        let m = with(good(), &["contributes", "kinds", "0", "fields"], json!({ "body": { "type": "longtext", "refs": true }, "to": { "type": "ref" } }));
        write(tmp.path(), "test.alpha", "0.1.0", &m);
        let rules = Registry::scan(tmp.path()).rules();
        let r = &rules["test.alpha:item"];
        assert_eq!((r.text_refs.clone(), r.ref_fields.clone()), (vec!["body".to_string()], vec!["to".to_string()]));
    }

    #[test]
    fn registry_keeps_the_highest_version_and_lists_rejections() {
        let tmp = tempfile::tempdir().unwrap();
        write(tmp.path(), "test.alpha", "0.1.0", &good());
        write(tmp.path(), "test.alpha", "0.10.0", &with(good(), &["version"], json!("0.10.0")));
        write(tmp.path(), "test.alpha", "0.2.0", &good()); // version mismatch: rejected
        let reg = Registry::scan(tmp.path());
        assert_eq!(reg.plugins().len(), 1);
        assert_eq!(reg.plugins()[0].version, "0.10.0");
        assert_eq!(reg.rejected().len(), 1);
        let rules = reg.rules();
        assert_eq!(rules["test.alpha:item"].tree.as_deref(), Some("resources"));
    }
}
