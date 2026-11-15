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
    /// Shell pages the kernel only names (`core:audit`, `core:deleted`).
    Core(String),
    /// `plugin:<id>`: the plugin page, drawn by the shell from `plugin.get`.
    Plugin(String),
    /// `run:<id>`: a past run, shown read-only with its input snapshot.
    Run(String),
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
    if let Some(p) = t.strip_prefix("plugin:").filter(|p| !p.is_empty()) {
        return Target::Plugin(p.to_string());
    }
    if let Some(r) = t.strip_prefix("run:").filter(|r| !r.is_empty()) {
        return Target::Run(r.to_string());
    }
    if let Some(p) = t.strip_prefix("core:") {
        if p == "audit" || p == "deleted" {
            return Target::Core(p.to_string());
        }
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

fn core_page(target: &str, page: &str) -> PageDescriptor {
    let (kind, icon) = if page == "audit" { (PageKind::Audit, "scroll-text") } else { (PageKind::Deleted, "trash-2") };
    PageDescriptor { title: target.to_string(), icon: icon.into(), page: kind, ..blank(target) }
}

/// D276: a configuration node's page is a form the kernel builds from its parameter table.
fn param_form(r: &Row) -> (Vec<ViewNode>, JsonMap) {
    let mut fields = Vec::new();
    let mut values = JsonMap::new();
    for (name, p) in crate::params::params_of(r) {
        let kind = match p.ty {
            ParamType::Number => FieldKind::Number,
            ParamType::Boolean => FieldKind::Boolean,
            ParamType::List => FieldKind::Longtext,
            ParamType::Secret => FieldKind::Secret,
            ParamType::Text | ParamType::Ref => FieldKind::Text,
        };
        let bind = format!("params.{name}");
        values.insert(bind.clone(), Value::String(p.value));
        fields.push(ViewField {
            label: Label::Text(name.clone()),
            name,
            kind,
            bind: Some(bind),
            param: None,
            options: None,
            presets: None,
            fill: None,
            language: None,
            hint: None,
            placeholder: None,
            env_value: None,
            env_source: None,
            read_only: None,
        });
    }
    (vec![ViewNode::Form { id: "params".into(), layout: FormLayout::Stack, label: None, fields }], values)
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
                    action: a.action.as_ref().map(|x| p.full(x)),
                    confirm: a.action.as_deref().and_then(|x| p.action(x)).and_then(|d| d.confirm.as_deref()).map(|k| p.label(k)),
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Manifest page settings the frame needs (D284): actions, result tabs, recompute, environment use.
fn page_frame(d: &mut PageDescriptor, p: &Plugin, page: &str) {
    d.actions = actions(p, page);
    if let Some(pg) = p.page(page) {
        d.recompute = pg.recompute;
        d.uses_env = pg.uses_env;
        d.result_tabs = pg
            .result_tabs
            .iter()
            .map(|t| ResultTabDecl { id: t.id.clone(), label: p.label(&t.label), icon: t.icon.clone(), tab_type: t.tab_type })
            .collect();
    }
}

impl Inner {
    pub async fn resolve(&self, target: &str, cx: PageContext, client: Option<String>) -> KResult<PageDescriptor> {
        match parse_target(target) {
            Target::Resource(id) => match self.read(|c| store::get(c, &id))? {
                Some(r) if !self.hidden_tree(&r) => {
                    self.touch(&r.id).await;
                    self.resolve_resource(target, &r, &cx, client).await
                }
                _ => Ok(missing(target)),
            },
            Target::Core(page) => Ok(core_page(target, &page)),
            Target::Plugin(id) => Ok(self.resolve_plugin(target, &id)),
            Target::Run(id) => self.resolve_run(target, &id, &cx, client).await,
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
        mut ctx: Value,
        client: Option<String>,
    ) -> KResult<RenderOut> {
        let env = ctx.get("envId").and_then(Value::as_str).map(String::from);
        ctx["envId"] = json!(env);
        let info = crate::sandbox::CallInfo { client, env_id: env, run_id: None };
        let out = self
            .call_plugin_with(&plugin.id, "pages", page, "render", json!([ctx]), info, None, None)
            .await
            .map_err(|e| e.to_protocol())?;
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
        if r.kind == store::KIND_ENV {
            // Drawn by the shell from `params.env` (sources and inheritance), D276.
            d.page = PageKind::Env;
            d.uses_env = true;
            return Ok(d);
        }
        if r.kind == store::KIND_CONFIG {
            let (view, values) = param_form(r);
            d.view = view;
            d.values = values;
            d.autosave = true;
            return Ok(d);
        }
        let Some((pid, page)) = meta.page else {
            if meta.state == NodeState::MissingPlugin {
                return Err(err_p(ErrorCode::PluginError, &[("reason", "notLoaded"), ("kind", &r.kind)]));
            }
            return Ok(d);
        };
        let plugin = self.registry.plugin(&pid).ok_or_else(|| err_p(ErrorCode::PluginError, &[("reason", "notLoaded")]))?;
        if meta.state == NodeState::Disabled {
            // D290: the data stays; the page says the plugin is off and shows nothing editable.
            d.read_only = true;
            return Ok(d);
        }
        let ctx = json!({ "target": target, "resource": self.resource(r)?, "draft": cx.draft, "locale": cx.locale, "envId": cx.env_id });
        let out = self.render(plugin, &page, ctx, client).await?;
        d.values = binds(&out.view).into_iter().filter_map(|b| store::value_at(r, &b).map(|v| (b, v))).collect();
        page_frame(&mut d, plugin, &page);
        d.view = out.view;
        Ok(d)
    }

    fn resolve_plugin(&self, target: &str, id: &str) -> PageDescriptor {
        match self.registry.plugin(id) {
            Some(p) => PageDescriptor {
                title: p.text(&p.manifest.name, None),
                icon: p.manifest.icon.clone(),
                page: PageKind::Plugin,
                state: if self.plugin_enabled(id) { NodeState::Ok } else { NodeState::Disabled },
                ..blank(target)
            },
            None if self.rejected_for(id).is_some() => {
                PageDescriptor { title: id.into(), icon: "puzzle".into(), page: PageKind::Plugin, state: NodeState::Broken, ..blank(target) }
            }
            None => missing(target),
        }
    }

    /// A past run: its resource's page, read-only, with the input snapshot as values (§8, round 3 §3).
    async fn resolve_run(&self, target: &str, id: &str, cx: &PageContext, client: Option<String>) -> KResult<PageDescriptor> {
        let Some(run) = self.read(|c| store::run_get(c, id))? else { return Ok(missing(target)) };
        let live = run.resource_id.as_deref().and_then(|r| self.read(|c| store::get(c, r)).ok().flatten());
        let values: JsonMap = serde_json::from_value(run.input.clone()).unwrap_or_default();
        let mut breadcrumb = match &live {
            Some(r) => self.crumbs(r)?,
            None => vec![],
        };
        breadcrumb.push(Crumb { label: format!("#{}", run.seq), icon: Some("history".into()), tree: None, key: None, target: None });
        let mut d = PageDescriptor {
            title: run.title.clone(),
            icon: run.icon.clone(),
            breadcrumb,
            resource_id: live.as_ref().map(|r| r.id.clone()),
            run_id: Some(run.id.clone()),
            read_only: true,
            has_info: live.is_some(),
            values: values.clone(),
            ..blank(target)
        };
        let Some((plugin, page)) = run.resource_kind.as_deref().and_then(|k| self.registry.kind(k)).and_then(|(p, k)| Some((p, k.page.clone()?)))
        else {
            return Ok(d);
        };
        d.kind_label = run.resource_kind.as_deref().map(|k| self.kind_meta(k).label);
        if !self.plugin_enabled(&plugin.id) {
            d.state = NodeState::Disabled;
            return Ok(d);
        }
        // The resource as it was: the live one with the snapshot applied, or one made from the snapshot.
        let mut row = live.clone().unwrap_or_else(|| Row {
            id: run.resource_id.clone().unwrap_or_default(),
            kind: run.resource_kind.clone().unwrap_or_default(),
            plugin_version: Some(plugin.version.clone()),
            tree: None,
            parent_id: None,
            pos: 0,
            name: run.title.clone(),
            description: String::new(),
            tags: vec![],
            body: JsonMap::new(),
            origin: "original".into(),
            origin_ref: None,
            state: "ok".into(),
            rev: 0,
            created_at: 0,
            created_by: String::new(),
            updated_at: 0,
            updated_by: String::new(),
            deleted_at: None,
        });
        for (k, v) in &values {
            if let Some(b) = k.strip_prefix("body.") {
                row.body.insert(b.to_string(), v.clone());
            } else if k == "name" {
                if let Some(n) = v.as_str() {
                    row.name = n.to_string();
                }
            }
        }
        let protocol_run = self.run_to_protocol(run.clone(), false);
        let ctx = json!({ "target": target, "resource": self.resource(&row)?, "draft": values, "run": protocol_run,
                          "locale": cx.locale, "envId": run.env_id });
        let out = self.render(plugin, &page, ctx, client).await?;
        page_frame(&mut d, plugin, &page);
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
        if !self.plugin_enabled(&plugin.id) {
            return Ok(PageDescriptor { state: NodeState::Disabled, read_only: true, ..missing(target) });
        }
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
        let ctx = json!({ "target": target, "resource": resource, "draft": cx.draft, "locale": cx.locale, "envId": cx.env_id });
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
            recompute: plugin.page(&page).is_some_and(|p| p.recompute),
            uses_env: plugin.page(&page).is_some_and(|p| p.uses_env),
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
        if !self.plugin_enabled(&plugin.id) {
            return Ok(PageDescriptor { state: NodeState::Disabled, read_only: true, ..missing(target) });
        }
        let Some(page) = decl.page.clone() else { return Ok(missing(target)) };
        if decl.source != TreeSource::Provided {
            return Ok(missing(target));
        }
        let ctx = json!({ "target": target, "node": { "tree": tree, "key": key }, "draft": cx.draft, "locale": cx.locale, "envId": cx.env_id });
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
                if decl.source != TreeSource::Provided {
                    return Err(not_found("tree"));
                }
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
            Target::Core(_) | Target::Plugin(_) | Target::Run(_) | Target::Other => Err(not_found("target")),
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
