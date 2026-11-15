//! `page.resolve` / `page.save` (kernel-design §9, week1-protocol §5).

use onedesk_protocol::*;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::kernel::{node_target, url_decode, Inner};
use crate::manifest::Plugin;
use crate::pipeline::{Actor, Changes, Command, NewResource};
use crate::store::{self, Row, KIND_GROUP};
use crate::util::*;

/// Parsed open target.
pub enum Target {
    Resource(String),
    New { kind: String, parent: Option<String> },
    Node { tree: String, key: String },
    Other,
}

pub fn parse_target(t: &str) -> Target {
    if let Some(id) = t.strip_prefix("resource:") {
        return Target::Resource(id.to_string());
    }
    if let Some(rest) = t.strip_prefix("new:") {
        let (kind, query) = rest.split_once('?').unwrap_or((rest, ""));
        let parent = query
            .split('&')
            .filter_map(|kv| kv.split_once('='))
            .find(|(k, _)| *k == "parent")
            .and_then(|(_, v)| url_decode(v))
            .filter(|v| !v.is_empty());
        return Target::New { kind: kind.to_string(), parent };
    }
    if let Some(rest) = t.strip_prefix("node:") {
        // Tree ids contain no `/`; the key is URL-encoded.
        if let Some((tree, key)) = rest.split_once('/') {
            if let Some(key) = url_decode(key) {
                return Target::Node { tree: tree.to_string(), key };
            }
        }
    }
    Target::Other
}

/// Whether `t` is one of the §9.1 target forms (for `host.ui.open`).
pub fn is_target(t: &str) -> bool {
    ["resource:", "plugin:", "run:", "node:", "page:", "core:", "new:"]
        .iter()
        .any(|p| t.strip_prefix(p).is_some_and(|rest| !rest.is_empty()))
}

/// What a page handler's `render` may return; anything else is a `pluginError`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RenderOut {
    view: Vec<ViewNode>,
    #[serde(default)]
    values: Option<JsonMap>,
    #[serde(default)]
    basis: Option<String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    icon: Option<String>,
    #[serde(default)]
    breadcrumb: Option<Vec<PluginCrumb>>,
    #[serde(default)]
    read_only: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PluginCrumb {
    label: String,
    #[serde(default)]
    key: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SaveOut {
    #[serde(default)]
    basis: Option<String>,
}

fn bad_output(plugin: &str, e: impl std::fmt::Display) -> ProtocolError {
    ProtocolError {
        code: ErrorCode::PluginError,
        params: [("reason".to_string(), "badOutput".to_string()), ("plugin".to_string(), plugin.to_string())].into(),
        detail: Some(e.to_string()),
    }
}

fn binds(view: &[ViewNode]) -> Vec<String> {
    view.iter()
        .filter_map(|n| match n {
            ViewNode::Form { fields, .. } => Some(fields.iter().filter_map(|f| f.bind.clone())),
            _ => None,
        })
        .flatten()
        .collect()
}

fn blank(target: &str) -> PageDescriptor {
    PageDescriptor {
        target: target.to_string(),
        title: String::new(),
        icon: String::new(),
        kind_label: None,
        found: true,
        state: NodeState::Ok,
        state_reason: None,
        breadcrumb: vec![],
        page: PageKind::View,
        view: vec![],
        actions: vec![],
        result_tabs: vec![],
        resource_id: None,
        run_id: None,
        uses_env: false,
        has_info: false,
        read_only: false,
        recompute: false,
        values: JsonMap::new(),
        autosave: false,
        basis: None,
    }
}

fn missing(target: &str) -> PageDescriptor {
    PageDescriptor { found: false, page: PageKind::Missing, title: target.to_string(), icon: "circle-help".into(), ..blank(target) }
}

fn actions(p: &Plugin, page: &str) -> Vec<ActionDecl> {
    p.page(page)
        .map(|pg| {
            pg.actions
                .iter()
                .map(|a| ActionDecl {
                    id: a.id.clone(),
                    label: p.label(&a.label),
                    icon: a.icon.clone(),
                    primary: a.primary,
                    danger: a.danger,
                    shortcut: a.shortcut.clone(),
                    role: a.role,
                    disabled: None,
                })
                .collect()
        })
        .unwrap_or_default()
}

impl Inner {
    pub async fn resolve(&self, target: &str, cx: PageContext, client: Option<String>) -> KResult<PageDescriptor> {
        match parse_target(target) {
            Target::Resource(id) => match self.read(|c| store::get(c, &id))? {
                Some(r) if !self.hidden_tree(&r) => self.resolve_resource(target, &r, &cx, client).await,
                _ => Ok(missing(target)),
            },
            Target::New { kind, parent } => self.resolve_new(target, &kind, parent, &cx, client).await,
            Target::Node { tree, key } => self.resolve_node(target, &tree, &key, &cx, client).await,
            Target::Other => Ok(missing(target)),
        }
    }

    fn crumbs(&self, r: &Row) -> KResult<Vec<Crumb>> {
        let mut chain = self.read(|c| store::ancestors(c, r))?;
        chain.push(r.clone());
        Ok(chain
            .into_iter()
            .map(|a| Crumb {
                icon: Some(self.kind_meta(&a.kind).icon),
                tree: a.tree.clone(),
                target: (a.kind != KIND_GROUP).then(|| format!("resource:{}", a.id)),
                key: Some(a.id),
                label: a.name,
            })
            .collect())
    }

    async fn render(
        &self,
        plugin: &Plugin,
        page: &str,
        ctx: Value,
        client: Option<String>,
    ) -> KResult<RenderOut> {
        let out = self.call_plugin(&plugin.id, "pages", page, "render", json!([ctx]), client).await?;
        serde_json::from_value::<RenderOut>(out).map_err(|e| bad_output(&plugin.id, e))
    }

    async fn resolve_resource(
        &self,
        target: &str,
        r: &Row,
        cx: &PageContext,
        client: Option<String>,
    ) -> KResult<PageDescriptor> {
        let meta = self.kind_meta(&r.kind);
        let mut d = PageDescriptor {
            title: r.name.clone(),
            icon: meta.icon.clone(),
            kind_label: Some(meta.label.clone()),
            state: meta.state,
            breadcrumb: self.crumbs(r)?,
            resource_id: Some(r.id.clone()),
            has_info: true,
            basis: Some(r.rev.to_string()),
            ..blank(target)
        };
        if r.kind == KIND_GROUP {
            return Ok(d);
        }
        let Some((pid, page)) = meta.page else {
            if meta.state == NodeState::MissingPlugin {
                return Err(err_p(ErrorCode::PluginError, &[("reason", "notLoaded"), ("kind", &r.kind)]));
            }
            return Ok(d);
        };
        let plugin = self.registry.plugin(&pid).ok_or_else(|| err_p(ErrorCode::PluginError, &[("reason", "notLoaded")]))?;
        let ctx = json!({ "target": target, "resource": self.resource(r)?, "draft": cx.draft, "locale": cx.locale });
        let out = self.render(plugin, &page, ctx, client).await?;
        d.values = binds(&out.view).into_iter().filter_map(|b| store::value_at(r, &b).map(|v| (b, v))).collect();
        d.actions = actions(plugin, &page);
        d.view = out.view;
        Ok(d)
    }

    async fn resolve_new(
        &self,
        target: &str,
        kind: &str,
        parent: Option<String>,
        cx: &PageContext,
        client: Option<String>,
    ) -> KResult<PageDescriptor> {
        let Some((plugin, decl)) = self.registry.kind(kind) else { return Ok(missing(target)) };
        let Some(page) = decl.page.clone() else { return Ok(missing(target)) };
        let name = decl.new_name.as_deref().map(|k| plugin.text(k, cx.locale.as_deref())).unwrap_or_default();
        let draft_row = Row {
            id: String::new(),
            kind: kind.to_string(),
            plugin_version: Some(plugin.version.clone()),
            tree: decl.tree.as_deref().map(|t| plugin.tree_ref(t)),
            parent_id: parent.clone(),
            pos: 0,
            name: name.clone(),
            description: String::new(),
            tags: vec![],
            body: decl.defaults.clone(),
            origin: "original".into(),
            origin_ref: None,
            state: "ok".into(),
            rev: 0,
            created_at: 0,
            created_by: String::new(),
            updated_at: 0,
            updated_by: String::new(),
            deleted_at: None,
        };
        let mut breadcrumb = match &parent {
            Some(p) => match self.read(|c| store::get(c, p))? {
                Some(pr) => self.crumbs(&pr)?,
                None => vec![],
            },
            None => vec![],
        };
        breadcrumb.push(Crumb { label: name.clone(), icon: Some(decl.icon.clone()), tree: None, key: None, target: None });
        let resource = self.resource(&draft_row)?;
        let ctx = json!({ "target": target, "resource": resource, "draft": cx.draft, "locale": cx.locale });
        let out = self.render(plugin, &page, ctx, client).await?;
        let values = binds(&out.view).into_iter().filter_map(|b| store::value_at(&draft_row, &b).map(|v| (b, v))).collect();
        Ok(PageDescriptor {
            title: name,
            icon: decl.icon.clone(),
            kind_label: Some(plugin.label(&decl.label)),
            breadcrumb,
            actions: actions(plugin, &page),
            has_info: true,
            values,
            view: out.view,
            ..blank(target)
        })
    }

    async fn resolve_node(
        &self,
        target: &str,
        tree: &str,
        key: &str,
        cx: &PageContext,
        client: Option<String>,
    ) -> KResult<PageDescriptor> {
        let Some((plugin, decl)) = self.registry.tree(tree) else { return Ok(missing(target)) };
        let Some(page) = decl.page.clone() else { return Ok(missing(target)) };
        if decl.source != TreeSource::Provided {
            return Ok(missing(target));
        }
        let ctx = json!({ "target": target, "node": { "tree": tree, "key": key }, "draft": cx.draft, "locale": cx.locale });
        let out = self.render(plugin, &page, ctx, client).await?;
        Ok(PageDescriptor {
            title: out.title.unwrap_or_else(|| key.to_string()),
            icon: out.icon.unwrap_or_else(|| decl.icon.clone()),
            breadcrumb: out
                .breadcrumb
                .unwrap_or_default()
                .into_iter()
                .map(|c| Crumb {
                    target: c.key.as_deref().map(|k| node_target(tree, k)),
                    tree: c.key.as_ref().map(|_| tree.to_string()),
                    key: c.key,
                    label: c.label,
                    icon: None,
                })
                .collect(),
            actions: actions(plugin, &page),
            read_only: out.read_only.unwrap_or(false),
            values: out.values.unwrap_or_default(),
            basis: out.basis,
            view: out.view,
            ..blank(target)
        })
    }

    pub async fn save(&self, p: PageSaveParams, client: Option<String>) -> KResult<PageSaveResult> {
        let cx = p.context.clone().unwrap_or_default();
        match parse_target(&p.target) {
            Target::Resource(id) => {
                let row = self.live_row(&id)?;
                if self.hidden_tree(&row) {
                    return Err(not_found("resource"));
                }
                let changes = Changes::from_bind_map(&p.changes)?;
                let basis = match &p.basis {
                    Some(b) => Some(b.parse::<i64>().map_err(|_| invalid_params("basis is not a rev"))?),
                    None => None,
                };
                if !changes.is_empty() {
                    self.execute(Actor::User, Command::Update { id: id.clone(), changes, basis }).await?;
                }
                let cx = PageContext { draft: None, ..cx };
                Ok(PageSaveResult { page: self.resolve(&p.target, cx, client).await? })
            }
            Target::New { kind, parent } => {
                let (plugin, decl) = self.registry.kind(&kind).ok_or_else(|| not_found("kind"))?;
                let changes = Changes::from_bind_map(&p.changes)?;
                let default_name =
                    decl.new_name.as_deref().map(|k| plugin.text(k, cx.locale.as_deref())).unwrap_or_else(|| kind.clone());
                let name = changes.name.clone().filter(|n| !n.trim().is_empty()).unwrap_or(default_name);
                let mut body = decl.defaults.clone();
                for (k, v) in &changes.body {
                    if v.is_null() {
                        body.remove(k);
                    } else {
                        body.insert(k.clone(), v.clone());
                    }
                }
                let out = self
                    .execute(
                        Actor::User,
                        Command::Create(NewResource {
                            kind: kind.clone(),
                            tree: None,
                            parent,
                            name,
                            description: changes.description.clone().unwrap_or_default(),
                            tags: changes.tags.clone().unwrap_or_default(),
                            body,
                            plugin_version: Some(plugin.version.clone()),
                        }),
                    )
                    .await?;
                let id = out.id.ok_or_else(|| internal("no id"))?;
                let cx = PageContext { draft: None, ..cx };
                Ok(PageSaveResult { page: self.resolve(&format!("resource:{id}"), cx, client).await? })
            }
            Target::Node { tree, key } => {
                let (plugin, decl) = self.registry.tree(&tree).ok_or_else(|| not_found("tree"))?;
                let page = decl.page.clone().ok_or_else(|| not_found("page"))?;
                let ctx = json!({ "target": p.target, "node": { "tree": tree, "key": key }, "locale": cx.locale });
                let out = self
                    .call_plugin(&plugin.id, "pages", &page, "save", json!([ctx, p.changes, p.basis]), client.clone())
                    .await?;
                let saved: SaveOut = serde_json::from_value(if out.is_null() { json!({}) } else { out })
                    .map_err(|e| bad_output(&plugin.id, e))?;
                self.emit(format!("{}{tree}", topic::TREE), None, None);
                let cx = PageContext { draft: None, ..cx };
                let mut page = self.resolve(&p.target, cx, client).await?;
                if page.basis.is_none() {
                    page.basis = saved.basis;
                }
                Ok(PageSaveResult { page })
            }
            Target::Other => Err(not_found("target")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn targets_parse() {
        assert!(matches!(parse_target("resource:abc"), Target::Resource(id) if id == "abc"));
        assert!(matches!(parse_target("new:a.b:k?parent=p1"), Target::New { kind, parent: Some(p) } if kind == "a.b:k" && p == "p1"));
        assert!(matches!(parse_target("new:a.b:k"), Target::New { parent: None, .. }));
        assert!(matches!(parse_target("node:a.b:disk/%2Fx%2Fy"), Target::Node { tree, key } if tree == "a.b:disk" && key == "/x/y"));
        assert!(is_target("resource:x") && !is_target("https://x") && !is_target("resource:"));
    }
}
