//! Round 7: dependencies between plugins and what one exports to the plugins depending on it
//! (kernel-design §7.3, D343, D344, D347). Whether a dependency is met is computed from the
//! current state every time it is asked — a dependent comes back by itself once it is met again.

use std::collections::HashMap;

use onedesk_protocol::*;
use serde_json::Value;

use crate::kernel::Inner;
use crate::manifest::{foreign_kinds, is_foreign, ExportKind, KindDecl, Plugin, Registry};
use crate::pipeline::{Actor, Command};
use crate::util::*;

/// Why a plugin is not working.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Off {
    /// Turned off by the user, or no usable (installed, confirmed) active version.
    Switched,
    /// `depends` not met: the first unmet entry (D343). A dependency cycle is unmet too.
    Unmet { plugin: String, range: String },
    /// Reached again while being judged: part of a dependency cycle.
    Cycle,
}

/// A change looked at before it is made (D344): one plugin with another active version
/// (`Some(None)` = none left) and/or switched on or off.
#[derive(Debug, Clone, Default)]
pub struct WhatIf {
    pub plugin: String,
    pub active: Option<Option<&'static Plugin>>,
    pub on: Option<bool>,
}

type Memo = HashMap<String, Result<(), Off>>;

impl Inner {
    /// The user's switch (D290): on unless its state says `enabled = false`.
    fn switched_on(&self, plugin: &str) -> bool {
        self.plugin_param(plugin, "enabled").is_none_or(|v| v != "false")
    }

    /// The user's switch and a usable active version — without looking at dependencies.
    pub fn plugin_switched_on(&self, plugin: &str) -> bool {
        self.switched_on(plugin) && self.registry.active_version(plugin).is_some()
    }

    fn active_of(&self, plugin: &str, w: Option<&WhatIf>) -> Option<&'static Plugin> {
        if let Some(a) = w.filter(|w| w.plugin == plugin).and_then(|w| w.active) {
            return a;
        }
        self.registry.active_version(plugin).and_then(|v| self.registry.version(plugin, &v))
    }

    fn judge(&self, plugin: &str, w: Option<&WhatIf>, memo: &mut Memo, visiting: &mut Vec<String>) -> Result<(), Off> {
        if let Some(r) = memo.get(plugin) {
            return r.clone();
        }
        if visiting.iter().any(|v| v == plugin) {
            return Err(Off::Cycle);
        }
        let on = w.filter(|w| w.plugin == plugin).and_then(|w| w.on).unwrap_or_else(|| self.switched_on(plugin));
        let res = match self.active_of(plugin, w) {
            Some(p) if on => {
                visiting.push(plugin.to_string());
                let mut res = Ok(());
                for d in &p.manifest.deps {
                    let met = self.judge(&d.id, w, memo, visiting).is_ok()
                        && self.active_of(&d.id, w).is_some_and(|a| d.req.matches(&a.semver()));
                    if !met {
                        res = Err(Off::Unmet { plugin: d.id.clone(), range: d.range.clone() });
                        break;
                    }
                }
                visiting.pop();
                res
            }
            _ => Err(Off::Switched),
        };
        memo.insert(plugin.to_string(), res.clone());
        res
    }

    /// Whether the plugin works now: switched on, a usable active version, `depends` met.
    pub fn plugin_state(&self, plugin: &str) -> Result<(), Off> {
        self.judge(plugin, None, &mut Memo::new(), &mut vec![])
    }

    /// The unmet dependency, when that is why the plugin is off (`dependsUnmet`).
    pub fn unmet_dependency(&self, plugin: &str) -> Option<(String, String)> {
        match self.plugin_state(plugin) {
            Err(Off::Unmet { plugin, range }) => Some((plugin, range)),
            _ => None,
        }
    }

    /// Review #8: a version other than the active one (resources bound to it run on it) is
    /// judged by its own `depends`.
    pub fn version_deps_met(&self, p: &Plugin) -> bool {
        let mut memo = Memo::new();
        p.manifest.deps.iter().all(|d| {
            self.judge(&d.id, None, &mut memo, &mut vec![p.id.clone()]).is_ok()
                && self.active_of(&d.id, None).is_some_and(|a| d.req.matches(&a.semver()))
        })
    }

    /// Review #15: the plugin itself would not work after the change (its `depends` unmet).
    pub fn unmet_after(&self, w: &WhatIf) -> Option<(String, String)> {
        match self.judge(&w.plugin, Some(w), &mut Memo::new(), &mut vec![]) {
            Err(Off::Unmet { plugin, range }) => Some((plugin, range)),
            _ => None,
        }
    }

    /// Enabled plugins (other than the one changed) that the change would turn off (D344).
    pub fn broken_by(&self, w: &WhatIf) -> Vec<String> {
        let (mut now, mut then) = (Memo::new(), Memo::new());
        self.registry
            .ids()
            .into_iter()
            .filter(|id| *id != w.plugin)
            .filter(|id| self.judge(id, None, &mut now, &mut vec![]).is_ok() && self.judge(id, Some(w), &mut then, &mut vec![]).is_err())
            .collect()
    }

    /// Refuses (and audits) a change that would turn off enabled dependents:
    /// `conflict`, `reason: dependents`, `plugins` = their ids, comma separated.
    pub async fn refuse_if_dependents(&self, op: &str, object: &str, w: &WhatIf) -> KResult<()> {
        let broken = self.broken_by(w);
        if broken.is_empty() {
            return Ok(());
        }
        let e = err_p(ErrorCode::Conflict, &[("reason", "dependents"), ("plugins", &broken.join(","))]);
        let _ = self.pipeline.execute(Actor::User, Command::Refused { op: op.into(), object: object.into(), error: e.clone() }).await;
        Err(e)
    }

    /// `plugin.checkRemove`: whether removing this version would turn off enabled dependents.
    pub async fn check_remove(&self, plugin: &str, version: &str) -> KResult<()> {
        self.registry.version(plugin, version).ok_or_else(|| not_found("plugin"))?;
        if self.registry.active_version(plugin).as_deref() != Some(version) {
            return Ok(());
        }
        // What `refresh_active` would pick next: the newest other confirmed version.
        let next = self.registry.versions(plugin).into_iter().rev().find(|p| p.version != version && self.version_confirmed(p));
        let w = WhatIf { plugin: plugin.into(), active: Some(next), on: None };
        self.refuse_if_dependents("plugin.remove", &format!("{plugin}@{version}"), &w).await
    }

    /// `PluginDetail.depends` of a plugin version.
    pub fn dependency_rows(&self, p: &Plugin) -> Vec<PluginDependency> {
        let mut memo = Memo::new();
        p.manifest
            .deps
            .iter()
            .map(|d| {
                let active = self.active_of(&d.id, None);
                PluginDependency {
                    id: d.id.clone(),
                    range: d.range.clone(),
                    satisfied: self.judge(&d.id, None, &mut memo, &mut vec![p.id.clone()]).is_ok()
                        && active.is_some_and(|a| d.req.matches(&a.semver())),
                    active_version: active.map(|a| a.version.clone()),
                }
            })
            .collect()
    }

    /// `PluginDetail.dependents`: enabled plugins whose active version depends on `plugin`.
    pub fn dependents_of(&self, plugin: &str) -> Vec<String> {
        self.registry
            .plugins()
            .into_iter()
            .filter(|p| p.id != plugin && p.manifest.deps.iter().any(|d| d.id == plugin) && self.plugin_enabled(&p.id))
            .map(|p| p.id.clone())
            .collect()
    }

    /// Every plugin with dependencies that is off now stops: runs, runtime, its install request.
    /// Plugins that came back need nothing (their code activates on first use); trees and the
    /// plugin list are told either way.
    pub async fn settle_dependents(&self) {
        let with_deps: Vec<&'static Plugin> = self.registry.plugins().into_iter().filter(|p| !p.manifest.deps.is_empty()).collect();
        for p in &with_deps {
            if !self.plugin_enabled(&p.id) {
                self.stop_runs_of(&p.id);
                self.drop_runtime(&p.id).await;
                self.drop_install_request(&p.id, crate::install::GONE_DISABLED);
            }
            for t in self.plugin_trees(p) {
                self.emit(format!("{}{t}", topic::TREE), None, None);
            }
        }
        if !with_deps.is_empty() {
            self.emit(topic::PLUGINS, None, None);
        }
    }

    /* ---------------------------------------------------------------- exports (D342, D347) */

    /// What the owner's active version exports of one of its kinds (by full name).
    fn export_of(&self, kind: &str) -> Option<ExportKind> {
        let (owner, short) = Registry::split(kind)?;
        let p = self.active_of(owner, None)?;
        p.manifest.exported.iter().find(|e| e.id == short).cloned()
    }

    /// Whether `dependent` may use another plugin's `kind` through its exports now: it names the
    /// kind in its actions, depends on the owner, is enabled (so the dependency is met), and the
    /// owner's active version exports the kind with `actions` (`read = false`) or `read`.
    pub fn export_allows(&self, dependent: &Plugin, kind: &str, read: bool) -> bool {
        let Some((owner, _)) = Registry::split(kind) else { return false };
        owner != dependent.id
            && dependent.manifest.deps.iter().any(|d| d.id == owner)
            && foreign_kinds(&dependent.manifest).contains(kind)
            && self.export_of(kind).is_some_and(|e| if read { e.read } else { e.actions })
            && self.plugin_enabled(&dependent.id)
            && self.version_deps_met(dependent)
    }

    /// Actions of enabled dependents on a resource page of `kind` (after the kind's own, §7.3).
    pub fn dependent_actions(&self, kind: &str) -> Vec<ActionDecl> {
        let Some((owner, _)) = Registry::split(kind) else { return vec![] };
        let mut out = Vec::new();
        for p in self.registry.plugins() {
            if p.id == owner || !p.manifest.deps.iter().any(|d| d.id == owner) || !self.export_allows(p, kind, false) {
                continue;
            }
            for a in p.manifest.contributes.actions.iter().filter(|a| a.kinds.iter().flatten().any(|k| k == kind)) {
                out.push(ActionDecl {
                    id: p.full(&a.id),
                    label: p.label(&a.label),
                    icon: a.icon.clone(),
                    primary: None,
                    danger: None,
                    shortcut: None,
                    role: ActionRole::Run,
                    disabled: None,
                    action: Some(p.full(&a.id)),
                    confirm: a.confirm.as_deref().map(|k| p.label(k)),
                });
            }
        }
        out
    }

    /// D357: on a borrowed page, the kind's own plugin's actions whose `kinds` name the kind.
    pub fn own_kind_actions(&self, p: &Plugin, kind: &str) -> Vec<ActionDecl> {
        p.manifest
            .contributes
            .actions
            .iter()
            .filter(|a| a.kinds.iter().flatten().any(|k| p.kind_ref(k) == kind))
            .map(|a| ActionDecl {
                id: p.full(&a.id),
                label: p.label(&a.label),
                icon: a.icon.clone(),
                primary: None,
                danger: None,
                shortcut: None,
                role: ActionRole::Run,
                disabled: None,
                action: Some(p.full(&a.id)),
                confirm: a.confirm.as_deref().map(|k| p.label(k)),
            })
            .collect()
    }

    /// Kinds of other plugins a dependent's actions name that take no actions now (shown on its
    /// page; review #13: judged by `actions`, which is what makes them appear).
    pub fn unexported_kinds(&self, p: &Plugin) -> Vec<String> {
        foreign_kinds(&p.manifest).into_iter().filter(|k| self.export_of(k).is_none_or(|e| !e.actions)).collect()
    }
}

impl Inner {
    /* ---------------------------------------------------------------- trees and pages (round 8) */

    /// Whether the active version of the plugin a full name belongs to exports that tree / page.
    fn exports_ref(&self, full: &str, tree: bool) -> bool {
        let Some((owner, short)) = Registry::split(full) else { return false };
        self.active_of(owner, None)
            .is_some_and(|a| if tree { &a.manifest.exported_trees } else { &a.manifest.exported_pages }.iter().any(|x| x == short))
    }

    /// D356–D357: the other plugins' trees and pages a kind is declared with that they do not
    /// export now (full names). Not empty = the kind cannot be used.
    pub fn kind_unmet(&self, p: &Plugin, k: &KindDecl) -> Vec<String> {
        let mut out = Vec::new();
        for (name, tree) in [(k.tree.as_deref(), true), (k.page.as_deref(), false)] {
            if let Some(n) = name.filter(|n| is_foreign(&p.manifest, n)) {
                if !self.exports_ref(n, tree) {
                    out.push(n.to_string());
                }
            }
        }
        out
    }

    /// `PluginDetail.unmetExports` of a plugin version.
    pub fn unmet_exports(&self, p: &Plugin) -> Vec<String> {
        let mut out: Vec<String> = p.manifest.contributes.kinds.iter().flat_map(|k| self.kind_unmet(p, k)).collect();
        out.sort();
        out.dedup();
        out
    }

    /// A kind (full name, active version) that may be used now: `denied/notExported` (with
    /// `export`) when a tree or page it is declared with is not exported.
    pub fn kind_usable(&self, kind: &str) -> KResult<()> {
        match self.registry.kind(kind).and_then(|(p, k)| self.kind_unmet(p, k).into_iter().next()) {
            Some(x) => Err(err_p(ErrorCode::Denied, &[("reason", "notExported"), ("export", &x)])),
            None => Ok(()),
        }
    }

    /// The plugin whose page draws a kind (round 8: another plugin's, when the kind borrows it):
    /// that plugin's active version and the page's short name. `None`: no page, or the page's
    /// plugin is not there.
    pub fn page_plugin(&self, p: &'static Plugin, page: &str) -> Option<(&'static Plugin, String)> {
        let (owner, short) = p.page_ref(page);
        if owner == p.id {
            return Some((p, short));
        }
        let o = self.active_of(&owner, None)?;
        o.page(&short)?;
        Some((o, short))
    }
}

/// A body with the kind's secret fields taken out (a dependent never sees them).
pub fn without_secrets(mut v: Value, fields: &[String]) -> Value {
    if let Some(body) = v.get_mut("body").and_then(Value::as_object_mut) {
        for f in fields {
            body.remove(f.strip_prefix("body.").unwrap_or(f));
        }
    }
    v
}
