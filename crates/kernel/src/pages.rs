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
    /// Round 11: `page:<plugin>/<page>`, a plugin's standalone page (D382).
    Page { plugin: String, page: String },
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
    if let Some((plugin, page)) = t.strip_prefix("page:").and_then(|r| r.split_once('/')) {
        if !plugin.is_empty() && !page.is_empty() && !page.contains('/') {
            return Target::Page { plugin: plugin.to_string(), page: page.to_string() };
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

/// D414: most choices the kernel lists for a `ref` field.
pub const MAX_REF_OPTIONS: usize = 1000;

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

/// A draft without the given bind paths (secret fields never reach a plugin, D306).
pub fn strip(draft: Option<JsonMap>, fields: &[String]) -> Option<JsonMap> {
    draft.map(|mut d| {
        for f in fields {
            d.remove(f);
        }
        d
    })
}

/// D358: the page parameters as `ctx.params` (an empty object when none were sent).
pub fn ctx_params(cx: &PageContext) -> Value {
    json!(cx.params.clone().unwrap_or_default())
}

pub fn bind_paths(view: &[ViewNode]) -> Vec<String> {
    binds(view)
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
        restrictions: None,
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
            required: None,
            max_length: None,
            kinds: None,
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

/// D357: a page drawn for another plugin's kind: of its own items only `save` and `event` (its
/// actions do not apply to that kind), and no `view` result tabs (D351: a dependent's run results
/// are not handed to the page's code).
fn borrowed_frame(d: &mut PageDescriptor) {
    d.actions.retain(|a| matches!(a.role, ActionRole::Save | ActionRole::Event));
    d.result_tabs.retain(|t| t.tab_type != ResultTabType::View);
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
        if crate::runs::json_size(&cx.draft) + crate::runs::json_size(&cx.params) > crate::runs::MAX_INPUT_BYTES {
            return Err(err_p(ErrorCode::InvalidParams, &[("reason", "tooLarge")]));
        }
        let mut d = match parse_target(target) {
            Target::Resource(id) => match self.read(|c| store::get(c, &id))? {
                Some(r) if !self.hidden_tree(&r) => {
                    self.touch(&r.id).await;
                    // D321: the page shows resolved references under their targets' current names.
                    let shown = self.display_row(&r)?;
                    self.resolve_resource(target, &shown, &cx, client).await
                }
                _ => Ok(missing(target)),
            },
            Target::Core(page) => Ok(core_page(target, &page)),
            Target::Plugin(id) => Ok(self.resolve_plugin(target, &id)),
            Target::Run(id) => self.resolve_run(target, &id, &cx, client).await,
            Target::New { kind, parent } => self.resolve_new(target, &kind, parent, &cx, client).await,
            Target::Node { tree, key } => self.resolve_node(target, &tree, &key, &cx, client).await,
            Target::Page { plugin, page } => self.resolve_standalone(target, &plugin, &page, &cx, client).await,
            Target::Other => Ok(missing(target)),
        }?;
        // §6.3: the prohibitions in force for this page (workspace configuration + the tab's environment).
        let env = match parse_target(target) {
            Target::Run(id) => self.read(|c| store::run_get(c, &id))?.and_then(|r| r.env_id),
            _ => cx.env_id.clone(),
        };
        let r = self.read(|c| crate::policy::restrictions(c, env.as_deref()))?;
        d.restrictions = (!r.is_empty()).then_some(r);
        Ok(d)
    }

    /// D290 / review #3: a disabled plugin's resources keep their data but cannot be edited.
    pub fn kind_writable(&self, kind: &str) -> KResult<()> {
        match self.registry.kind(kind) {
            Some((p, _)) if !self.plugin_enabled(&p.id) => Err(denied("pluginDisabled")),
            // D356: a kind whose borrowed tree or page is not exported is not usable.
            Some(_) => self.kind_usable(kind),
            None => Ok(()),
        }
    }

    fn crumbs(&self, r: &Row) -> KResult<Vec<Crumb>> {
        let mut chain = self.read(|c| store::ancestors(c, r))?;
        chain.push(r.clone());
        Ok(chain
            .into_iter()
            .map(|a| Crumb {
                icon: Some(self.row_meta(&a).icon),
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
        let resource_id = ctx["resource"]["id"].as_str().filter(|i| !i.is_empty()).map(String::from);
        let info = crate::sandbox::CallInfo { client, env_id: env, resource_id, ..Default::default() };
        // The version given: for a resource, the one it is bound to (§7.6).
        let plugin = self.registry.version(&plugin.id, &plugin.version).unwrap_or(self.registry.plugin(&plugin.id).ok_or_else(|| not_found("plugin"))?);
        let out = self
            .call_version(plugin, "pages", page, "render", json!([ctx]), info, None, None)
            .await
            .map_err(|e| e.to_protocol())?;
        let mut out = serde_json::from_value::<RenderOut>(out).map_err(|e| bad_output(&plugin.id, e))?;
        // D393: table rows (lengths, row actions, row targets).
        let own = ctx["resource"]["id"].as_str().filter(|i| !i.is_empty());
        self.check_tables(plugin, own, &mut out.view)?;
        self.fill_ref_options(plugin, &mut out.view)?;
        Ok(out)
    }

    /// D414: a `ref` field with `kinds` and no `options` lists the resources of those kinds the
    /// plugin may see (its own kinds; others' with `requires.resources` or exported for reading),
    /// by name, at most `MAX_REF_OPTIONS`.
    fn fill_ref_options(&self, plugin: &Plugin, view: &mut [ViewNode]) -> KResult<()> {
        for node in view.iter_mut() {
            let ViewNode::Form { fields, .. } = node else { continue };
            for f in fields.iter_mut().filter(|f| f.kind == FieldKind::Ref && f.options.is_none()) {
                let Some(kinds) = &f.kinds else { continue };
                let mut opts: Vec<(String, String)> = Vec::new();
                for k in kinds {
                    let full = plugin.kind_ref(k);
                    let own = self.registry.kind(&full).is_some_and(|(o, _)| o.id == plugin.id);
                    if !(own || plugin.manifest.requires.resources || self.export_allows(plugin, &full, true)) {
                        continue;
                    }
                    for r in self.read(|c| store::of_kind(c, &full))? {
                        opts.push((r.name, r.id));
                    }
                }
                opts.sort();
                opts.truncate(MAX_REF_OPTIONS);
                f.options = Some(opts.into_iter().map(|(name, id)| FieldOption { value: id, label: Label::Text(name) }).collect());
            }
        }
        Ok(())
    }

    async fn resolve_resource(
        &self,
        target: &str,
        r: &Row,
        cx: &PageContext,
        client: Option<String>,
    ) -> KResult<PageDescriptor> {
        let meta = self.row_meta(r);
        let mut d = PageDescriptor {
            title: r.name.clone(),
            icon: meta.icon.clone(),
            kind_label: Some(meta.label.clone()),
            // Round 16: a resource whose source is gone still opens, marked.
            state: store::shown_state(r, meta.state, &None).0,
            state_reason: store::shown_state(r, meta.state, &None).1,
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
        // §7.6: bound to a version that is not installed — read-only and empty until it is back.
        if meta.state == NodeState::MissingPlugin {
            d.state_reason = meta.reason.clone();
            d.read_only = true;
            return Ok(d);
        }
        let (Some((_, page)), Some(plugin)) = (meta.page.clone(), meta.plugin) else { return Ok(d) };
        if meta.state == NodeState::Disabled {
            // D290: the data stays; the page says the plugin is off and shows nothing editable.
            d.read_only = true;
            return Ok(d);
        }
        let declared = self.registry.kind_at(&r.kind, r.plugin_version.as_deref()).and_then(|(_, k)| k.page.clone()).unwrap_or(page);
        // D357: a borrowed page is drawn by its plugin's code.
        let Some((drawer, page)) = self.page_plugin(plugin, &declared) else {
            d.read_only = true;
            return Ok(d);
        };
        let borrowed = drawer.id != plugin.id;
        let secret_fields = self.secret_fields(&r.kind, r.plugin_version.as_deref());
        let draft = strip(cx.draft.clone(), &secret_fields);
        let mut resource = serde_json::to_value(self.resource(r)?).map_err(internal)?;
        if borrowed {
            // Read only, and never the kind's secret fields (as a dependent reading it, §7.3).
            resource = crate::deps::without_secrets(resource, &secret_fields);
            resource["readOnly"] = json!(true);
        }
        let ctx = json!({ "target": target, "resource": resource, "draft": draft, "locale": cx.locale, "envId": cx.env_id, "params": ctx_params(cx) });
        let out = self.render(drawer, &page, ctx, client).await?;
        d.values = binds(&out.view).into_iter().filter_map(|b| store::value_at(r, &b).map(|v| (b, v))).collect();
        // Round 16 e2e #19: what the plugin's `render` gives as values is shown (a page drawing
        // content that is not a stored field, e.g. a file's text), never for a secret field.
        for (k, v) in out.values.clone().unwrap_or_default() {
            if !secret_fields.contains(&k) {
                d.values.insert(k, v);
            }
        }
        // And `readOnly: true` makes the page read-only (a plugin cannot make it writable).
        if out.read_only == Some(true) {
            d.read_only = true;
        }
        // D306: for a secret field the page learns only whether a value is saved.
        for f in &secret_fields {
            if let Some(v) = d.values.get_mut(f) {
                *v = Value::Bool(v.get("secret").and_then(Value::as_str).is_some());
            }
        }
        page_frame(&mut d, drawer, &page);
        if borrowed {
            borrowed_frame(&mut d);
            // Then the kind's own plugin's actions for this kind (they run as that plugin).
            d.actions.extend(self.own_kind_actions(plugin, &r.kind));
        }
        // Round 7 (§7.3): actions plugins depending on this one add to its kind, after its own.
        d.actions.extend(self.dependent_actions(&r.kind));
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
        let Some((kind_plugin, plugin, page)) = run
            .resource_kind
            .as_deref()
            .and_then(|k| self.registry.kind(k))
            .and_then(|(p, k)| self.page_plugin(p, k.page.as_deref()?).map(|(o, pg)| (p, o, pg)))
        else {
            return Ok(d);
        };
        d.kind_label = run.resource_kind.as_deref().map(|k| self.kind_meta(k).label);
        let borrowed = plugin.id != kind_plugin.id;
        // Review #1: a borrowed page is drawn only while the kind may use it (D356).
        let usable = !borrowed || run.resource_kind.as_deref().is_some_and(|k| self.kind_usable(k).is_ok());
        if !self.plugin_enabled(&plugin.id) || !self.plugin_enabled(&kind_plugin.id) || !usable {
            d.state = NodeState::Disabled;
            return Ok(d);
        }
        // The resource as it was: the live one with the snapshot applied, or one made from the snapshot.
        let mut row = live.clone().unwrap_or_else(|| Row {
            id: run.resource_id.clone().unwrap_or_default(),
            kind: run.resource_kind.clone().unwrap_or_default(),
            plugin_version: Some(kind_plugin.version.clone()),
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
        let mut protocol_run = serde_json::to_value(self.run_to_protocol(run.clone(), false)).map_err(internal)?;
        // D351 / review #1: another plugin's run is never handed to the page's code — no input,
        // summary, error or output.
        if run.plugin != plugin.id {
            if let Some(o) = protocol_run.as_object_mut() {
                for k in ["input", "summary", "error", "output"] {
                    o.remove(k);
                }
            }
        }
        let mut resource = serde_json::to_value(self.resource(&row)?).map_err(internal)?;
        let mut draft = values;
        if borrowed {
            // Like `resolve_resource`: read only, never the kind's secret fields.
            let secret_fields = self.secret_fields(&row.kind, row.plugin_version.as_deref());
            resource = crate::deps::without_secrets(resource, &secret_fields);
            resource["readOnly"] = json!(true);
            draft = strip(Some(draft), &secret_fields).unwrap_or_default();
        }
        let ctx = json!({ "target": target, "resource": resource, "draft": draft, "run": protocol_run,
                          "locale": cx.locale, "envId": run.env_id, "params": ctx_params(cx) });
        let out = self.render(plugin, &page, ctx, client).await?;
        page_frame(&mut d, plugin, &page);
        // D351: a dependent's run shows only the kernel's own result tabs (output, history).
        if run.plugin != plugin.id {
            d.result_tabs.retain(|t| t.tab_type != ResultTabType::View);
        }
        if borrowed {
            borrowed_frame(&mut d);
        }
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
        // D356: a kind whose borrowed tree or page is not exported cannot be created.
        if !self.plugin_enabled(&plugin.id) || self.kind_usable(kind).is_err() {
            return Ok(PageDescriptor { state: NodeState::Disabled, read_only: true, ..missing(target) });
        }
        let Some(declared) = decl.page.clone() else { return Ok(missing(target)) };
        let Some((drawer, page)) = self.page_plugin(plugin, &declared) else { return Ok(missing(target)) };
        let borrowed = drawer.id != plugin.id;
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
        let mut resource = serde_json::to_value(self.resource(&draft_row)?).map_err(internal)?;
        let secret_fields = self.secret_fields(kind, Some(&plugin.version));
        if borrowed {
            resource = crate::deps::without_secrets(resource, &secret_fields);
            resource["readOnly"] = json!(true);
        }
        let draft = if borrowed { strip(cx.draft.clone(), &secret_fields) } else { cx.draft.clone() };
        let ctx = json!({ "target": target, "resource": resource, "draft": draft, "locale": cx.locale, "envId": cx.env_id, "params": ctx_params(cx) });
        let out = self.render(drawer, &page, ctx, client).await?;
        let values = binds(&out.view).into_iter().filter_map(|b| store::value_at(&draft_row, &b).map(|v| (b, v))).collect();
        let mut d = PageDescriptor {
            title: name,
            icon: decl.icon.clone(),
            kind_label: Some(plugin.label(&decl.label)),
            breadcrumb,
            has_info: true,
            values,
            view: out.view,
            ..blank(target)
        };
        // K-R1: an unsaved page can run, so it has the same frame (result tabs…) as a saved one.
        page_frame(&mut d, drawer, &page);
        if borrowed {
            borrowed_frame(&mut d);
            d.actions.extend(self.own_kind_actions(plugin, kind));
        }
        Ok(d)
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
        let ctx = json!({ "target": target, "node": { "tree": tree, "key": key }, "draft": cx.draft, "locale": cx.locale, "envId": cx.env_id, "params": ctx_params(cx) });
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

    /// Round 11 (D382): a plugin's standalone page — one no kind or tree of that plugin uses.
    /// `ctx` has no resource and no node.
    pub(crate) fn standalone_page(&self, plugin: &str, page: &str) -> Option<&'static Plugin> {
        let p = self.registry.plugin(plugin)?;
        p.page(page)?;
        let c = &p.manifest.contributes;
        let used = c.kinds.iter().any(|k| k.page.as_deref() == Some(page)) || c.trees.iter().any(|t| t.page.as_deref() == Some(page));
        (!used).then_some(p)
    }

    async fn resolve_standalone(
        &self,
        target: &str,
        plugin: &str,
        page: &str,
        cx: &PageContext,
        client: Option<String>,
    ) -> KResult<PageDescriptor> {
        let Some(p) = self.standalone_page(plugin, page) else { return Ok(missing(target)) };
        if !self.plugin_enabled(plugin) {
            return Ok(PageDescriptor { state: NodeState::Disabled, read_only: true, ..missing(target) });
        }
        let ctx = json!({ "target": target, "draft": cx.draft, "locale": cx.locale, "envId": cx.env_id, "params": ctx_params(cx) });
        let out = self.render(p, page, ctx, client).await?;
        let mut d = PageDescriptor {
            title: out.title.unwrap_or_else(|| p.text(&p.manifest.name, cx.locale.as_deref())),
            icon: out.icon.unwrap_or_else(|| p.manifest.icon.clone()),
            read_only: out.read_only.unwrap_or(false),
            values: out.values.unwrap_or_default(),
            basis: out.basis,
            view: out.view,
            ..blank(target)
        };
        page_frame(&mut d, p, page);
        Ok(d)
    }

    pub async fn save(&self, p: PageSaveParams, client: Option<String>) -> KResult<PageSaveResult> {
        let cx = p.context.clone().unwrap_or_default();
        // D327: a save with the tab's environment also obeys that environment's chain. Parameter
        // tables themselves stay editable (otherwise the policy could not be turned off).
        let params_only = !p.changes.is_empty() && p.changes.keys().all(|k| k.starts_with("params."));
        if !params_only && !p.changes.is_empty() {
            if let Err(e) = self.read(|c| Ok(crate::policy::check(c, crate::policy::READONLY, cx.env_id.as_deref())))? {
                let _ = self
                    .pipeline
                    .execute(Actor::User, Command::Refused { op: "page.save".into(), object: p.target.clone(), error: e.clone() })
                    .await;
                return Err(e);
            }
        }
        match parse_target(&p.target) {
            Target::Resource(id) => {
                let row = self.live_row(&id)?;
                if self.hidden_tree(&row) {
                    return Err(not_found("resource"));
                }
                self.kind_writable(&row.kind)?;
                // D306: secret field values go to the keychain; the resource keeps the name.
                let mut raw = p.changes.clone();
                let secret_fields = self.secret_fields(&row.kind, row.plugin_version.as_deref());
                let pending = self.take_secret_fields(&row.id, &secret_fields, &mut raw, Some(&row.body))?;
                let changes = Changes::from_bind_map(&raw)?;
                let basis = match &p.basis {
                    Some(b) => Some(b.parse::<i64>().map_err(|_| invalid_params("basis is not a rev"))?),
                    None => None,
                };
                if !changes.is_empty() {
                    self.execute(Actor::User, Command::Update { id: id.clone(), changes, basis, overwrite: p.overwrite.clone().unwrap_or_default() }).await?;
                }
                self.write_secrets(pending).await?;
                let cx = PageContext { draft: None, ..cx };
                Ok(PageSaveResult { page: self.resolve(&p.target, cx, client).await? })
            }
            Target::New { kind, parent } => {
                let (plugin, decl) = self.registry.kind(&kind).ok_or_else(|| not_found("kind"))?;
                self.kind_writable(&kind)?;
                // Secret field values are written once the resource has an id (below).
                let secret_fields = self.secret_fields(&kind, Some(&plugin.version));
                let mut raw = p.changes.clone();
                let secrets: JsonMap = secret_fields.iter().filter_map(|f| raw.remove(f).map(|v| (f.clone(), v))).collect();
                let changes = Changes::from_bind_map(&raw)?;
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
                if !secrets.is_empty() {
                    let mut raw = secrets;
                    let pending = self.take_secret_fields(&id, &secret_fields, &mut raw, None)?;
                    let changes = Changes::from_bind_map(&raw)?;
                    if !changes.is_empty() {
                        self.execute(Actor::User, Command::Update { id: id.clone(), changes, basis: None, overwrite: vec![] }).await?;
                    }
                    self.write_secrets(pending).await?;
                }
                let cx = PageContext { draft: None, ..cx };
                Ok(PageSaveResult { page: self.resolve(&format!("resource:{id}"), cx, client).await? })
            }
            Target::Node { tree, key } => {
                let (plugin, decl) = self.registry.tree(&tree).ok_or_else(|| not_found("tree"))?;
                if decl.source != TreeSource::Provided {
                    return Err(not_found("tree"));
                }
                let page = decl.page.clone().ok_or_else(|| not_found("page"))?;
                let ctx = json!({ "target": p.target, "node": { "tree": tree, "key": key }, "locale": cx.locale, "params": ctx_params(&cx) });
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
            Target::Core(_) | Target::Plugin(_) | Target::Run(_) | Target::Page { .. } | Target::Other => Err(not_found("target")),
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
