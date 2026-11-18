//! Round-2 methods (docs/handoff/round2-plan.md §3): parameters and environments, workspace
//! configuration, history and restore, deleted, favorites, search, audit.

use std::collections::{BTreeMap, BTreeSet};

use onedesk_protocol::method2 as M;
use onedesk_protocol::*;
use rusqlite::params;
use serde_json::{json, Value};

use crate::kernel::{parse, Inner};
use crate::params::{self as P, Param};
use crate::pipeline::{Actor, Changes, Command, ParamChange};
use crate::store::{self, Row, KIND_CONFIG, KIND_ENV, TREE_PLUGIN_STATE};
use crate::util::*;

fn to_value<T: serde::Serialize>(v: T) -> KResult<Value> {
    serde_json::to_value(v).map_err(internal)
}

/// Text form of a snapshot value for history (objects as compact JSON).
fn text(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(other) => other.to_string(),
    }
}

/// Field path → value of a snapshot, for every field history knows.
fn fields_of(snap: &Value) -> BTreeMap<String, String> {
    let mut m = BTreeMap::new();
    let Some(o) = snap.as_object() else { return m };
    for k in ["name", "description"] {
        m.insert(k.to_string(), text(o.get(k)));
    }
    let tags = o.get("tags").and_then(Value::as_array).map(|a| a.is_empty()).unwrap_or(true);
    m.insert("tags".into(), if tags { String::new() } else { text(o.get("tags")) });
    m.insert("parent".into(), text(o.get("parentId")));
    m.insert("pos".into(), text(o.get("pos")));
    m.insert("deleted".into(), if o.get("deletedAt").is_some_and(|v| !v.is_null()) { "true".into() } else { String::new() });
    if let Some(body) = o.get("body").and_then(Value::as_object) {
        for (k, v) in body {
            if k == P::PARAMS_KEY {
                if let Some(ps) = v.as_object() {
                    for (n, p) in ps {
                        m.insert(format!("params.{n}"), text(p.get("value")));
                    }
                }
            } else {
                m.insert(format!("body.{k}"), text(Some(v)));
            }
        }
    }
    m
}

impl Inner {
    /// Round-2 methods; `None` = not one of them.
    pub async fn handle2(&self, client: Option<String>, m: &str, params: Value) -> Option<KResult<Value>> {
        let _ = client;
        Some(match m {
            M::WORKSPACE_GET_CONFIG => self.get_config(parse(params)).and_then(to_value),
            M::WORKSPACE_SET_CONFIG => match parse::<ConfigSetParams>(params) {
                Ok(p) => self.set_config(p).await.map(|_| Value::Null),
                Err(e) => Err(e),
            },
            M::PARAMS_ENV => parse::<EnvIdParams>(params).and_then(|p| self.env_view(&p.env_id)).and_then(to_value),
            M::PARAMS_ENV_OPTIONS => self.env_options().and_then(to_value),
            M::PARAMS_RESOLVE => parse::<ParamsResolveParams>(params).and_then(|p| self.resolve_param(p)).and_then(to_value),
            M::PARAMS_SET => match parse::<ParamSetParams>(params) {
                Ok(p) => {
                    let ch = ParamChange::Set { value: p.value, ty: p.param_type };
                    self.param_command(&p.node, &p.name, ch, p.basis, "params.set").await.map(|_| Value::Null)
                }
                Err(e) => Err(e),
            },
            M::PARAMS_UNSET | M::PARAMS_ACKNOWLEDGE => match parse::<ParamNameParams>(params) {
                Ok(p) => {
                    let ch = if m == M::PARAMS_UNSET { ParamChange::Unset } else { ParamChange::Acknowledge };
                    self.param_command(&p.node, &p.name, ch, p.basis, m).await.map(|_| Value::Null)
                }
                Err(e) => Err(e),
            },
            M::RESOURCE_HISTORY => parse::<ResourceIdParams>(params).and_then(|p| self.history(&p.id)).and_then(to_value),
            M::RESOURCE_RESTORE => match parse::<ResourceRestoreParams>(params) {
                Ok(p) => self.restore_entry(&p.id, &p.entry_id).await.map(|_| Value::Null),
                Err(e) => Err(e),
            },
            M::RESOURCE_LIST_DELETED => self.list_deleted().and_then(to_value),
            M::RESOURCE_UNDELETE => match parse::<ResourceIdParams>(params) {
                Ok(p) => self.undelete(&p.id).await.map(|_| Value::Null),
                Err(e) => Err(e),
            },
            M::RESOURCE_PURGE => match parse::<ResourceIdParams>(params) {
                Ok(p) => self.purge(&p.id).await.map(|_| Value::Null),
                Err(e) => Err(e),
            },
            M::RESOURCE_SET_FAVORITE => match parse::<SetFavoriteParams>(params) {
                Ok(p) => self.set_favorite(&p.id, p.favorite).await.map(|_| Value::Null),
                Err(e) => Err(e),
            },
            M::SEARCH_QUERY => parse::<SearchQueryParams>(params).and_then(|p| self.search(p)).and_then(to_value),
            M::AUDIT_LIST => parse::<AuditFilter>(params).and_then(|f| self.audit_list(f)).and_then(to_value),
            M::AUDIT_FACETS => self.audit_facets().and_then(to_value),
            _ => return None,
        })
    }

    /* ---------------------------------------------------------------- parameters */

    fn param_node(&self, id: &str) -> KResult<Row> {
        let r = self.live_row(id)?;
        if !P::is_param_kind(&r.kind) {
            return Err(invalid("notParamNode"));
        }
        Ok(r)
    }

    pub async fn param_command(&self, node: &str, name: &str, ch: ParamChange, basis: Option<i64>, op: &str) -> KResult<()> {
        let row = self.param_node(node)?;
        let mut changes = Changes::default();
        changes.params.insert(name.to_string(), ch);
        // #3: with a basis, the same parameter changed after it is a conflict.
        self.execute(Actor::User, Command::Params { id: row.id, changes, basis, op: op.into() }).await?;
        Ok(())
    }

    fn display_of(&self, p: &Param) -> Option<String> {
        if p.ty != ParamType::Ref {
            return None;
        }
        self.read(|c| store::get(c, &p.value)).ok().flatten().map(|r| r.name)
    }

    pub fn env_view(&self, env_id: &str) -> KResult<Option<EnvView>> {
        let Some(row) = self.read(|c| store::get(c, env_id))? else { return Ok(None) };
        if row.kind != KIND_ENV {
            return Ok(None);
        }
        let ancestors = self.read(|c| store::ancestors(c, &row))?;
        let own = P::params_of(&row);
        let names: BTreeSet<String> =
            ancestors.iter().flat_map(|a| P::params_of(a).into_keys()).chain(own.keys().cloned()).collect();
        let mut params = Vec::new();
        for name in names {
            let inherited = P::inherited(&ancestors, &name);
            let mine = own.get(&name);
            let (eff, src) = match (mine, &inherited) {
                (Some(p), _) => (p.clone(), &row),
                (None, Some((p, s))) => (p.clone(), *s),
                (None, None) => continue,
            };
            let layers = inherited.as_ref().map(|(_, s)| {
                ancestors
                    .iter()
                    .map(|a| EnvLayer {
                        env_id: a.id.clone(),
                        name: a.name.clone(),
                        value: P::get(a, &name).map(|p| p.value),
                        effective: a.id == s.id,
                    })
                    .collect()
            });
            // §4.2: an override records what it overrode; the parent chain is re-read now.
            let changed_upstream = mine.and_then(|m| m.based_on.as_ref()).and_then(|b| {
                let now = inherited.as_ref().map(|(p, _)| p.value.clone()).unwrap_or_default();
                (now != b.value).then(|| UpstreamChange { was: b.value.clone(), now })
            });
            params.push(EnvParam {
                display: self.display_of(&eff),
                param_type: eff.ty,
                value: eff.value.clone(),
                source_id: src.id.clone(),
                source_name: src.name.clone(),
                own: mine.is_some(),
                inherited: inherited.as_ref().map(|(p, s)| InheritedValue { value: p.value.clone(), source_name: s.name.clone() }),
                layers,
                restricted: (mine.is_some()
                    && ((name == crate::network::ALLOW_PARAM && self.allow_restricted(&row, &ancestors))
                        || (name == crate::process::ALLOW_PARAM && self.process_allow_restricted(&row, &ancestors))))
                    .then(|| Label::Text("restrictedByUpperLayer".into())),
                changed_upstream,
                declared_by: vec![],
                description: None,
                name,
            });
        }
        let mut chain: Vec<NamedRef> = ancestors.iter().map(|a| NamedRef { id: a.id.clone(), name: a.name.clone() }).collect();
        chain.push(NamedRef { id: row.id.clone(), name: row.name.clone() });
        let children = self
            .read(|c| store::children(c, store::TREE_ENV, Some(&row.id), 0, u32::MAX))?
            .into_iter()
            .map(|c| NamedRef { id: c.id, name: c.name })
            .collect();
        Ok(Some(EnvView { id: row.id.clone(), name: row.name.clone(), description: row.description.clone(), chain, params, children, rev: row.rev }))
    }

    pub fn env_options(&self) -> KResult<Vec<EnvOption>> {
        // No cycle guard needed (round 14 review #9): the walk starts at the roots, and a cycle of parents
        // contains no root, so it is never reached from here.
        fn walk(k: &Inner, parent: Option<&str>, depth: u32, out: &mut Vec<EnvOption>) -> KResult<()> {
            for r in k.read(|c| store::children(c, store::TREE_ENV, parent, 0, u32::MAX))? {
                out.push(EnvOption { id: r.id.clone(), name: r.name.clone(), depth });
                walk(k, Some(&r.id), depth + 1, out)?;
            }
            Ok(())
        }
        let mut out = Vec::new();
        walk(self, None, 0, &mut out)?;
        Ok(out)
    }

    pub(crate) fn resolve_param(&self, p: ParamsResolveParams) -> KResult<ResolvedParam> {
        let missing = ResolvedParam { name: p.name.clone(), found: false, value: String::new(), display: String::new(), source_name: String::new() };
        let Some(env) = p.env_id else { return Ok(missing) };
        let Some(row) = self.read(|c| store::get(c, &env))?.filter(|r| r.kind == KIND_ENV) else { return Ok(missing) };
        let mut chain = self.read(|c| store::ancestors(c, &row))?;
        chain.push(row);
        Ok(match P::inherited(&chain, &p.name) {
            Some((v, src)) => ResolvedParam {
                display: self.display_of(&v).unwrap_or_else(|| v.value.clone()),
                name: p.name,
                found: true,
                value: v.value,
                source_name: src.name.clone(),
            },
            None => missing,
        })
    }

    /* ---------------------------------------------------------------- configuration */

    /// The deepest configuration node defining `name` (child overrides parent, §6.2).
    fn config_holder(&self, name: &str) -> KResult<Option<(Row, Param)>> {
        let mut best: Option<(usize, Row, Param)> = None;
        for r in self.read(|c| store::of_kind(c, KIND_CONFIG))? {
            if let Some(p) = P::get(&r, name) {
                let depth = self.read(|c| store::ancestors(c, &r))?.len();
                if best.as_ref().is_none_or(|(d, _, _)| depth > *d) {
                    best = Some((depth, r, p));
                }
            }
        }
        Ok(best.map(|(_, r, p)| (r, p)))
    }

    fn get_config(&self, p: KResult<ConfigGetParams>) -> KResult<Option<String>> {
        Ok(self.config_holder(&p?.name)?.map(|(_, p)| p.value))
    }

    async fn set_config(&self, p: ConfigSetParams) -> KResult<()> {
        let node = match self.config_holder(&p.name)? {
            Some((r, _)) => r.id,
            None => match self.read(|c| store::children(c, store::TREE_CONFIG, None, 0, 1))?.into_iter().next() {
                Some(r) => r.id,
                // #8: every root was deleted; make a new one rather than failing.
                None => self
                    .execute(
                        Actor::Core,
                        Command::Create(crate::pipeline::NewResource {
                            kind: KIND_CONFIG.into(),
                            tree: None,
                            parent: None,
                            name: "Workspace".into(),
                            description: String::new(),
                            tags: vec![],
                            body: JsonMap::new(),
                            plugin_version: None,
                        }),
                    )
                    .await?
                    .id
                    .ok_or_else(|| internal("no id"))?,
            },
        };
        self.param_command(&node, &p.name, ParamChange::Set { value: p.value, ty: None }, None, "params.set").await
    }

    /* ---------------------------------------------------------------- history */

    pub fn history(&self, id: &str) -> KResult<Vec<HistoryEntry>> {
        let row = self.read(|c| store::get_any(c, id))?.ok_or_else(|| not_found("resource"))?;
        if row.tree.as_deref() == Some(TREE_PLUGIN_STATE) {
            return Err(not_found("resource"));
        }
        let revs: Vec<(i64, i64, String, String, String, Option<String>)> = self.read(|c| {
            let mut st = c.prepare_cached(
                "SELECT rev, at, actor, op, snapshot, restored_from FROM revisions WHERE resource_id = ?1 ORDER BY rev",
            )?;
            let rows = st.query_map([id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)))?;
            rows.collect()
        })?;
        let mut out = Vec::new();
        let mut prev: BTreeMap<String, String> = BTreeMap::new();
        for (rev, at, actor, op, snap, restored_from) in revs {
            let cur = fields_of(&serde_json::from_str(&snap).unwrap_or(Value::Null));
            let keys: BTreeSet<&String> = prev.keys().chain(cur.keys()).collect();
            let mut changed: Vec<(String, String, String)> = keys
                .into_iter()
                .filter_map(|k| {
                    let (b, a) = (prev.get(k).cloned().unwrap_or_default(), cur.get(k).cloned().unwrap_or_default());
                    (b != a).then(|| (k.clone(), b, a))
                })
                .collect();
            // `pos` only when nothing else changed (§6 of the plan); never for a creation.
            if changed.iter().any(|(k, _, _)| k != "pos") || op == "create" {
                changed.retain(|(k, _, _)| k != "pos");
            }
            for (field, before, after) in changed {
                out.push(HistoryEntry {
                    id: format!("{rev}:{field}"),
                    at,
                    actor: actor.clone(),
                    op: op.clone(),
                    field,
                    before,
                    after,
                    restored_from: restored_from.clone(),
                });
            }
            prev = cur;
        }
        out.reverse();
        Ok(out)
    }

    async fn restore_entry(&self, id: &str, entry: &str) -> KResult<()> {
        let (rev, field) = entry.split_once(':').ok_or_else(|| invalid_params("entryId"))?;
        let rev: i64 = rev.parse().map_err(|_| invalid_params("entryId"))?;
        let row = self.live_row(id)?;
        if row.tree.as_deref() == Some(TREE_PLUGIN_STATE) {
            return Err(not_found("resource"));
        }
        // The snapshot before that revision; a field restored from before creation is emptied.
        let before: Value = self
            .read(|c| {
                c.query_row(
                    "SELECT snapshot FROM revisions WHERE resource_id = ?1 AND rev < ?2 ORDER BY rev DESC LIMIT 1",
                    params![id, rev],
                    |r| r.get::<_, String>(0),
                )
                .map(Some)
                .or_else(|e| if e == rusqlite::Error::QueryReturnedNoRows { Ok(None) } else { Err(e) })
            })?
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or(Value::Null);
        let exists: bool = self.read(|c| {
            c.query_row("SELECT EXISTS(SELECT 1 FROM revisions WHERE resource_id = ?1 AND rev = ?2)", params![id, rev], |r| r.get(0))
        })?;
        if !exists {
            return Err(not_found("entry"));
        }
        let snap: Option<Row> = serde_json::from_value(before).ok();
        let mut changes = Changes::default();
        let mut parent = None;
        match field {
            "name" => changes.name = Some(snap.as_ref().map(|s| s.name.clone()).ok_or_else(|| invalid("nothingBefore"))?),
            "description" => changes.description = Some(snap.as_ref().map(|s| s.description.clone()).unwrap_or_default()),
            "tags" => changes.tags = Some(snap.as_ref().map(|s| s.tags.clone()).unwrap_or_default()),
            "parent" => parent = Some(snap.as_ref().and_then(|s| s.parent_id.clone())),
            f => {
                if let Some(k) = f.strip_prefix("body.") {
                    changes.body.insert(k.into(), snap.as_ref().and_then(|s| s.body.get(k).cloned()).unwrap_or(Value::Null));
                } else if let Some(n) = f.strip_prefix("params.") {
                    changes.params.insert(n.into(), ParamChange::Exact(snap.as_ref().and_then(|s| P::get(s, n))));
                } else {
                    return Err(invalid("notRestorable"));
                }
            }
        }
        // §7.6 “其他情形” (review #10): restored content from a snapshot bound to another version.
        let mut version = None;
        let snap_version = snap.as_ref().and_then(|s| s.plugin_version.clone());
        if field.starts_with("body.") && snap_version.is_some() && snap_version != row.plugin_version {
            let sv = snap_version.clone().unwrap_or_default();
            let pid = crate::manifest::Registry::split(&row.kind).map(|(p, _)| p.to_string()).unwrap_or_default();
            if self.registry.version(&pid, &sv).is_some() {
                // That version is still installed: the restored content goes back to it.
                version = Some(sv);
            } else {
                // Gone: the active version takes it over if it can, by `migrate`.
                let to = self.registry.plugin(&pid).filter(|p| p.upgrades_from(&sv)).ok_or_else(|| invalid("needsVersion"))?;
                let mut old = row.clone();
                for (k, v) in &changes.body {
                    if v.is_null() {
                        old.body.remove(k);
                    } else {
                        old.body.insert(k.clone(), v.clone());
                    }
                }
                old.plugin_version = Some(sv);
                let item = self.migrate_rows(to, std::slice::from_ref(&old)).await?.remove(0);
                changes.body = row.body.keys().map(|k| (k.clone(), Value::Null)).collect();
                changes.body.extend(item.body);
                version = Some(to.version.clone());
            }
        }
        self.execute(Actor::User, Command::Restore { id: id.into(), changes, parent, entry: entry.into(), version }).await?;
        Ok(())
    }

    /* ---------------------------------------------------------------- deleted, favorites */

    pub fn list_deleted(&self) -> KResult<Vec<Resource>> {
        self.read(store::deleted_tops)?.iter().map(|r| self.resource(r)).collect()
    }

    pub async fn undelete(&self, id: &str) -> KResult<()> {
        let row = self.deleted_row(id)?;
        // §7.6: rows bound to a version that is gone need a version that can take them over.
        let batch = store::delete_batch_rows(self, &row)?;
        for r in &batch {
            if let (Some(v), Some((pid, _))) = (r.plugin_version.as_deref(), crate::manifest::Registry::split(&r.kind)) {
                if self.registry.version(pid, v).is_none() && !self.registry.plugin(pid).is_some_and(|p| p.upgrades_from(v)) {
                    return Err(invalid("needsVersion"));
                }
            }
        }
        let out = self.execute(Actor::User, Command::Undelete { id: id.into() }).await?;
        self.rebind_missing(&out.rows).await?;
        Ok(())
    }

    pub async fn purge(&self, id: &str) -> KResult<()> {
        self.deleted_row(id)?;
        let out = self.execute(Actor::User, Command::Purge { id: id.into() }).await?;
        // D306: secrets the resources owned (`<id>.<field>`) go too.
        let ids: Vec<String> = out.rows.iter().map(|r| r.id.clone()).collect();
        self.delete_owned_secrets(&ids).await;
        Ok(())
    }

    fn deleted_row(&self, id: &str) -> KResult<Row> {
        let r = self.read(|c| store::get_any(c, id))?.ok_or_else(|| not_found("resource"))?;
        if r.tree.as_deref() == Some(TREE_PLUGIN_STATE) {
            return Err(not_found("resource"));
        }
        if r.deleted_at.is_none() {
            return Err(invalid("notDeleted"));
        }
        Ok(r)
    }

    pub async fn set_favorite(&self, id: &str, favorite: bool) -> KResult<()> {
        self.execute(Actor::User, Command::Meta { id: id.into(), favorite: Some(favorite), touch: false }).await?;
        self.emit(format!("{}{}", topic::TREE, store::TREE_FAVORITES), None, None);
        self.emit(format!("{}{id}", topic::RESOURCE), None, None);
        Ok(())
    }

    /// `page.resolve` of a resource counts as one use (search ranking).
    pub async fn touch(&self, id: &str) {
        let _ = self.pipeline.execute(Actor::User, Command::Meta { id: id.into(), favorite: None, touch: true }).await;
    }

    /* ---------------------------------------------------------------- search (D277) */

    fn search(&self, p: SearchQueryParams) -> KResult<Vec<SearchHit>> {
        let terms: Vec<String> = p.text.split_whitespace().map(|t| t.to_lowercase()).collect();
        if terms.is_empty() {
            return Ok(vec![]);
        }
        let limit = p.limit.unwrap_or(20).clamp(1, 200);
        let mut long = Vec::new();
        let mut wheres = vec!["r.deleted_at IS NULL".to_string(), "r.tree IS NOT ?1".to_string()];
        let mut args: Vec<String> = vec![TREE_PLUGIN_STATE.to_string()];
        for t in &terms {
            if t.chars().count() >= 3 {
                long.push(format!("\"{}\"", t.replace('"', "\"\"")));
            } else {
                // Short words (two-character Chinese words) by substring.
                let like = format!("%{}%", t.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"));
                args.push(like);
                let i = args.len();
                wheres.push(format!("(lower(s.name) LIKE ?{i} ESCAPE '\\' OR lower(s.text) LIKE ?{i} ESCAPE '\\')"));
            }
        }
        if !long.is_empty() {
            args.push(long.join(" AND "));
            wheres.push(format!("search MATCH ?{}", args.len()));
        }
        if let Some(k) = &p.kind {
            args.push(k.clone());
            wheres.push(format!("r.kind = ?{}", args.len()));
        }
        // Ranking: name hit → favorite → most recently used.
        let name_hit: Vec<String> = terms
            .iter()
            .map(|t| {
                args.push(t.clone());
                format!("instr(lower(s.name), ?{}) > 0", args.len())
            })
            .collect();
        args.push(limit.to_string());
        let sql = format!(
            "SELECT r.id FROM search s JOIN resources r ON r.rowid = s.rowid
             LEFT JOIN resource_meta m ON m.resource_id = r.id
             WHERE {}
             ORDER BY ({}) DESC, COALESCE(m.favorite, 0) DESC, COALESCE(m.last_used_at, 0) DESC, r.name COLLATE NOCASE
             LIMIT ?{}",
            wheres.join(" AND "),
            name_hit.join(" AND "),
            args.len()
        );
        let ids: Vec<String> = self.read(|c| {
            let mut st = c.prepare(&sql)?;
            let rows = st.query_map(rusqlite::params_from_iter(args.iter()), |r| r.get(0))?;
            rows.collect()
        })?;
        let mut out = Vec::new();
        for id in ids {
            let Some(r) = self.read(|c| store::get(c, &id))? else { continue };
            let meta = self.row_meta(&r);
            let path: Vec<String> = self.read(|c| store::ancestors(c, &r))?.into_iter().map(|a| a.name).collect();
            out.push(SearchHit {
                target: format!("resource:{}", r.id),
                title: r.name.clone(),
                icon: meta.icon,
                subtitle: path.join(" / "),
                state: meta.state,
            });
        }
        Ok(out)
    }

    /* ---------------------------------------------------------------- audit */

    fn audit_list(&self, f: AuditFilter) -> KResult<Vec<AuditRow>> {
        let mut wheres = vec!["1 = 1".to_string()];
        let mut args: Vec<Value> = vec![];
        let mut push = |w: &str, v: Value, wheres: &mut Vec<String>| {
            args.push(v);
            wheres.push(w.replace('?', &format!("?{}", args.len())));
        };
        if let Some(ms) = f.since_ms {
            push("at >= ?", json!(now_ms() - ms), &mut wheres);
        }
        if let Some(a) = &f.actor {
            push("actor = ?", json!(a), &mut wheres);
        }
        if let Some(o) = &f.operation {
            push("op = ?", json!(o), &mut wheres);
        }
        match f.result {
            Some(AuditResult::Ok) => wheres.push("result = 'ok'".into()),
            Some(AuditResult::Denied) => wheres.push("result = 'failed:denied'".into()),
            Some(AuditResult::Error) => wheres.push("result LIKE 'failed:%' AND result <> 'failed:denied'".into()),
            Some(AuditResult::Cancelled) => wheres.push("result = 'cancelled'".into()),
            Some(AuditResult::Timeout) => wheres.push("result = 'timeout'".into()),
            None => {}
        }
        if let Some(t) = f.text.as_ref().filter(|t| !t.is_empty()) {
            let like = format!("%{}%", t.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"));
            // Every `?` of the clause becomes the same numbered argument.
            push(
                // The object's *current* name comes from `resources` at query time: names are never
                // written into audit rows, so a permanently deleted resource is not found by name.
                "(op LIKE ? ESCAPE '\\' OR object LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\' OR actor LIKE ? ESCAPE '\\' \
                 OR object IN (SELECT id FROM resources WHERE name LIKE ? ESCAPE '\\'))",
                json!(like),
                &mut wheres,
            );
        }
        let limit = f.limit.unwrap_or(200).clamp(1, 1000);
        let sql = format!(
            "SELECT seq, at, actor, op, object, summary, result FROM audit WHERE {} ORDER BY seq DESC LIMIT {limit}",
            wheres.join(" AND ")
        );
        let rows: Vec<(i64, i64, String, String, String, String, String)> = self.read(|c| {
            let mut st = c.prepare(&sql)?;
            let params: Vec<rusqlite::types::Value> = args
                .iter()
                .map(|v| match v {
                    Value::Number(n) => rusqlite::types::Value::Integer(n.as_i64().unwrap_or(0)),
                    other => rusqlite::types::Value::Text(other.as_str().unwrap_or_default().to_string()),
                })
                .collect();
            let rows = st.query_map(rusqlite::params_from_iter(params), |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?))
            })?;
            rows.collect()
        })?;
        rows.into_iter()
            .map(|(seq, at, actor, op, object, summary, result)| {
                let target = self.read(|c| store::get_any(c, &object))?.map(|r| r.name).unwrap_or(object);
                // D309: repeated calls merged into this row.
                let merged: Option<(i64, i64, Option<String>, i64)> = self
                    .read(|c| {
                        c.query_row("SELECT count, last_at, last_summary, failures FROM audit_counts WHERE audit_seq = ?1", [seq], |r| {
                            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
                        })
                            .map(Some)
                            .or_else(|e| if e == rusqlite::Error::QueryReturnedNoRows { Ok(None) } else { Err(e) })
                    })?
                    .filter(|(n, ..)| *n > 1);
                // Review #9: a merged row's detail also carries the last call and the failures.
                let summary = match &merged {
                    Some((_, _, last, failures)) => match serde_json::from_str::<Value>(&summary) {
                        Ok(Value::Object(mut o)) => {
                            if let Some(l) = last.as_deref().and_then(|l| serde_json::from_str::<Value>(l).ok()) {
                                o.insert("last".into(), l);
                            }
                            o.insert("failures".into(), (*failures).into());
                            Value::Object(o).to_string()
                        }
                        _ => summary,
                    },
                    None => summary,
                };
                Ok(AuditRow {
                    count: merged.as_ref().map(|(n, ..)| *n as u64),
                    last_at: merged.as_ref().map(|(_, t, ..)| *t),
                    id: seq.to_string(),
                    at,
                    source: actor.split(':').next().unwrap_or_default().to_string(),
                    actor,
                    operation: op,
                    target,
                    result: match result.as_str() {
                        "ok" => AuditResult::Ok,
                        "failed:denied" => AuditResult::Denied,
                        "cancelled" => AuditResult::Cancelled,
                        "timeout" => AuditResult::Timeout,
                        _ => AuditResult::Error,
                    },
                    detail: summary,
                })
            })
            .collect()
    }

    fn audit_facets(&self) -> KResult<AuditFacets> {
        let col = |c: &rusqlite::Connection, sql: &str| -> rusqlite::Result<Vec<String>> {
            let mut st = c.prepare(sql)?;
            let rows = st.query_map([], |r| r.get(0))?;
            rows.collect()
        };
        Ok(AuditFacets {
            actors: self.read(|c| col(c, "SELECT DISTINCT actor FROM audit ORDER BY actor"))?,
            operations: self.read(|c| col(c, "SELECT DISTINCT op FROM audit ORDER BY op"))?,
        })
    }
}
