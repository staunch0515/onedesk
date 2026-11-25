//! D487 §13 (docs/redesign/book.md): what a plugin that arranges other resources needs, in general terms.
//! - K-a `host.resources.tree(id, { offset?, limit? })`: everything below a resource in tree order (parents before
//!   children), with depth and revision, never the body; `requires.resources`.
//! - K-b `host.resources.embed(id, { section?, args? })`: what another resource shows where it is embedded;
//!   `requires.contents`.
//! - K-c `place`: a kind decides where a node lands when it is moved into (or made in) a resource of the kind.
//! - K-h `host.resources.refs(id)`: what a resource refers to now (its `[[…]]` and `![[…]]`); `requires.resources`.
//! - K-j `host.util.collate(texts, locale)`: the order texts sort in for a language (pinyin for Chinese).
//! - K-g `host.files.writeBlob(blob, path)`: a stored file written to a granted folder; the blob must be used by a
//!   resource the plugin may read.
//!
//! The kernel knows no particular plugin here.

use std::io::Write;

use onedesk_protocol::*;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::kernel::Inner;
use crate::manifest::Plugin;
use crate::pipeline::MoveDest;
use crate::sandbox::CallInfo;
use crate::store::{self, Row};
use crate::util::*;

/// Most texts one `util.collate` call sorts.
pub const COLLATE_MAX: usize = 20_000;
/// Most entries, and the longest label, of a text node's `refLabels`.
pub const MAX_REF_LABELS: usize = 500;
pub const MAX_REF_LABEL: usize = 200;

/// Most nodes one `resources.tree` call returns (and the default).
pub const TREE_MAX: usize = 2000;
/// Deepest level `resources.tree` goes to (a damaged database must not loop).
pub const TREE_MAX_DEPTH: usize = 64;
/// How long a kind's `place` may take before the node lands where it was dropped.
pub const PLACE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(1);

/// What a kind's `place` answers.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PlaceAnswer {
    #[serde(default)]
    before: Option<String>,
    #[serde(default)]
    refuse: Option<Label>,
}

impl Inner {
    /// K-a: the nodes below `id`, depth first in tree order.
    pub(crate) fn host_tree(&self, plugin: &Plugin, info: &CallInfo, args: &Value) -> KResult<Value> {
        if !plugin.manifest.requires.resources {
            return Err(denied("notRequested"));
        }
        let id = args.get(0).and_then(Value::as_str).ok_or_else(|| invalid_params("id must be a string"))?;
        let opts = args.get(1).cloned().unwrap_or(Value::Null);
        let offset = opts.get("offset").and_then(Value::as_u64).unwrap_or(0) as usize;
        let limit = (opts.get("limit").and_then(Value::as_u64).unwrap_or(TREE_MAX as u64) as usize).clamp(1, TREE_MAX);
        let root = self.read(|c| store::get(c, id))?.ok_or_else(|| not_found("resource"))?;
        let visible = |r: &Row| !info.ai || self.read(|c| store::is_ai_visible(c, &r.id)).unwrap_or(false);
        if !visible(&root) {
            return Err(not_found("resource"));
        }
        let mut out = Vec::new();
        let mut seen = std::collections::HashSet::from([root.id.clone()]);
        // (row, depth) to visit, last first.
        let mut stack: Vec<(Row, usize)> = self.read(|c| kids(c, &root.id))?.into_iter().rev().map(|r| (r, 1)).collect();
        let mut index = 0usize;
        let mut more = false;
        while let Some((r, depth)) = stack.pop() {
            if !seen.insert(r.id.clone()) || r.kind == store::KIND_TREE || !visible(&r) {
                continue;
            }
            if index >= offset + limit {
                more = true;
                break;
            }
            if index >= offset {
                let meta = self.row_meta(&r);
                out.push(json!({
                    "id": r.id, "name": r.name, "kind": r.kind, "icon": meta.icon, "depth": depth,
                    "parent": r.parent_id, "rev": r.rev,
                }));
            }
            index += 1;
            if depth < TREE_MAX_DEPTH {
                for k in self.read(|c| kids(c, &r.id))?.into_iter().rev() {
                    stack.push((k, depth + 1));
                }
            }
        }
        Ok(json!({ "nodes": out, "next": more.then_some(offset + limit) }))
    }

    /// K-b: another resource's embed view, as the interface would get it.
    pub(crate) async fn host_embed(&self, plugin: &Plugin, info: &CallInfo, args: &Value) -> KResult<Value> {
        if !plugin.manifest.requires.contents {
            return Err(denied("notRequested"));
        }
        let id = args.get(0).and_then(Value::as_str).ok_or_else(|| invalid_params("id must be a string"))?.to_string();
        if info.ai && !self.read(|c| store::is_ai_visible(c, &id))? {
            return Err(not_found("resource"));
        }
        let opts = args.get(1).cloned().unwrap_or(Value::Null);
        let section = opts.get("section").and_then(Value::as_str).map(String::from);
        let call_args = opts.get("args").cloned().filter(|v| !v.is_null());
        let p = ResourceEmbedParams { id, section, env_id: info.env_id.clone(), locale: None, args: call_args };
        let out = self.resource_embed(p).await?;
        serde_json::to_value(out).map_err(internal)
    }

    /// K-h: the references a resource makes, as its info panel shows them.
    pub(crate) fn host_refs(&self, plugin: &Plugin, info: &CallInfo, args: &Value) -> KResult<Value> {
        if !plugin.manifest.requires.resources {
            return Err(denied("notRequested"));
        }
        let id = args.get(0).and_then(Value::as_str).ok_or_else(|| invalid_params("id must be a string"))?;
        if info.ai && !self.read(|c| store::is_ai_visible(c, id))? {
            return Err(not_found("resource"));
        }
        if self.read(|c| store::get(c, id))?.is_none() {
            return Err(not_found("resource"));
        }
        let out: Vec<Value> = self
            .refs_outgoing(id)?
            .into_iter()
            .map(|r| {
                let target = r.target.as_ref().filter(|_| r.state == RefState::Ok).map(|t| {
                    let kind = self.read(|c| store::get(c, &t.id)).ok().flatten().map(|row| row.kind);
                    json!({ "id": t.id, "name": t.name, "kind": kind })
                });
                json!({ "text": r.text, "target": target, "section": r.section, "embed": r.embed })
            })
            .collect();
        Ok(Value::Array(out))
    }

    /// K-j: the order `texts` sort in for `locale` (indexes into `texts`).
    pub(crate) fn host_collate(&self, args: &Value) -> KResult<Value> {
        let texts: Vec<String> = serde_json::from_value(args.get(0).cloned().unwrap_or(Value::Null)).map_err(|_| invalid_params("texts must be a list of strings"))?;
        if texts.len() > COLLATE_MAX {
            return Err(invalid_params("texts: at most 20000"));
        }
        let locale = args.get(1).and_then(Value::as_str).unwrap_or("en-US");
        let mut order: Vec<usize> = (0..texts.len()).collect();
        order.sort_by(|&a, &b| collate_cmp(locale, &texts[a], &texts[b]).then(a.cmp(&b)));
        Ok(json!(order))
    }

    /// K-g: a stored file written to a granted folder (never over an existing file).
    pub(crate) async fn host_write_blob(&self, plugin: &Plugin, info: &CallInfo, args: &Value) -> KResult<Value> {
        if info.event {
            return Err(denied("notInRun"));
        }
        if !plugin.manifest.requires.files {
            return Err(denied("notRequested"));
        }
        let blob = args.get(0).and_then(Value::as_str).ok_or_else(|| invalid_params("blob must be a string"))?.to_string();
        let raw = args.get(1).and_then(Value::as_str).ok_or_else(|| invalid_params("path must be a string"))?.to_string();
        if !crate::blobs::is_blob(&blob) {
            return Err(invalid("unknownBlob"));
        }
        // Used by a resource the plugin may read: one of its own kinds, or any with `requires.contents`.
        let users: Vec<Row> = self.read(|c| {
            let mut st = c.prepare_cached("SELECT resource_id FROM blob_uses WHERE hash = ?1")?;
            let ids = st.query_map([&blob], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
            let mut rows = Vec::new();
            for id in ids {
                if let Some(r) = store::get(c, &id)? {
                    rows.push(r);
                }
            }
            Ok(rows)
        })?;
        let readable = |r: &Row| plugin.manifest.requires.contents || crate::manifest::Registry::split(&r.kind).is_some_and(|(p, _)| p == plugin.id);
        if !users.iter().any(readable) {
            return Err(invalid("unknownBlob"));
        }
        let source = crate::blobs::path(&self.ws.dir, &blob);
        // A path without an extension gets the image's own (`.png`, `.jpg`, `.gif`, `.webp`).
        let raw = if std::path::Path::new(&raw).extension().is_none() {
            let head = std::fs::read(&source).map_err(|_| not_found("blob"))?;
            match crate::blobs::sniff(&head).map(|s| s.ty) {
                Some("image/png") => format!("{raw}.png"),
                Some("image/jpeg") => format!("{raw}.jpg"),
                Some("image/gif") => format!("{raw}.gif"),
                Some("image/webp") => format!("{raw}.webp"),
                _ => raw,
            }
        } else {
            raw
        };
        let (grants, raw) = self.files_scope_pub(plugin, &raw)?;
        let me = self.me.upgrade().ok_or_else(|| internal("kernel stopped"))?;
        let actor = plugin.actor();
        let task = tokio::spawn(async move {
            let (path, len) = tokio::task::spawn_blocking(move || -> KResult<(String, usize)> {
                let bytes = std::fs::read(&source).map_err(|_| not_found("blob"))?;
                let mut part = crate::files::part_file(&grants, &raw, false)?;
                let shown = crate::files::resolve(&grants, &raw)?.display().to_string();
                let mut f = part.take_file();
                f.write_all(&bytes).map_err(internal)?;
                f.sync_all().map_err(internal)?;
                drop(f);
                part.commit(false)?;
                Ok((shown, bytes.len()))
            })
            .await
            .map_err(internal)??;
            me.execute(actor, crate::pipeline::Command::Audit { op: "files.write".into(), object: path.clone(), summary: json!({ "bytes": len }) })
                .await?;
            Ok::<_, ProtocolError>(path)
        });
        let path = task.await.map_err(internal)??;
        Ok(json!({ "path": path }))
    }

    /// K-c: where a node (`id`, `kind`, `name`; `id` empty for one about to be made) lands when the user moves it
    /// into, or makes it in, a resource whose kind declares `place`. `dest` is what the user asked for; the answer is
    /// the place to use, or the kind's refusal (its message). No answer within `PLACE_TIMEOUT`, or a broken one: the
    /// place asked for.
    pub(crate) async fn placed(&self, id: &str, kind_of: &str, name: &str, dest: MoveDest) -> KResult<Result<MoveDest, Label>> {
        let parent_id = match &dest {
            MoveDest::Inside(p) => p.clone(),
            MoveDest::Before(t) | MoveDest::After(t) => self.read(|c| store::get(c, t))?.and_then(|r| r.parent_id),
        };
        let Some(parent_id) = parent_id else { return Ok(Ok(dest)) };
        let Some(parent) = self.read(|c| store::get(c, &parent_id))? else { return Ok(Ok(dest)) };
        let Some((plugin, kind)) = self.registry.kind_at(&parent.kind, parent.plugin_version.as_deref()) else { return Ok(Ok(dest)) };
        if !kind.place || !self.plugin_enabled(&plugin.id) || parent.id == id {
            return Ok(Ok(dest));
        }
        // The sibling the node would be put before (`null`: at the end), as asked.
        let siblings: Vec<Row> = self.read(|c| kids(c, &parent.id))?.into_iter().filter(|r| r.id != id).collect();
        let before = match &dest {
            MoveDest::Inside(_) => None,
            MoveDest::Before(t) => Some(t.clone()),
            MoveDest::After(t) => siblings.iter().position(|r| &r.id == t).and_then(|i| siblings.get(i + 1)).map(|r| r.id.clone()),
        };
        let resource = serde_json::to_value(self.resource(&parent)?).map_err(internal)?;
        let resource = crate::deps::without_secrets(resource, &self.secret_fields(&parent.kind, parent.plugin_version.as_deref()));
        let ctx = json!({ "resource": resource, "params": {} });
        let node_id = (!id.is_empty()).then_some(id);
        let ask = json!({ "node": { "id": node_id, "kind": kind_of, "name": name }, "before": before });
        let info = CallInfo { pure: true, resource_id: Some(parent.id.clone()), ..Default::default() };
        let raw = match self.call_version(plugin, "kinds", &kind.id, "place", json!([ctx, ask]), info, None, Some(PLACE_TIMEOUT)).await {
            Ok(v) => v,
            Err(_) => return Ok(Ok(dest)),
        };
        let Ok(answer) = serde_json::from_value::<PlaceAnswer>(raw) else { return Ok(Ok(dest)) };
        if let Some(msg) = answer.refuse {
            return Ok(Err(msg));
        }
        Ok(Ok(match answer.before {
            Some(b) if siblings.iter().any(|r| r.id == b) => MoveDest::Before(b),
            _ => MoveDest::Inside(Some(parent.id.clone())),
        }))
    }
}

/// Live children of `id`, in tree order.
fn kids(c: &rusqlite::Connection, id: &str) -> rusqlite::Result<Vec<Row>> {
    let mut st = c.prepare_cached(&format!("SELECT {} FROM resources WHERE parent_id = ?1 AND deleted_at IS NULL ORDER BY pos, id", store::COLUMNS))?;
    let rows = st.query_map([id], store::from_row)?;
    rows.collect()
}

/// Compares two texts the way `locale` sorts them (ICU collation; Chinese: pinyin). An unknown language sorts as the
/// root order.
#[cfg(feature = "collate")]
pub fn collate_cmp(locale: &str, a: &str, b: &str) -> std::cmp::Ordering {
    use icu_collator::{options::CollatorOptions, Collator, CollatorPreferences};
    let loc = icu_locale_core::Locale::try_from_str(locale).unwrap_or(icu_locale_core::Locale::UNKNOWN);
    match Collator::try_new(CollatorPreferences::from(&loc), CollatorOptions::default()) {
        Ok(c) => c.compare(a, b),
        Err(_) => a.cmp(b),
    }
}

/// Without the `collate` feature (a kernel linked into the window or the development host): case-insensitive, then by
/// characters.
#[cfg(not(feature = "collate"))]
pub fn collate_cmp(_locale: &str, a: &str, b: &str) -> std::cmp::Ordering {
    a.to_lowercase().cmp(&b.to_lowercase()).then_with(|| a.cmp(b))
}

#[cfg(all(test, feature = "collate"))]
mod tests {
    use super::collate_cmp;
    use std::cmp::Ordering::Less;

    #[test]
    fn chinese_sorts_by_pinyin_and_others_by_their_letters() {
        assert_eq!(collate_cmp("zh-CN", "阿", "比"), Less);
        assert_eq!(collate_cmp("zh-CN", "比", "词"), Less);
        assert_eq!(collate_cmp("zh-CN", "勾股定理", "三角形"), Less);
        assert_eq!(collate_cmp("en-US", "apple", "Banana"), Less);
        assert_eq!(collate_cmp("xx-bad-!!", "a", "b"), Less);
    }
}
