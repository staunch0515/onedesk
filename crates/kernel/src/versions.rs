//! Plugin installation (worker side), permission confirmation and versions (kernel-design §7.1,
//! §7.6, D298–D304): inspect, rescan, confirm, the active version, takeover with `migrate`,
//! pinning, undo; secrets methods (D305).

use std::collections::BTreeSet;

use onedesk_protocol::method4 as M;
use onedesk_protocol::*;
use serde_json::{json, Value};

use crate::kernel::{parse, Inner};
use crate::manifest::{atom_id, atoms_fingerprint, load_package_opts, perm_fingerprint, Plugin};
use crate::pipeline::{Actor, Command, UpgradeItem};
use crate::sandbox::{CallInfo, SandboxError};
use crate::store::{self, Row};
use crate::util::*;

/// Plugin state parameter holding the last failed automatic switch (JSON of `SwitchFailure`, D337).
pub const SWITCH_FAILURE: &str = "switchFailure";

pub const METHODS: &[&str] = &[
    M::PLUGIN_INSPECT,
    M::PLUGIN_RESCAN,
    M::PLUGIN_ACTIVATE_VERSION,
    M::PLUGIN_SET_PINNED,
    M::PLUGIN_UNDO_UPGRADE,
    M::PLUGIN_CONFIRM_PERMISSIONS,
    M::SECRETS_LIST,
    M::SECRETS_SET,
    M::SECRETS_DELETE,
];

fn to_value<T: serde::Serialize>(v: T) -> KResult<Value> {
    serde_json::to_value(v).map_err(internal)
}

impl Inner {
    pub async fn handle4(&self, m: &str, params: Value) -> Option<KResult<Value>> {
        Some(match m {
            M::PLUGIN_INSPECT => parse::<PluginFolderRef>(params).and_then(|p| to_value(self.inspect(&p.folder))),
            M::PLUGIN_RESCAN => match parse::<PluginRescanParams>(params) {
                Ok(p) => self.rescan(&p.builtin).await.map(|_| Value::Null),
                Err(e) => Err(e),
            },
            M::PLUGIN_ACTIVATE_VERSION => match parse::<PluginVersionParams>(params) {
                Ok(p) => self.activate_version(&p.plugin, &p.version).await.and_then(to_value),
                Err(e) => Err(e),
            },
            M::PLUGIN_SET_PINNED => match parse::<PluginPinParams>(params) {
                Ok(p) => self.set_pinned(&p.plugin, &p.version, p.pinned).await.map(|_| Value::Null),
                Err(e) => Err(e),
            },
            M::PLUGIN_UNDO_UPGRADE => match parse::<UndoUpgradeParams>(params) {
                Ok(p) => self.undo_upgrade(&p.batch, p.also).await.and_then(to_value),
                Err(e) => Err(e),
            },
            M::PLUGIN_CONFIRM_PERMISSIONS => match parse::<PluginConfirmParams>(params) {
                Ok(p) => self.confirm_permissions(&p.plugin, &p.version, &p.fingerprint).await.map(|_| Value::Null),
                Err(e) => Err(e),
            },
            M::SECRETS_LIST => self.secrets_list().and_then(to_value),
            M::SECRETS_SET => match parse::<SecretSetParams>(params) {
                Ok(p) => self.secret_set(&p.name, &p.value, true).await.map(|_| Value::Null),
                Err(e) => Err(e),
            },
            M::SECRETS_DELETE => match parse::<SecretNameParams>(params) {
                Ok(p) => {
                    let known = self.read(|c| {
                        c.query_row("SELECT EXISTS(SELECT 1 FROM secret_names WHERE name = ?1)", [&p.name], |r| r.get::<_, bool>(0))
                    });
                    match known {
                        Ok(true) => self.secret_delete(&p.name, true).await.map(|_| Value::Null),
                        Ok(false) => Err(not_found("secret")),
                        Err(e) => Err(e),
                    }
                }
                Err(e) => Err(e),
            },
            _ => return None,
        })
    }

    /* ---------------------------------------------------------------- confirmation (D299) */

    /// Permission sets the user confirmed for this plugin (one per confirmed version).
    fn confirmed_sets(&self, plugin: &str) -> Vec<BTreeSet<String>> {
        let Some(row) = self.read(|c| store::plugin_state(c, plugin)).ok().flatten() else { return vec![] };
        crate::params::params_of(&row)
            .into_iter()
            .filter(|(k, _)| k.starts_with("confirmed."))
            .map(|(_, p)| p.value.lines().filter(|l| !l.is_empty()).map(String::from).collect())
            .collect()
    }

    /// Confirmed: asks for nothing, or for a subset of what a confirmed version asked for.
    pub fn version_confirmed(&self, p: &Plugin) -> bool {
        let atoms = p.permissions();
        atoms.is_empty() || self.confirmed_sets(&p.id).iter().any(|set| atoms.is_subset(set))
    }

    /// Picks each plugin's active version: the stored one if usable, else the newest confirmed.
    pub fn refresh_active(&self) {
        for id in self.registry.ids() {
            let versions = self.registry.versions(&id);
            let stored = self.plugin_param(&id, "active");
            let pick = stored
                .and_then(|s| versions.iter().copied().find(|p| p.version == s && self.version_confirmed(p)))
                .or_else(|| versions.iter().rev().copied().find(|p| self.version_confirmed(p)));
            self.registry.set_active(&id, pick.map(|p| p.version.as_str()));
        }
    }

    /// D313: only the built-in packages the main process names are confirmed without asking
    /// (they ship with the application). Every other version is "installed, not confirmed".
    /// The first time a workspace sees a plugin, its newest usable version becomes active.
    pub fn first_sight_blocking(&self) {
        let builtin = self.cfg.builtin.clone();
        for id in self.registry.ids() {
            let mut set = self.builtin_confirmations(&id, &builtin);
            if self.plugin_param(&id, "seen").is_none() {
                set.push(("seen".to_string(), Some("1".to_string())));
                let usable = self.registry.versions(&id).into_iter().rev().find(|p| {
                    p.permissions().is_empty() || builtin.contains(&format!("{}@{}", p.id, p.version)) || self.version_confirmed(p)
                });
                if let Some(v) = usable {
                    set.push(("active".to_string(), Some(v.version.clone())));
                }
            }
            if set.is_empty() {
                continue;
            }
            if let Err(e) = self.pipeline.execute_blocking(Actor::Core, Command::PluginState { plugin: id.clone(), set }) {
                eprintln!("onedesk: could not record plugin {id}: {e:?}");
            }
        }
    }

    /// `confirmed.<version>` entries for built-in versions of `id` not confirmed yet.
    fn builtin_confirmations(&self, id: &str, builtin: &[String]) -> Vec<(String, Option<String>)> {
        self.registry
            .versions(id)
            .into_iter()
            .filter(|p| builtin.contains(&format!("{}@{}", p.id, p.version)) && !self.version_confirmed(p))
            .map(|p| (format!("confirmed.{}", p.version), Some(atoms_fingerprint(&p.permissions()))))
            .collect()
    }

    pub async fn confirm_permissions(&self, plugin: &str, version: &str, fingerprint: &str) -> KResult<()> {
        let p = self.registry.version(plugin, version).ok_or_else(|| not_found("plugin"))?;
        // D312: the user confirms exactly the permissions they were shown.
        if perm_fingerprint(&p.permissions()) != fingerprint {
            return Err(invalid("fingerprintMismatch"));
        }
        let set = vec![
            ("seen".to_string(), Some("1".to_string())),
            (format!("confirmed.{version}"), Some(atoms_fingerprint(&p.permissions()))),
        ];
        self.execute(Actor::User, Command::PluginState { plugin: plugin.into(), set }).await?;
        self.refresh_active();
        self.auto_switch(plugin).await?;
        self.plugins_changed(plugin);
        Ok(())
    }

    fn plugins_changed(&self, plugin: &str) {
        self.emit(topic::PLUGINS, None, None);
        for t in [store::TREE_PLUGINS, store::TREE_RESOURCES] {
            self.emit(format!("{}{t}", topic::TREE), None, None);
        }
        if let Some(p) = self.registry.plugin(plugin) {
            for t in &p.manifest.contributes.trees {
                self.emit(format!("{}{}", topic::TREE, p.full(&t.id)), None, None);
            }
        }
    }

    /* ---------------------------------------------------------------- inspect, rescan (D298) */

    /// Reads and checks a package folder; changes nothing (the main process copies).
    pub fn inspect(&self, folder: &str) -> InstallPreview {
        let mut pv = InstallPreview {
            valid: false,
            problem: None,
            id: String::new(),
            version: String::new(),
            name: Label::Text(String::new()),
            description: Label::Text(String::new()),
            icon: String::new(),
            author: String::new(),
            permissions: vec![],
            installed: vec![],
            added_permissions: vec![],
            provides: PluginProvides::default(),
            fingerprint: String::new(),
        };
        let dir = std::path::Path::new(folder);
        if !dir.is_absolute() || !dir.is_dir() {
            pv.problem = Some(err_p(ErrorCode::Invalid, &[("reason", "notFolder")]));
            return pv;
        }
        let p = match load_package_opts(dir, false) {
            Ok(p) => p,
            Err(r) => {
                pv.problem = Some(ProtocolError {
                    code: ErrorCode::Invalid,
                    params: [("reason".to_string(), r.reason.clone())].into(),
                    detail: Some(r.detail),
                });
                return pv;
            }
        };
        let m = &p.manifest;
        let confirmed: BTreeSet<String> = self.confirmed_sets(&p.id).into_iter().flatten().collect();
        let atoms = p.permissions();
        let mut added: Vec<String> = atoms.difference(&confirmed).map(|a| atom_id(a).to_string()).collect();
        added.dedup();
        pv.installed = self.registry.versions(&p.id).iter().map(|v| v.version.clone()).collect();
        pv.valid = !pv.installed.contains(&p.version);
        if !pv.valid {
            pv.problem = Some(err_p(ErrorCode::Invalid, &[("reason", "alreadyInstalled")]));
        }
        pv.permissions = p.permission_list(|id| !added.iter().any(|a| a == id) && !confirmed.is_empty());
        pv.fingerprint = perm_fingerprint(&atoms);
        pv.added_permissions = added;
        pv.name = p.label(&m.name);
        pv.description = m.description.as_deref().map(|d| p.label(d)).unwrap_or(Label::Text(String::new()));
        pv.icon = m.icon.clone();
        pv.author = m.author.clone();
        pv.provides = PluginProvides {
            kinds: m.contributes.kinds.iter().map(|k| p.label(&k.label)).collect(),
            actions: m.contributes.actions.iter().map(|a| p.label(&a.label)).collect(),
            trees: m.contributes.trees.iter().map(|t| p.label(&t.label)).collect(),
            result_tabs: m.contributes.pages.iter().flat_map(|pg| pg.result_tabs.iter().map(|t| p.label(&t.label))).collect(),
            other: m.contributes.commands.iter().map(|c| p.label(&c.label)).collect(),
        };
        pv.id = p.id;
        pv.version = p.version;
        pv
    }

    /// Reads the plugins folder again: audits what appeared and went, switches versions (D303).
    pub async fn rescan(&self, builtin: &[String]) -> KResult<()> {
        let diff = self.registry.rescan();
        *self.rules.write().unwrap() = self.registry.rules();
        // Review #7: a version that declares other reference fields — the references follow.
        self.execute(Actor::Core, Command::SyncRefDecls).await?;
        // D313: built-in packages the main process just copied are confirmed by it.
        for id in self.registry.ids() {
            let set = self.builtin_confirmations(&id, builtin);
            if !set.is_empty() {
                self.execute(Actor::Core, Command::PluginState { plugin: id.clone(), set }).await?;
            }
        }
        for (id, v) in &diff.added {
            let _ = self
                .execute(Actor::User, Command::Audit { op: "plugin.install".into(), object: format!("{id}@{v}"), summary: json!({}) })
                .await;
        }
        for (id, v) in &diff.removed {
            self.drop_runtime(id).await;
            let _ = self
                .execute(Actor::User, Command::Audit { op: "plugin.remove".into(), object: format!("{id}@{v}"), summary: json!({}) })
                .await;
        }
        self.refresh_active();
        for id in self.registry.ids() {
            if let Err(e) = self.auto_switch(&id).await {
                eprintln!("onedesk: automatic switch of {id} failed: {e:?}");
            }
        }
        for id in diff.added.iter().chain(diff.removed.iter()).map(|(i, _)| i.clone()).collect::<BTreeSet<_>>() {
            self.plugins_changed(&id);
        }
        self.emit(topic::PLUGINS, None, None);
        Ok(())
    }

    /* ---------------------------------------------------------------- versions (§7.6) */

    /// D303: a newer, confirmed version takes over unless the plugin is pinned.
    pub async fn auto_switch(&self, plugin: &str) -> KResult<Option<UpgradeResult>> {
        if self.plugin_param(plugin, "pinned").is_some() {
            return Ok(None);
        }
        let Some(active) = self.registry.plugin(plugin) else { return Ok(None) };
        let newest = self.registry.versions(plugin).into_iter().rev().find(|p| self.version_confirmed(p));
        match newest {
            Some(n) if n.semver() > active.semver() => {
                let res = self.activate_version(plugin, &n.version.clone()).await;
                if let Err(e) = &res {
                    // D337: recorded on the plugin, shown until the next success or the user's choice.
                    let reason = e.params.get("reason").cloned().unwrap_or_else(|| {
                        serde_json::to_value(e.code).ok().and_then(|v| v.as_str().map(String::from)).unwrap_or_default()
                    });
                    let f = SwitchFailure { version: n.version.clone(), reason, at: now_ms() };
                    let set = vec![(SWITCH_FAILURE.to_string(), Some(json!(f).to_string()))];
                    let _ = self.execute(Actor::Core, Command::PluginState { plugin: plugin.into(), set }).await;
                    self.plugins_changed(plugin);
                }
                res.map(Some)
            }
            _ => Ok(None),
        }
    }

    /// D337: the last failed automatic switch, if not cleared since.
    pub fn switch_failure(&self, plugin: &str) -> Option<SwitchFailure> {
        self.plugin_param(plugin, SWITCH_FAILURE).and_then(|v| serde_json::from_str(&v).ok())
    }

    async fn clear_switch_failure(&self, plugin: &str) {
        if self.plugin_param(plugin, SWITCH_FAILURE).is_some() {
            let set = vec![(SWITCH_FAILURE.to_string(), None)];
            let _ = self.execute(Actor::Core, Command::PluginState { plugin: plugin.into(), set }).await;
        }
    }

    pub async fn set_pinned(&self, plugin: &str, version: &str, pinned: bool) -> KResult<()> {
        self.registry.version(plugin, version).ok_or_else(|| not_found("plugin"))?;
        // The user dealt with the plugin's versions (D337).
        self.clear_switch_failure(plugin).await;
        if pinned {
            if self.registry.active_version(plugin).as_deref() != Some(version) {
                self.activate_version(plugin, version).await?;
            }
            let set = vec![("pinned".to_string(), Some(version.to_string()))];
            self.execute(Actor::User, Command::PluginState { plugin: plugin.into(), set }).await?;
        } else {
            self.execute(Actor::User, Command::PluginState { plugin: plugin.into(), set: vec![("pinned".into(), None)] }).await?;
            self.auto_switch(plugin).await?;
        }
        self.plugins_changed(plugin);
        Ok(())
    }

    /// Computes the takeover of `rows` by `to` outside any transaction (D301); any failure stops all.
    pub(crate) async fn migrate_rows(&self, to: &'static Plugin, rows: &[Row]) -> KResult<Vec<UpgradeItem>> {
        let mut items = Vec::new();
        for r in rows {
            let from = r.plugin_version.clone().unwrap_or_default();
            let short = r.kind.split_once(':').map(|(_, k)| k).unwrap_or_default();
            let ctx = json!({ "resource": self.resource(r)?, "fromVersion": from });
            let info = CallInfo { pure: true, ..Default::default() };
            let out = self
                .call_version(to, "kinds", short, "migrate", json!([ctx, r.body, from]), info, None, None)
                .await
                .map_err(|e| {
                    let mut pe = match e {
                        SandboxError::Host(pe) => pe,
                        other => other.to_protocol(),
                    };
                    pe.params.insert("reason".into(), "migrateFailed".into());
                    pe.params.insert("resource".into(), r.id.clone());
                    pe.code = ErrorCode::PluginError;
                    pe
                })?;
            let body = match out {
                Value::Null => r.body.clone(),
                Value::Object(o) => o.into_iter().collect(),
                _ => {
                    return Err(err_p(ErrorCode::PluginError, &[("reason", "migrateFailed"), ("resource", &r.id)]));
                }
            };
            // D311/D318: a takeover may not touch what only the user grants. Text fields that may
            // hold secret references may change, but not the set of names in them.
            let new_kind = to.kind(short);
            let old_kind = self.registry.kind_at(&r.kind, r.plugin_version.as_deref()).map(|(_, k)| k);
            let mut keys = new_kind.map(|k| k.protected_fields()).unwrap_or_default();
            if let Some(old) = old_kind {
                keys.extend(old.protected_fields());
            }
            let refs_only = |k: &str| [new_kind, old_kind].iter().flatten().any(|d| d.fields.get(k).is_some_and(|f| f.secrets));
            let names = |b: &JsonMap, k: &str| b.get(k).and_then(Value::as_str).map(crate::secrets::references).unwrap_or_default();
            let changed = |k: &String| {
                if refs_only(k) {
                    let (a, b): (BTreeSet<String>, BTreeSet<String>) = (names(&r.body, k).into_iter().collect(), names(&body, k).into_iter().collect());
                    a != b
                } else {
                    r.body.get(k.as_str()) != body.get(k.as_str())
                }
            };
            if let Some(k) = keys.iter().find(|k| changed(k)) {
                return Err(err_p(ErrorCode::Denied, &[("reason", "grantField"), ("field", k), ("resource", &r.id)]));
            }
            items.push(UpgradeItem { id: r.id.clone(), rev: r.rev, body });
        }
        Ok(items)
    }

    /// Makes `version` the one used for new resources, and lets it take over the resources of
    /// older versions it `upgradesFrom` (one batch, all or nothing). Others stay where they are.
    pub async fn activate_version(&self, plugin: &str, version: &str) -> KResult<UpgradeResult> {
        let to = self.registry.version(plugin, version).ok_or_else(|| not_found("plugin"))?;
        if !self.version_confirmed(to) {
            return Err(denied("notConfirmed"));
        }
        let mut take = Vec::new();
        let mut kept = 0u32;
        for k in to.manifest.contributes.kinds.iter().map(|k| to.full(&k.id)).collect::<BTreeSet<_>>() {
            for r in self.read(|c| store::of_kind(c, &k))? {
                match r.plugin_version.as_deref() {
                    Some(v) if v == version => {}
                    Some(v) if to.upgrades_from(v) => take.push(r),
                    _ => kept += 1,
                }
            }
        }
        // Kinds the new version no longer has stay on their versions too.
        let prefix = format!("{plugin}:");
        let all_kinds: i64 = self.read(|c| {
            c.query_row(
                "SELECT count(*) FROM resources WHERE substr(kind, 1, length(?1)) = ?1 AND deleted_at IS NULL AND plugin_version IS NOT ?2",
                rusqlite::params![prefix, version],
                |r| r.get(0),
            )
        })?;
        kept = kept.max((all_kinds as u32).saturating_sub(take.len() as u32));
        let items = match self.migrate_rows(to, &take).await {
            Ok(i) => i,
            Err(e) => {
                let _ = self
                    .pipeline
                    .execute(Actor::User, Command::Refused { op: "plugin.upgrade".into(), object: plugin.into(), error: e.clone() })
                    .await;
                return Err(e);
            }
        };
        let upgraded = items.len() as u32;
        let prev_active = self.registry.active_version(plugin);
        let out = self
            .execute(Actor::User, Command::Upgrade { plugin: plugin.into(), to: version.into(), items, set_active: true, prev_active: prev_active.clone() })
            .await?;
        // D314: going back to an older version by hand pins it (no automatic upgrade on the next scan).
        let older = prev_active
            .and_then(|v| semver::Version::parse(&v).ok())
            .is_some_and(|v| to.semver() < v);
        if older {
            let set = vec![("pinned".to_string(), Some(version.to_string()))];
            self.execute(Actor::User, Command::PluginState { plugin: plugin.into(), set }).await?;
        }
        self.registry.set_active(plugin, Some(version));
        self.clear_switch_failure(plugin).await;
        self.plugins_changed(plugin);
        Ok(UpgradeResult { batch: out.id, upgraded, kept })
    }

    pub async fn undo_upgrade(&self, batch: &str, also: Vec<String>) -> KResult<UndoUpgradeResult> {
        let out = self.execute(Actor::User, Command::UndoUpgrade { batch: batch.into(), also }).await?;
        let modified: Vec<NamedRef> = out.id.as_deref().and_then(|s| serde_json::from_str(s).ok()).unwrap_or_default();
        self.refresh_active();
        let plugin: Option<String> =
            self.read(|c| c.query_row("SELECT plugin FROM upgrade_batches WHERE id = ?1", [batch], |r| r.get(0))).ok();
        if let Some(p) = plugin {
            self.plugins_changed(&p);
        }
        Ok(UndoUpgradeResult { restored: out.rows.len() as u32, modified })
    }

    /// §7.6 “其他情形”: rows coming back (undelete) bound to a version that is gone are taken over by
    /// the active version when it can, else refused.
    pub async fn rebind_missing(&self, rows: &[Row]) -> KResult<()> {
        let mut by_plugin: std::collections::BTreeMap<String, Vec<Row>> = Default::default();
        for r in rows {
            let (Some(v), Some((pid, _))) = (r.plugin_version.as_deref(), crate::manifest::Registry::split(&r.kind)) else { continue };
            if self.registry.version(pid, v).is_none() {
                by_plugin.entry(pid.to_string()).or_default().push(r.clone());
            }
        }
        for (pid, rows) in by_plugin {
            let to = self.registry.plugin(&pid).ok_or_else(|| invalid("needsVersion"))?;
            if rows.iter().any(|r| !r.plugin_version.as_deref().is_some_and(|v| to.upgrades_from(v))) {
                return Err(invalid("needsVersion"));
            }
            let items = self.migrate_rows(to, &rows).await?;
            self.execute(Actor::User, Command::Upgrade { plugin: pid.clone(), to: to.version.clone(), items, set_active: false, prev_active: None })
                .await?;
        }
        Ok(())
    }

    /// The version table of the plugin page.
    pub fn version_rows(&self, plugin: &str) -> KResult<Vec<PluginVersion>> {
        let active = self.registry.active_version(plugin);
        let pinned = self.plugin_param(plugin, "pinned");
        self.registry
            .versions(plugin)
            .into_iter()
            .rev()
            .map(|p| {
                let n: i64 = self.read(|c| {
                    c.query_row(
                        "SELECT count(*) FROM resources WHERE substr(kind, 1, length(?1)) = ?1 AND plugin_version = ?2 AND deleted_at IS NULL",
                        rusqlite::params![format!("{plugin}:"), p.version],
                        |r| r.get(0),
                    )
                })?;
                let installed_at = std::fs::metadata(&p.dir)
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as i64)
                    .unwrap_or(0);
                Ok(PluginVersion {
                    version: p.version.clone(),
                    installed_at,
                    active: active.as_deref() == Some(p.version.as_str()),
                    pinned: pinned.as_deref() == Some(p.version.as_str()),
                    notes: String::new(),
                    confirmed: Some(self.version_confirmed(p)),
                    resource_count: Some(n as u64),
                    // D312: each version's own permissions, and the fingerprint to confirm them.
                    permissions: p.permission_list(|_| self.version_confirmed(p)),
                    fingerprint: perm_fingerprint(&p.permissions()),
                })
            })
            .collect()
    }

    pub fn last_upgrade(&self, plugin: &str) -> KResult<Option<UpgradeBatchInfo>> {
        self.read(|c| {
            c.query_row(
                "SELECT b.id, b.from_version, b.to_version, b.at, b.undone_at, (SELECT count(*) FROM upgrade_items i WHERE i.batch = b.id)
                 FROM upgrade_batches b WHERE b.plugin = ?1 ORDER BY b.at DESC, b.rowid DESC LIMIT 1",
                [plugin],
                |r| {
                    Ok(UpgradeBatchInfo {
                        batch: r.get(0)?,
                        from: r.get(1)?,
                        to: r.get(2)?,
                        at: r.get(3)?,
                        undone: r.get::<_, Option<i64>>(4)?.is_some(),
                        count: r.get::<_, i64>(5)? as u64,
                    })
                },
            )
            .map(Some)
            .or_else(|e| if e == rusqlite::Error::QueryReturnedNoRows { Ok(None) } else { Err(e) })
        })
    }
}
