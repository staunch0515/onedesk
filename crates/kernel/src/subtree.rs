//! D487 §13 (docs/redesign/book.md): what a plugin that arranges other resources needs, in general terms.
//! - K-a `host.resources.tree(id, { offset?, limit? })`: everything below a resource in tree order (parents before
//!   children), with depth and revision, never the body; `requires.resources`.
//! - K-b `host.resources.embed(id, { section?, args? })`: what another resource shows where it is embedded;
//!   `requires.contents`.
//! - K-c `place`: a kind decides where a node lands when it is moved into (or made in) a resource of the kind.
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
