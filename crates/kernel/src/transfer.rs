//! Round 5 methods (docs/handoff/round5-plan.md §3–§7): reference queries, known parameters,
//! workspace export / import (kernel-design §3.5, D324–D326) and exporting a run's table (D328).

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::io::Write as _;
use std::path::{Path, PathBuf};

use onedesk_protocol::method5 as M;
use onedesk_protocol::*;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::kernel::{parse, Inner};
use crate::manifest::{DeclType, KindDecl, Registry};
use crate::pipeline::{Actor, Command, Tx};
use crate::refs::RefRow;
use crate::store::{self, Row, KIND_CONFIG, KIND_ENV, KIND_GROUP, TREE_PLUGIN_STATE, TREE_RESOURCES};
use crate::util::*;

pub const METHODS: &[&str] =
    &[M::REFS_OUTGOING, M::REFS_INCOMING, M::PARAMS_KNOWN, M::WORKSPACE_EXPORT, M::WORKSPACE_IMPORT_PREVIEW, M::WORKSPACE_IMPORT, M::RUN_EXPORT];

pub const EXPORT_FORMAT: &str = "onedesk-export";
pub const EXPORT_VERSION: u32 = 1;

fn to_value<T: Serialize>(v: T) -> KResult<Value> {
    serde_json::to_value(v).map_err(internal)
}

fn sql(e: rusqlite::Error) -> ProtocolError {
    internal(e)
}

fn write_failed(e: std::io::Error) -> ProtocolError {
    let mut x = invalid("writeFailed");
    x.detail = Some(e.to_string());
    x
}

/* ------------------------------------------------------------------ export file format (v1) */

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportWorkspace {
    #[serde(default)]
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportCounts {
    pub resources: u32,
    pub revisions: u32,
    pub runs: u32,
    pub audit: u32,
    pub blobs: u32,
}

/// `manifest.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportManifest {
    pub format: String,
    pub version: u32,
    pub workspace: ExportWorkspace,
    #[serde(default)]
    pub exported_at: i64,
    #[serde(default)]
    pub counts: ExportCounts,
    #[serde(default)]
    pub app_version: String,
}

/// One reference of an exported resource (`target` is an id of the same export, or absent).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportRef {
    pub field: String,
    pub seq: i64,
    pub text: String,
    #[serde(default)]
    pub target: Option<String>,
}

/// One node of `resources.json`. Only `id`, `kind` and `name` are required when reading.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResource {
    pub id: String,
    pub kind: String,
    #[serde(default)]
    pub plugin: Option<String>,
    #[serde(default)]
    pub plugin_version: Option<String>,
    #[serde(default)]
    pub tree: Option<String>,
    #[serde(default)]
    pub parent: Option<String>,
    #[serde(default)]
    pub pos: i64,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub body: JsonMap,
    #[serde(default)]
    pub external_key: Option<String>,
    #[serde(default)]
    pub rev: i64,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub created_by: String,
    #[serde(default)]
    pub updated_at: i64,
    #[serde(default)]
    pub updated_by: String,
    /// The `refs` rows of this resource. Absent (a hand-written export): resolved by name on import.
    #[serde(default)]
    pub refs: Option<Vec<ExportRef>>,
}

/// File name → content of one export.
type ExportFiles = Vec<(&'static str, Vec<u8>)>;

/// Keys sorted at every level, two-space indentation: readable and diffable (§3.5).
fn pretty(v: Value) -> Vec<u8> {
    fn sorted(v: Value) -> Value {
        match v {
            Value::Object(m) => {
                let b: BTreeMap<String, Value> = m.into_iter().map(|(k, v)| (k, sorted(v))).collect();
                let mut out = serde_json::Map::new();
                for (k, v) in b {
                    out.insert(k, v);
                }
                Value::Object(out)
            }
            Value::Array(a) => Value::Array(a.into_iter().map(sorted).collect()),
            o => o,
        }
    }
    let mut s = serde_json::to_vec_pretty(&sorted(v)).expect("json");
    s.push(b'\n');
    s
}

fn parse_json_text(s: &str) -> Value {
    serde_json::from_str(s).unwrap_or(Value::String(s.to_string()))
}

/* ------------------------------------------------------------------ import plan (writer side) */

#[derive(Debug, Clone)]
pub enum GroupChoice {
    Existing(String),
    /// A new top-level group of the resources tree; the name gets a number when taken.
    New(String),
}

#[derive(Debug, Clone)]
pub enum ParentChoice {
    /// The import group.
    Group,
    /// Top level of the item's tree.
    Top,
    /// A node created earlier in the same import, or an existing one.
    Id(String),
}

#[derive(Debug, Clone)]
pub struct ImportItem {
    pub id: String,
    /// `id` is an existing resource with the same external key: its content is replaced.
    pub update: bool,
    pub kind: String,
    pub tree: Option<String>,
    pub parent: ParentChoice,
    pub name: String,
    pub description: String,
    pub tags: Vec<String>,
    pub body: JsonMap,
    pub plugin_version: Option<String>,
    pub external_key: Option<String>,
    /// The export's `refs` rows, targets rewritten to new ids (or none): hints only (review #8).
    pub hints: Vec<RefRow>,
    /// Single references whose target was not imported: (`body.<key>`, text), review #4.
    pub lost: Vec<(String, String)>,
    /// Roots of the environment tree get a number when their name is taken.
    pub unique_name: bool,
}

#[derive(Debug, Clone)]
pub struct ImportPlan {
    /// Name of the source workspace (audit object).
    pub source: String,
    pub group: GroupChoice,
    pub items: Vec<ImportItem>,
    pub skipped: u32,
}

fn unique_name(tx: &rusqlite::Connection, tree: &str, parent: Option<&str>, name: &str) -> KResult<String> {
    let sibs = store::children(tx, tree, parent, 0, u32::MAX).map_err(sql)?;
    let taken = |n: &str| sibs.iter().any(|s| s.name == n);
    let mut candidate = name.to_string();
    let mut i = 2;
    while taken(&candidate) {
        candidate = format!("{name} {i}");
        i += 1;
    }
    Ok(candidate)
}

impl Tx<'_> {
    /// D325: the whole import in this one transaction; any failure leaves everything as it was.
    pub(crate) fn import(&mut self, plan: ImportPlan) -> KResult<crate::pipeline::Outcome> {
        let mut rows = Vec::new();
        let group = match &plan.group {
            GroupChoice::Existing(id) => {
                let g = self.live(id).map_err(|_| invalid("badParent"))?;
                if g.kind != KIND_GROUP || g.tree.as_deref() != Some(TREE_RESOURCES) {
                    return Err(invalid("badParent"));
                }
                g
            }
            GroupChoice::New(name) => {
                let name = unique_name(self.tx, TREE_RESOURCES, None, if name.trim().is_empty() { "Import" } else { name })?;
                let out = self.create(crate::pipeline::NewResource {
                    kind: KIND_GROUP.into(),
                    tree: Some(TREE_RESOURCES.into()),
                    parent: None,
                    name,
                    description: String::new(),
                    tags: vec![],
                    body: JsonMap::new(),
                    plugin_version: None,
                })?;
                out.rows.into_iter().next().ok_or_else(|| internal("no group"))?
            }
        };
        let actor = self.actor.as_text();
        let (mut created, mut updated) = (0u32, 0u32);
        for it in &plan.items {
            if it.update {
                let mut row = self.live(&it.id)?;
                let mut changed = Vec::new();
                if row.name != it.name {
                    row.name = it.name.clone();
                    changed.push("name".to_string());
                }
                if row.description != it.description {
                    row.description = it.description.clone();
                    changed.push("description".into());
                }
                if row.tags != it.tags {
                    row.tags = it.tags.clone();
                    changed.push("tags".into());
                }
                let keys: BTreeSet<String> = row.body.keys().chain(it.body.keys()).cloned().collect();
                for k in keys {
                    if row.body.get(&k) != it.body.get(&k) {
                        changed.push(format!("body.{k}"));
                    }
                }
                row.body = it.body.clone();
                if it.plugin_version.is_some() && row.plugin_version != it.plugin_version {
                    row.plugin_version = it.plugin_version.clone();
                    changed.push("pluginVersion".into());
                }
                updated += 1;
                if changed.is_empty() {
                    continue;
                }
                row.rev += 1;
                row.updated_at = self.at;
                row.updated_by = actor.clone();
                self.save(&row)?;
                self.revision(&row, "import", &changed)?;
                if changed.iter().any(|f| f == "name") {
                    self.touch_ends(&row.id)?;
                }
                rows.push(row);
                continue;
            }
            // Review #1: the tree the kernel decided by the creation rules; the parent must accept it.
            let tree = it.tree.clone();
            if tree.is_none() || (it.kind != KIND_GROUP && self.rules.get(&it.kind).and_then(|r| r.tree.clone()) != tree) {
                return Err(invalid("otherTree"));
            }
            let parent = match &it.parent {
                ParentChoice::Group => Some(group.id.clone()),
                ParentChoice::Top => None,
                ParentChoice::Id(p) => Some(p.clone()),
            };
            self.check_parent(&it.kind, tree.as_deref(), parent.as_deref())?;
            let name = if it.unique_name {
                unique_name(self.tx, tree.as_deref().unwrap_or_default(), parent.as_deref(), &it.name)?
            } else {
                it.name.clone()
            };
            if name.trim().is_empty() {
                return Err(invalid("emptyName"));
            }
            let row = Row {
                id: it.id.clone(),
                kind: it.kind.clone(),
                plugin_version: it.plugin_version.clone(),
                pos: self.next_pos(tree.as_deref(), parent.as_deref())?,
                tree,
                parent_id: parent,
                name,
                description: it.description.clone(),
                tags: it.tags.clone(),
                body: it.body.clone(),
                origin: "original".into(),
                origin_ref: None,
                state: "ok".into(),
                rev: 1,
                created_at: self.at,
                created_by: actor.clone(),
                updated_at: self.at,
                updated_by: actor.clone(),
                deleted_at: None,
            };
            self.insert(&row)?;
            if let Some(k) = &it.external_key {
                self.tx.execute("UPDATE resources SET external_key = ?2 WHERE id = ?1", params![row.id, k]).map_err(sql)?;
            }
            self.revision(&row, "import", &["*".to_string()])?;
            created += 1;
            rows.push(row);
        }
        // References once every row is in, from the content (review #8: the file's rows are hints).
        for it in &plan.items {
            let Some(row) = store::get(self.tx, &it.id).map_err(sql)? else { continue };
            if let Some(rule) = self.rules.get(&row.kind) {
                let t = crate::refs::import_rows(self.tx, rule, &row, &it.hints, &it.lost).map_err(sql)?;
                self.touched.borrow_mut().extend(t);
            }
        }
        // D330: references here that were waiting for an imported name.
        for it in &plan.items {
            if let Some(row) = store::get(self.tx, &it.id).map_err(sql)? {
                self.connect_name(&row)?;
            }
        }
        self.audit(
            "workspace.import",
            &plan.source,
            &json!({ "group": group.id, "created": created, "updated": updated, "skipped": plan.skipped }),
        )?;
        let mut all = vec![group.clone()];
        all.extend(rows);
        Ok(crate::pipeline::Outcome { id: Some(group.id), changed: true, rows: all, touched: vec![] })
    }
}

/* ------------------------------------------------------------------ kernel side */

/// Review #5: limits of what an import reads.
pub const MAX_IMPORT_FILE_BYTES: u64 = 256 * 1024 * 1024;
pub const MAX_IMPORT_ITEMS: usize = 200_000;

/// What preview and import share.
struct Analysis {
    manifest: ExportManifest,
    resources: Vec<ExportResource>,
    fingerprint: String,
    decisions: Vec<Decision>,
    trees: Vec<Option<String>>,
    grant_hosts: Vec<String>,
    secret_names: Vec<String>,
}

/// How one exported node would be imported.
enum Decision {
    /// Bound to `version`; `migrate`: the active version takes it over from the exported one.
    Create { version: Option<String>, migrate: bool },
    Update { id: String, version: Option<String>, migrate: bool },
    Skip(&'static str),
}

/// Declared body fields against their values (§3.5 "过不了类型校验").
fn valid_body(decl: Option<&KindDecl>, r: &ExportResource) -> bool {
    if r.name.trim().is_empty() {
        return false;
    }
    let Some(decl) = decl else { return true };
    decl.fields.iter().all(|(k, f)| match r.body.get(k) {
        None | Some(Value::Null) => true,
        Some(v) => match f.ty {
            DeclType::Text | DeclType::Longtext | DeclType::Code | DeclType::Date | DeclType::Datetime | DeclType::Enum => v.is_string(),
            DeclType::Number => v.is_number(),
            DeclType::Boolean => v.is_boolean(),
            DeclType::Ref => v.get("ref").is_some_and(|x| x.is_string() || x.is_null()),
            DeclType::Secret => v.get("secret").is_some_and(|x| x.is_string() || x.is_null()),
        },
    })
}

impl Inner {
    pub async fn handle5(&self, m: &str, params: Value) -> Option<KResult<Value>> {
        Some(match m {
            M::REFS_OUTGOING => parse::<RefsParams>(params).and_then(|p| self.refs_outgoing(&p.id)).and_then(to_value),
            M::REFS_INCOMING => parse::<RefsParams>(params).and_then(|p| self.refs_incoming(&p.id)).and_then(to_value),
            M::PARAMS_KNOWN => to_value(crate::policy::known()),
            M::WORKSPACE_EXPORT => match parse::<WorkspaceFolderParams>(params) {
                Ok(p) => self.export(&p.folder).await.and_then(to_value),
                Err(e) => Err(e),
            },
            M::WORKSPACE_IMPORT_PREVIEW => parse::<WorkspaceFolderParams>(params).and_then(|p| self.import_preview(&p.folder)).and_then(to_value),
            M::WORKSPACE_IMPORT => match parse::<ImportParams>(params) {
                Ok(p) => self.import(p).await.and_then(to_value),
                Err(e) => Err(e),
            },
            M::RUN_EXPORT => match parse::<RunExportParams>(params) {
                Ok(p) => self.run_export(p).await.and_then(to_value),
                Err(e) => Err(e),
            },
            _ => return None,
        })
    }

    /* ---------------------------------------------------------------- references */

    fn named(&self, r: &Row) -> NamedRef {
        NamedRef { id: r.id.clone(), name: r.name.clone() }
    }

    fn ref_target(&self, target: Option<&str>) -> KResult<(Option<NamedRef>, RefState)> {
        let Some(t) = target else { return Ok((None, RefState::Missing)) };
        Ok(match self.read(|c| store::get_any(c, t))? {
            Some(r) if r.deleted_at.is_some() => (Some(self.named(&r)), RefState::Deleted),
            Some(r) => (Some(self.named(&r)), RefState::Ok),
            None => (None, RefState::Missing),
        })
    }

    /// Round 6: the label the source kind's declaration gives the field (`body.<key>`), if any.
    fn field_label(&self, src: &Row, field: &str) -> Option<Label> {
        let key = field.strip_prefix("body.")?;
        let (p, k) = self.registry.kind_at(&src.kind, src.plugin_version.as_deref()).or_else(|| self.registry.kind(&src.kind))?;
        k.fields.get(key)?.label.as_deref().map(|l| p.label(l))
    }

    fn visible_row(&self, id: &str) -> KResult<Row> {
        match self.read(|c| store::get_any(c, id))? {
            Some(r) if !self.hidden_tree(&r) => Ok(r),
            _ => Err(not_found("resource")),
        }
    }

    pub fn refs_outgoing(&self, id: &str) -> KResult<Vec<RefInfo>> {
        let src = self.visible_row(id)?;
        let mut out = Vec::new();
        for r in self.read(|c| crate::refs::rows_of(c, id))? {
            let (target, state) = self.ref_target(r.target.as_deref())?;
            let field_label = self.field_label(&src, &r.field);
            out.push(RefInfo { source: self.named(&src), field: r.field, text: r.text, target, state, field_label });
        }
        Ok(out)
    }

    pub fn refs_incoming(&self, id: &str) -> KResult<Vec<RefInfo>> {
        let me = self.visible_row(id)?;
        let state = if me.deleted_at.is_some() { RefState::Deleted } else { RefState::Ok };
        let mut out = Vec::new();
        for (src, r) in self.read(|c| crate::refs::sources_of(c, id, false))? {
            let Some(s) = self.read(|c| store::get(c, &src))? else { continue };
            let field_label = self.field_label(&s, &r.field);
            out.push(RefInfo { source: self.named(&s), field: r.field, text: r.text, target: Some(self.named(&me)), state, field_label });
        }
        Ok(out)
    }

    /// The row as readers see it: resolved `[[old]]` marks show the target's current name (D321).
    pub fn display_row(&self, r: &Row) -> KResult<Row> {
        let rule = self.rules.read().unwrap().get(&r.kind).cloned();
        self.read(|c| crate::refs::display(c, rule.as_ref(), r))
    }

    /* ---------------------------------------------------------------- paths */

    /// The data folder (the workspace folder, the data root above `workspaces/`, the plugins folder):
    /// nothing is exported into it (§3.5).
    fn data_roots(&self) -> Vec<PathBuf> {
        let mut out = vec![self.ws.dir.clone(), self.registry.root().to_path_buf()];
        if let Some(parent) = self.ws.dir.parent() {
            if parent.file_name().is_some_and(|n| n == "workspaces") {
                out.extend(parent.parent().map(Path::to_path_buf));
            }
        }
        out.into_iter().map(|p| std::fs::canonicalize(&p).unwrap_or(p)).collect()
    }

    /// An absolute path whose parent exists, outside the data folder; returns it with the parent
    /// resolved (links followed).
    fn outside_path(&self, raw: &str) -> KResult<PathBuf> {
        let p = Path::new(raw);
        if !p.is_absolute() {
            return Err(invalid("notAbsolute"));
        }
        let (Some(parent), Some(name)) = (p.parent(), p.file_name()) else { return Err(invalid("notAbsolute")) };
        if name == ".." || name == "." {
            return Err(invalid("notAbsolute"));
        }
        let parent = std::fs::canonicalize(parent).map_err(|_| invalid("noParent"))?;
        if !parent.is_dir() {
            return Err(invalid("noParent"));
        }
        let full = parent.join(name);
        if self.data_roots().iter().any(|d| full.starts_with(d)) {
            return Err(invalid("insideDataDir"));
        }
        Ok(full)
    }

    /* ---------------------------------------------------------------- export */

    pub async fn export(&self, folder: &str) -> KResult<ExportResult> {
        if let Err(e) = self.read(|c| Ok(crate::policy::check(c, crate::policy::NO_EXPORT, None)))? {
            self.refused("workspace.export", folder, e.clone()).await;
            return Err(e);
        }
        let target = self.outside_path(folder)?;
        if target.exists() {
            let empty = target.is_dir() && std::fs::read_dir(&target).map(|mut d| d.next().is_none()).unwrap_or(false);
            if !empty {
                return Err(invalid("notEmpty"));
            }
        }
        let (files, counts) = self.export_files()?;
        let tmp = target.with_file_name(format!(".{}.onedesk-export-{}", target.file_name().unwrap_or_default().to_string_lossy(), new_id()));
        let write = || -> std::io::Result<()> {
            std::fs::create_dir(&tmp)?;
            std::fs::create_dir(tmp.join("blobs"))?;
            for (name, bytes) in &files {
                std::fs::write(tmp.join(name), bytes)?;
            }
            if target.exists() {
                std::fs::remove_dir(&target)?;
            }
            std::fs::rename(&tmp, &target)
        };
        if let Err(e) = write() {
            let _ = std::fs::remove_dir_all(&tmp);
            return Err(write_failed(e));
        }
        let summary = to_value(&counts)?;
        let shown = target.to_string_lossy().into_owned();
        self.execute(Actor::User, Command::Audit { op: "workspace.export".into(), object: shown.clone(), summary }).await?;
        Ok(ExportResult {
            folder: shown,
            resources: counts.resources,
            revisions: counts.revisions,
            runs: counts.runs,
            audit: counts.audit,
            blobs: counts.blobs,
        })
    }

    /// Writes the refusal's audit row (the pipeline does it for refused writes).
    async fn refused(&self, op: &str, object: &str, error: ProtocolError) {
        let _ = self.pipeline.execute(Actor::User, Command::Refused { op: op.into(), object: object.into(), error }).await;
    }

    /// The export's files from one consistent read (D324).
    fn export_files(&self) -> KResult<(ExportFiles, ExportCounts)> {
        let snapshot = self.read(|c| {
            c.execute_batch("BEGIN")?;
            let r = (|| -> rusqlite::Result<_> {
                let mut st = c.prepare(&format!(
                    "SELECT {}, external_key FROM resources WHERE deleted_at IS NULL AND (tree IS NULL OR tree <> ?1) ORDER BY tree, parent_id, pos, id",
                    store::COLUMNS
                ))?;
                let rows: Vec<(Row, Option<String>)> =
                    st.query_map([TREE_PLUGIN_STATE], |r| Ok((store::from_sql(r)?, r.get(19)?)))?.collect::<Result<_, _>>()?;
                drop(st);
                let mut refs = HashMap::new();
                for (r, _) in &rows {
                    refs.insert(r.id.clone(), crate::refs::rows_of(c, &r.id)?);
                }
                let mut st = c.prepare("SELECT resource_id, rev, at, actor, op, fields, snapshot, restored_from FROM revisions ORDER BY resource_id, rev")?;
                let revs: Vec<Value> = st
                    .query_map([], |r| {
                        Ok(json!({ "resourceId": r.get::<_, String>(0)?, "rev": r.get::<_, i64>(1)?, "at": r.get::<_, i64>(2)?,
                                   "actor": r.get::<_, String>(3)?, "op": r.get::<_, String>(4)?,
                                   "fields": parse_json_text(&r.get::<_, String>(5)?), "snapshot": parse_json_text(&r.get::<_, String>(6)?),
                                   "restoredFrom": r.get::<_, Option<String>>(7)? }))
                    })?
                    .collect::<Result<_, _>>()?;
                drop(st);
                let mut st = c.prepare(
                    "SELECT id, seq, title, resource_id, resource_kind, plugin, action, env_name, actor, source, started_at, ended_at,
                            status, params, input, summary, error, kept, kept_name FROM runs ORDER BY seq",
                )?;
                let runs: Vec<Value> = st
                    .query_map([], |r| {
                        let o = |i: usize| -> rusqlite::Result<Value> { Ok(r.get::<_, Option<String>>(i)?.map(|s| parse_json_text(&s)).unwrap_or(Value::Null)) };
                        Ok(json!({ "id": r.get::<_, String>(0)?, "seq": r.get::<_, i64>(1)?, "title": r.get::<_, String>(2)?,
                                   "resourceId": r.get::<_, Option<String>>(3)?, "resourceKind": r.get::<_, Option<String>>(4)?,
                                   "plugin": r.get::<_, String>(5)?, "action": r.get::<_, String>(6)?, "envName": r.get::<_, Option<String>>(7)?,
                                   "actor": r.get::<_, String>(8)?, "source": r.get::<_, String>(9)?, "startedAt": r.get::<_, i64>(10)?,
                                   "endedAt": r.get::<_, Option<i64>>(11)?, "status": r.get::<_, String>(12)?, "params": o(13)?, "input": o(14)?,
                                   "summary": o(15)?, "error": o(16)?, "kept": r.get::<_, i64>(17)? != 0, "keptName": r.get::<_, Option<String>>(18)? }))
                    })?
                    .collect::<Result<_, _>>()?;
                drop(st);
                let mut st = c.prepare("SELECT seq, at, actor, op, object, summary, result FROM audit ORDER BY seq")?;
                let audit: Vec<Value> = st
                    .query_map([], |r| {
                        Ok(json!({ "seq": r.get::<_, i64>(0)?, "at": r.get::<_, i64>(1)?, "actor": r.get::<_, String>(2)?,
                                   "op": r.get::<_, String>(3)?, "object": r.get::<_, String>(4)?,
                                   "summary": parse_json_text(&r.get::<_, String>(5)?), "result": r.get::<_, String>(6)? }))
                    })?
                    .collect::<Result<_, _>>()?;
                Ok((rows, refs, revs, runs, audit))
            })();
            c.execute_batch("COMMIT")?;
            r
        })?;
        let (rows, refs, revs, runs, audit) = snapshot;
        let ordered = depth_first(rows);
        let ids: BTreeSet<&String> = ordered.iter().map(|(r, _)| &r.id).collect();
        let revs: Vec<Value> = revs.into_iter().filter(|v| v["resourceId"].as_str().is_some_and(|i| ids.contains(&i.to_string()))).collect();
        let runs: Vec<Value> =
            runs.into_iter().filter(|v| v["resourceId"].as_str().is_none_or(|i| ids.contains(&i.to_string()))).collect();
        let resources: Vec<ExportResource> = ordered
            .iter()
            .map(|(r, key)| ExportResource {
                id: r.id.clone(),
                kind: r.kind.clone(),
                plugin: Registry::split(&r.kind).map(|(p, _)| p.to_string()).filter(|p| p != "core"),
                plugin_version: r.plugin_version.clone(),
                tree: r.tree.clone(),
                parent: r.parent_id.clone(),
                pos: r.pos,
                name: r.name.clone(),
                description: r.description.clone(),
                tags: r.tags.clone(),
                body: r.body.clone(),
                external_key: key.clone(),
                rev: r.rev,
                created_at: r.created_at,
                created_by: r.created_by.clone(),
                updated_at: r.updated_at,
                updated_by: r.updated_by.clone(),
                refs: Some(
                    refs.get(&r.id)
                        .into_iter()
                        .flatten()
                        .map(|x| ExportRef { field: x.field.clone(), seq: x.seq, text: x.text.clone(), target: x.target.clone() })
                        .collect(),
                ),
            })
            .collect();
        let counts = ExportCounts {
            resources: resources.len() as u32,
            revisions: revs.len() as u32,
            runs: runs.len() as u32,
            audit: audit.len() as u32,
            blobs: 0,
        };
        let manifest = ExportManifest {
            format: EXPORT_FORMAT.into(),
            version: EXPORT_VERSION,
            workspace: ExportWorkspace { id: self.ws.id.clone(), name: self.ws.name.clone() },
            exported_at: now_ms(),
            counts: counts.clone(),
            app_version: env!("CARGO_PKG_VERSION").into(),
        };
        let files = vec![
            ("manifest.json", pretty(to_value(&manifest)?)),
            ("resources.json", pretty(to_value(&resources)?)),
            ("revisions.json", pretty(Value::Array(revs))),
            ("runs.json", pretty(Value::Array(runs))),
            ("audit.json", pretty(Value::Array(audit))),
        ];
        Ok((files, counts))
    }

    /* ---------------------------------------------------------------- import */

    /// `manifest.json` and `resources.json` of an export folder, and their fingerprint. Review #5:
    /// sizes are checked before reading; review #8: ids must be unique.
    fn read_export(&self, folder: &str) -> Result<(ExportManifest, Vec<ExportResource>, String), &'static str> {
        let dir = Path::new(folder);
        if !dir.is_absolute() {
            return Err("unreadable");
        }
        let size = |p: &Path| std::fs::metadata(p).map(|m| m.len());
        let mpath = dir.join("manifest.json");
        if size(&mpath).map_err(|_| "notExport")? > MAX_IMPORT_FILE_BYTES {
            return Err("tooLarge");
        }
        let mbytes = std::fs::read(&mpath).map_err(|_| "notExport")?;
        let m: Value = serde_json::from_slice(&mbytes).map_err(|_| "notExport")?;
        if m.get("format").and_then(Value::as_str) != Some(EXPORT_FORMAT) {
            return Err("notExport");
        }
        if m.get("version").and_then(Value::as_u64) != Some(u64::from(EXPORT_VERSION)) {
            return Err("badVersion");
        }
        let manifest: ExportManifest = serde_json::from_value(m).map_err(|_| "unreadable")?;
        let rpath = dir.join("resources.json");
        if size(&rpath).map_err(|_| "unreadable")? > MAX_IMPORT_FILE_BYTES {
            return Err("tooLarge");
        }
        let rbytes = std::fs::read(&rpath).map_err(|_| "unreadable")?;
        let resources: Vec<ExportResource> = serde_json::from_slice(&rbytes).map_err(|_| "unreadable")?;
        if resources.len() > MAX_IMPORT_ITEMS {
            return Err("tooLarge");
        }
        let mut seen = BTreeSet::new();
        if !resources.iter().all(|r| seen.insert(r.id.as_str())) {
            return Err("duplicateId");
        }
        let mut all = mbytes;
        all.extend_from_slice(&rbytes);
        Ok((manifest, resources, fingerprint(&all)))
    }

    /// Review #1: the tree a node goes to, by the creation rules only (never the file's word):
    /// groups live in `resources` or a plugin's stored tree, never the environment, configuration
    /// or plugin state trees.
    fn import_tree(&self, r: &ExportResource) -> Option<String> {
        match r.kind.as_str() {
            KIND_GROUP => {
                let t = r.tree.clone().unwrap_or_else(|| TREE_RESOURCES.into());
                let kernel_only = [store::TREE_ENV, store::TREE_CONFIG, TREE_PLUGIN_STATE].contains(&t.as_str());
                (!kernel_only && self.stored_tree(&t).is_ok()).then_some(t)
            }
            KIND_ENV => Some(store::TREE_ENV.into()),
            k => self.rules.read().unwrap().get(k).and_then(|x| x.tree.clone()),
        }
    }

    fn decide(&self, r: &ExportResource) -> KResult<Decision> {
        if r.kind == KIND_CONFIG {
            // D326: this workspace's policies are not rewritten by foreign data.
            return Ok(Decision::Skip("config"));
        }
        if r.kind == store::KIND_PLUGIN_STATE {
            return Ok(Decision::Skip("invalid"));
        }
        if serde_json::to_vec(&r.body).map(|b| b.len()).unwrap_or(usize::MAX) > crate::runs::MAX_INPUT_BYTES {
            return Ok(Decision::Skip("invalid"));
        }
        if r.kind == KIND_GROUP || r.kind == KIND_ENV {
            if r.name.trim().is_empty() || self.import_tree(r).is_none() {
                return Ok(Decision::Skip("invalid"));
            }
            return Ok(Decision::Create { version: None, migrate: false });
        }
        let Some((pid, short)) = Registry::split(&r.kind) else { return Ok(Decision::Skip("unknownKind")) };
        let versions = self.registry.versions(pid);
        if versions.iter().all(|p| p.kind(short).is_none()) {
            return Ok(Decision::Skip("unknownKind"));
        }
        let (version, migrate, decl) = match r.plugin_version.as_deref() {
            Some(v) => match self.registry.version(pid, v).and_then(|p| p.kind(short).map(|k| (p, k))) {
                Some((p, k)) => (Some(p.version.clone()), false, k),
                None => match self.registry.plugin(pid).and_then(|p| p.kind(short).map(|k| (p, k))) {
                    Some((p, k)) if p.upgrades_from(v) => (Some(p.version.clone()), true, k),
                    _ => return Ok(Decision::Skip("needsVersion")),
                },
            },
            None => match self.registry.plugin(pid).and_then(|p| p.kind(short).map(|k| (p, k))) {
                Some((p, k)) => (Some(p.version.clone()), false, k),
                None => return Ok(Decision::Skip("needsVersion")),
            },
        };
        if !valid_body(Some(decl), r) || self.import_tree(r).is_none() {
            return Ok(Decision::Skip("invalid"));
        }
        if let Some(key) = &r.external_key {
            let existing: Option<String> = self.read(|c| {
                c.query_row(
                    "SELECT id FROM resources WHERE kind = ?1 AND external_key = ?2 AND deleted_at IS NULL",
                    params![r.kind, key],
                    |x| x.get(0),
                )
                .optional()
            })?;
            if let Some(id) = existing {
                return Ok(Decision::Update { id, version, migrate });
            }
        }
        Ok(Decision::Create { version, migrate })
    }

    /// Everything preview and import share: the decisions (parents checked like a creation,
    /// review #1) and what the import would grant (D329).
    fn analyze(&self, folder: &str) -> KResult<Result<Analysis, &'static str>> {
        let (manifest, resources, fingerprint) = match self.read_export(folder) {
            Ok(x) => x,
            Err(reason) => return Ok(Err(reason)),
        };
        let mut decisions = resources.iter().map(|r| self.decide(r)).collect::<KResult<Vec<_>>>()?;
        let trees: Vec<Option<String>> = resources.iter().map(|r| self.import_tree(r)).collect();
        let idx: HashMap<&str, usize> = resources.iter().enumerate().map(|(i, r)| (r.id.as_str(), i)).collect();
        let rules = self.rules.read().unwrap().clone();
        let accepts = |parent: &str, kind: &str| rules.get(parent).is_some_and(|r| r.accepts.iter().any(|a| a == "*" || a == kind));
        loop {
            let mut changed = false;
            for i in 0..resources.len() {
                if !matches!(decisions[i], Decision::Create { .. }) {
                    continue;
                }
                // A parent outside the file or not imported: the node goes to the import group / top.
                let Some(&j) = resources[i].parent.as_deref().and_then(|p| idx.get(p)) else { continue };
                if matches!(decisions[j], Decision::Skip(_)) {
                    continue;
                }
                if j == i || trees[j] != trees[i] || !accepts(&resources[j].kind, &resources[i].kind) {
                    decisions[i] = Decision::Skip("invalid");
                    changed = true;
                }
            }
            if !changed {
                break;
            }
        }
        let (mut grant_hosts, mut secret_names) = (BTreeSet::new(), BTreeSet::new());
        for (r, d) in resources.iter().zip(&decisions) {
            let version = match d {
                Decision::Create { version, .. } | Decision::Update { version, .. } => version.clone(),
                Decision::Skip(_) => continue,
            };
            grant_hosts.extend(self.grant_hosts_of(&r.kind, version.as_deref(), &r.body));
            if let Some((_, decl)) = self.registry.kind_at(&r.kind, version.as_deref()) {
                for (k, f) in &decl.fields {
                    let v = r.body.get(k);
                    if f.ty == DeclType::Secret {
                        secret_names.extend(v.and_then(|v| v.get("secret")).and_then(Value::as_str).filter(|s| !s.is_empty()).map(String::from));
                    }
                    if f.secrets {
                        secret_names.extend(v.and_then(Value::as_str).map(crate::secrets::references).unwrap_or_default());
                    }
                }
            }
            if r.kind == KIND_ENV {
                for p in r.body.get(crate::params::PARAMS_KEY).and_then(Value::as_object).into_iter().flat_map(|m| m.values()) {
                    if p.get("type").and_then(Value::as_str) == Some("secret") {
                        secret_names.extend(p.get("value").and_then(Value::as_str).filter(|s| !s.is_empty()).map(String::from));
                    }
                }
            }
        }
        Ok(Ok(Analysis {
            manifest,
            resources,
            fingerprint,
            decisions,
            trees,
            grant_hosts: grant_hosts.into_iter().collect(),
            secret_names: secret_names.into_iter().collect(),
        }))
    }

    fn skips(a: &Analysis) -> Vec<ImportSkip> {
        a.resources
            .iter()
            .zip(&a.decisions)
            .filter_map(|(r, d)| match d {
                Decision::Skip(reason) => Some(ImportSkip { name: r.name.clone(), kind: r.kind.clone(), reason: (*reason).into() }),
                _ => None,
            })
            .collect()
    }

    pub fn import_preview(&self, folder: &str) -> KResult<ImportPreview> {
        let a = match self.analyze(folder)? {
            Ok(a) => a,
            Err(reason) => {
                return Ok(ImportPreview {
                    valid: false,
                    problem: Some(invalid(reason)),
                    source: String::new(),
                    exported_at: 0,
                    create: 0,
                    update: 0,
                    skipped: vec![],
                    fingerprint: String::new(),
                    grant_hosts: vec![],
                    secret_names: vec![],
                })
            }
        };
        let create = a.decisions.iter().filter(|d| matches!(d, Decision::Create { .. })).count() as u32;
        let update = a.decisions.iter().filter(|d| matches!(d, Decision::Update { .. })).count() as u32;
        Ok(ImportPreview {
            valid: true,
            problem: None,
            skipped: Self::skips(&a),
            source: a.manifest.workspace.name,
            exported_at: a.manifest.exported_at,
            create,
            update,
            fingerprint: a.fingerprint,
            grant_hosts: a.grant_hosts,
            secret_names: a.secret_names,
        })
    }

    pub async fn import(&self, p: ImportParams) -> KResult<ImportResult> {
        let a = self.analyze(&p.folder)?.map_err(invalid)?;
        if a.fingerprint != p.fingerprint {
            return Err(invalid("fingerprintChanged"));
        }
        if let Err(e) = self.read(|c| Ok(crate::policy::check(c, crate::policy::READONLY, None)))? {
            self.refused("workspace.import", &a.manifest.workspace.name, e.clone()).await;
            return Err(e);
        }
        let skipped = Self::skips(&a);
        let (resources, decisions) = (&a.resources, &a.decisions);
        // Old id → id here (new, or the existing resource with the same external key).
        let mut map: HashMap<String, String> = HashMap::new();
        for (r, d) in resources.iter().zip(decisions) {
            match d {
                Decision::Create { .. } => {
                    map.insert(r.id.clone(), new_id());
                }
                Decision::Update { id, .. } => {
                    map.insert(r.id.clone(), id.clone());
                }
                Decision::Skip(_) => {}
            }
        }
        let rules = self.rules.read().unwrap().clone();
        let idx: HashMap<&str, usize> = resources.iter().enumerate().map(|(i, r)| (r.id.as_str(), i)).collect();
        // Bodies a newer active version takes over first (§7.6), outside the transaction.
        let mut bodies: HashMap<String, JsonMap> = HashMap::new();
        let mut to_migrate: BTreeMap<String, Vec<Row>> = BTreeMap::new();
        for ((r, d), tree) in resources.iter().zip(decisions).zip(&a.trees) {
            if let Decision::Create { migrate: true, .. } | Decision::Update { migrate: true, .. } = d {
                let pid = Registry::split(&r.kind).map(|(p, _)| p.to_string()).unwrap_or_default();
                to_migrate.entry(pid).or_default().push(Row {
                    id: r.id.clone(),
                    kind: r.kind.clone(),
                    plugin_version: r.plugin_version.clone(),
                    tree: tree.clone(),
                    parent_id: None,
                    pos: 0,
                    name: r.name.clone(),
                    description: r.description.clone(),
                    tags: r.tags.clone(),
                    body: r.body.clone(),
                    origin: "original".into(),
                    origin_ref: None,
                    state: "ok".into(),
                    rev: r.rev,
                    created_at: r.created_at,
                    created_by: r.created_by.clone(),
                    updated_at: r.updated_at,
                    updated_by: r.updated_by.clone(),
                    deleted_at: None,
                });
            }
        }
        for (pid, rows) in to_migrate {
            let to = self.registry.plugin(&pid).ok_or_else(|| invalid("needsVersion"))?;
            for it in self.migrate_rows(to, &rows).await? {
                bodies.insert(it.id, it.body);
            }
        }
        let mut items = Vec::new();
        for ((r, d), tree) in resources.iter().zip(decisions).zip(&a.trees) {
            let (update, version) = match d {
                Decision::Create { version, .. } => (false, version.clone()),
                Decision::Update { version, .. } => (true, version.clone()),
                Decision::Skip(_) => continue,
            };
            let file_refs = r.refs.clone().unwrap_or_default();
            let mut body = bodies.remove(&r.id).unwrap_or_else(|| r.body.clone());
            let mut lost = Vec::new();
            if let Some(rule) = rules.get(&r.kind) {
                for key in &rule.ref_fields {
                    let Some(old) = body.get(key).and_then(crate::refs::ref_id).map(String::from) else { continue };
                    match map.get(&old) {
                        Some(new) => {
                            body.insert(key.clone(), json!({ "ref": new }));
                        }
                        None => {
                            // Review #4: never an id of this workspace by accident.
                            let field = format!("body.{key}");
                            let text = file_refs.iter().find(|h| h.field == field).map(|h| h.text.clone()).unwrap_or(old);
                            body.insert(key.clone(), json!({ "ref": null }));
                            lost.push((field, text));
                        }
                    }
                }
            }
            let parent = match r.parent.as_deref().and_then(|p| idx.get(p)) {
                Some(&j) if map.contains_key(&resources[j].id) => ParentChoice::Id(map[&resources[j].id].clone()),
                _ if tree.as_deref() == Some(TREE_RESOURCES) => ParentChoice::Group,
                _ => ParentChoice::Top,
            };
            let hints = file_refs
                .iter()
                .map(|x| RefRow { field: x.field.clone(), seq: x.seq, text: x.text.clone(), target: x.target.as_ref().and_then(|t| map.get(t).cloned()), ever: false })
                .collect();
            let deleted_key: bool = match &r.external_key {
                Some(k) if !update => self.read(|c| {
                    c.query_row("SELECT EXISTS(SELECT 1 FROM resources WHERE kind = ?1 AND external_key = ?2)", params![r.kind, k], |x| x.get(0))
                })?,
                _ => false,
            };
            items.push(ImportItem {
                id: map[&r.id].clone(),
                update,
                kind: r.kind.clone(),
                unique_name: r.kind == KIND_ENV && matches!(parent, ParentChoice::Top),
                tree: tree.clone(),
                parent,
                name: r.name.clone(),
                description: r.description.clone(),
                tags: r.tags.clone(),
                body,
                plugin_version: version,
                // A deleted resource here holds the key: the imported one comes without it.
                external_key: if deleted_key { None } else { r.external_key.clone() },
                hints,
                lost,
            });
        }
        // Parents before children.
        let pending: BTreeSet<String> = items.iter().filter(|i| !i.update).map(|i| i.id.clone()).collect();
        let mut placed: BTreeSet<String> = BTreeSet::new();
        let mut ordered = Vec::with_capacity(items.len());
        let mut rest = items;
        while !rest.is_empty() {
            let before = rest.len();
            let (ready, wait): (Vec<ImportItem>, Vec<ImportItem>) = rest.into_iter().partition(|i| match &i.parent {
                ParentChoice::Id(p) => !pending.contains(p) || placed.contains(p),
                _ => true,
            });
            for i in &ready {
                placed.insert(i.id.clone());
            }
            ordered.extend(ready);
            rest = wait;
            if rest.len() == before {
                // A cycle in the file's parents: those go to the top of the import.
                for mut i in std::mem::take(&mut rest) {
                    i.parent = if i.tree.as_deref() == Some(TREE_RESOURCES) { ParentChoice::Group } else { ParentChoice::Top };
                    ordered.push(i);
                }
            }
        }
        let group = match &p.parent {
            Some(g) => GroupChoice::Existing(g.clone()),
            None => GroupChoice::New(a.manifest.workspace.name.clone()),
        };
        let updated = ordered.iter().filter(|i| i.update).count() as u32;
        let created = ordered.len() as u32 - updated;
        let plan = ImportPlan { source: a.manifest.workspace.name.clone(), group, items: ordered, skipped: skipped.len() as u32 };
        // The network grants of imported rows are audited like a save (§3.5): see `Inner::execute`.
        let out = self.execute(Actor::User, Command::Import(Box::new(plan))).await?;
        let group = out.rows.first().cloned().ok_or_else(|| internal("no group"))?;
        Ok(ImportResult { created, updated, skipped, group: self.named(&group) })
    }

    /* ---------------------------------------------------------------- run.export (D328) */

    pub async fn run_export(&self, p: RunExportParams) -> KResult<RunExportResult> {
        if p.format != "csv" {
            return Err(invalid("badFormat"));
        }
        let run = self.read(|c| store::run_get(c, &p.run))?.ok_or_else(|| not_found("run"))?;
        if let Err(e) = self.read(|c| Ok(crate::policy::check(c, crate::policy::NO_EXPORT, run.env_id.as_deref())))? {
            self.refused("run.export", &p.run, e.clone()).await;
            return Err(e);
        }
        if run.status == "running" {
            return Err(invalid("notFinished"));
        }
        // Review #10: a result that was cleared is not "not a table".
        let Some(raw) = run.output.clone().filter(|o| !o.is_null()) else { return Err(invalid("noOutput")) };
        let Ok(RunOutput::Table { columns, rows, .. }) = serde_json::from_value::<RunOutput>(raw) else { return Err(invalid("notTable")) };
        let path = self.outside_path(&p.path)?;
        let mut text = String::from("\u{feff}");
        let line = |cells: Vec<String>| cells.iter().map(|c| csv_field(c)).collect::<Vec<_>>().join(",") + "\r\n";
        text.push_str(&line(columns.iter().map(|c| c.label.clone()).collect()));
        for r in &rows {
            // Review #10: as many fields as the header, cut or padded.
            text.push_str(&line((0..columns.len()).map(|i| cell_text(r.get(i))).collect()));
        }
        let mut f = std::fs::OpenOptions::new().write(true).create_new(true).open(&path).map_err(|e| {
            if e.kind() == std::io::ErrorKind::AlreadyExists {
                invalid("exists")
            } else {
                write_failed(e)
            }
        })?;
        if let Err(e) = f.write_all(text.as_bytes()).and_then(|_| f.sync_all()) {
            drop(f);
            let _ = std::fs::remove_file(&path);
            return Err(write_failed(e));
        }
        let shown = path.to_string_lossy().into_owned();
        let summary = json!({ "rows": rows.len(), "format": "csv" });
        self.execute(Actor::User, Command::Audit { op: "run.export".into(), object: p.run.clone(), summary }).await?;
        Ok(RunExportResult { path: shown, rows: rows.len() as u32 })
    }
}

/// RFC 4180: quoted when it holds a comma, quote or line break; quotes doubled.
pub fn csv_field(s: &str) -> String {
    if s.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

fn cell_text(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(other) => other.to_string(),
    }
}

/// Rows in tree order: per tree, parents before children, siblings by position.
fn depth_first(rows: Vec<(Row, Option<String>)>) -> Vec<(Row, Option<String>)> {
    let ids: BTreeSet<String> = rows.iter().map(|(r, _)| r.id.clone()).collect();
    let mut children: BTreeMap<Option<String>, Vec<(Row, Option<String>)>> = BTreeMap::new();
    for (r, k) in rows {
        let p = r.parent_id.clone().filter(|p| ids.contains(p));
        children.entry(p).or_default().push((r, k));
    }
    for v in children.values_mut() {
        v.sort_by(|(a, _), (b, _)| (&a.tree, a.pos, &a.id).cmp(&(&b.tree, b.pos, &b.id)));
    }
    let mut out = Vec::new();
    let mut stack: Vec<(Row, Option<String>)> = children.remove(&None).unwrap_or_default().into_iter().rev().collect();
    while let Some((r, k)) = stack.pop() {
        if let Some(kids) = children.remove(&Some(r.id.clone())) {
            stack.extend(kids.into_iter().rev());
        }
        out.push((r, k));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn csv_fields_are_quoted_only_when_needed() {
        assert_eq!(csv_field("plain"), "plain");
        assert_eq!(csv_field("a,b"), "\"a,b\"");
        assert_eq!(csv_field("say \"hi\""), "\"say \"\"hi\"\"\"");
        assert_eq!(csv_field("two\nlines"), "\"two\nlines\"");
        assert_eq!(csv_field("cr\r"), "\"cr\r\"");
        assert_eq!(cell_text(Some(&json!(1.5))), "1.5");
        assert_eq!(cell_text(Some(&json!(null))), "");
        assert_eq!(cell_text(Some(&json!(true))), "true");
    }

    #[test]
    fn pretty_sorts_keys_at_every_level() {
        let out = String::from_utf8(pretty(json!({ "b": 1, "a": { "d": 2, "c": [ { "z": 0, "y": 1 } ] } }))).unwrap();
        let a = out.find("\"a\"").unwrap();
        let b = out.find("\"b\"").unwrap();
        let c = out.find("\"c\"").unwrap();
        let d = out.find("\"d\"").unwrap();
        let y = out.find("\"y\"").unwrap();
        let z = out.find("\"z\"").unwrap();
        assert!(a < b && c < d && y < z);
        assert!(out.contains("\n  \"a\""), "two-space indentation");
    }
}
