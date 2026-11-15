//! `command.execute` and folder grants (week1-protocol §4, §7).

use onedesk_protocol::*;
use serde_json::{json, Value};

use crate::kernel::{node_target, url_encode, Inner};
use crate::manifest::Registry;
use crate::pipeline::{Actor, Command};
use crate::store::{self, KIND_GROUP};
use crate::util::*;

fn bad_effects(detail: String) -> onedesk_protocol::ProtocolError {
    onedesk_protocol::ProtocolError {
        code: ErrorCode::PluginError,
        params: [("reason".to_string(), "badOutput".to_string())].into(),
        detail: Some(detail),
    }
}

pub const DEFAULT_ENV_NAME: &str = "New environment";
pub const DEFAULT_CONFIG_NAME: &str = "New configuration";

/// The resource a node command is about: `nodeKey`, or a `resource:` target.
fn node_resource(c: &CommandContext) -> KResult<String> {
    c.node_key
        .clone()
        .or_else(|| c.target.as_deref().and_then(|t| t.strip_prefix("resource:")).map(String::from))
        .ok_or_else(|| invalid_params("nodeKey"))
}

impl Inner {
    pub async fn command(&self, p: CommandExecuteParams, client: Option<String>) -> KResult<Vec<CommandEffect>> {
        let c = p.context;
        if let Some(r) = self.command3(&p.id, &c).await {
            return r;
        }
        let arg = |k: &str| c.args.as_ref().and_then(|a| a.get(k)).and_then(Value::as_str).map(String::from);
        match p.id.as_str() {
            "node.open" => {
                let target = match (&c.target, &c.tree, &c.node_key) {
                    (Some(t), _, _) => t.clone(),
                    (None, Some(tree), Some(key)) if self.stored_tree(tree).is_ok() => {
                        let r = self.row_in_tree(tree, key)?;
                        if r.kind == KIND_GROUP {
                            return Ok(vec![]);
                        }
                        format!("resource:{}", r.id)
                    }
                    (None, Some(tree), Some(key)) => node_target(tree, key),
                    _ => return Err(invalid_params("node.open needs a target or a node")),
                };
                Ok(vec![CommandEffect::Open { target, params: None, env_id: None }])
            }
            "node.rename" => {
                let (tree, key) = c.tree.clone().zip(c.node_key.clone()).ok_or_else(|| invalid_params("node"))?;
                self.stored_tree(&tree)?;
                self.row_in_tree(&tree, &key)?;
                Ok(vec![CommandEffect::Rename { tree, key }])
            }
            "node.newGroup" => {
                let tree = c.tree.clone().unwrap_or_else(|| store::TREE_RESOURCES.into());
                let parent = match &c.node_key {
                    Some(k) => {
                        let r = self.row_in_tree(&tree, k)?;
                        // Inside the node when it is a group, otherwise next to it.
                        if r.kind == KIND_GROUP { Some(r.id) } else { r.parent_id }
                    }
                    None => None,
                };
                let id = self.create_group(&tree, parent, &arg("name").unwrap_or_default()).await?;
                Ok(vec![CommandEffect::Reveal { tree: tree.clone(), key: id.clone() }, CommandEffect::Rename { tree, key: id }])
            }
            "node.delete" => {
                let key = c.node_key.clone().ok_or_else(|| invalid_params("nodeKey"))?;
                let row = self.live_row(&key)?;
                if self.hidden_tree(&row) || c.tree.as_deref().is_some_and(|t| row.tree.as_deref() != Some(t)) {
                    return Err(not_found("node"));
                }
                let out = self.execute(Actor::User, Command::Delete { id: row.id }).await?;
                Ok(out
                    .rows
                    .iter()
                    .filter(|r| r.kind != KIND_GROUP)
                    .map(|r| CommandEffect::CloseTarget { target: format!("resource:{}", r.id) })
                    .collect())
            }
            "env.newChild" | "config.newChild" => {
                let env = p.id == "env.newChild";
                let (tree, kind, default) = if env {
                    (store::TREE_ENV, store::KIND_ENV, DEFAULT_ENV_NAME)
                } else {
                    (store::TREE_CONFIG, store::KIND_CONFIG, DEFAULT_CONFIG_NAME)
                };
                let parent = match &c.node_key {
                    Some(k) => Some(self.row_in_tree(tree, k)?.id),
                    None => None,
                };
                let sibs = self.read(|conn| store::children(conn, tree, parent.as_deref(), 0, u32::MAX))?;
                let mut name = arg("name").filter(|n| !n.trim().is_empty()).unwrap_or_else(|| default.to_string());
                let base = name.clone();
                let mut i = 2;
                while sibs.iter().any(|s| s.name == name) {
                    name = format!("{base} {i}");
                    i += 1;
                }
                let out = self
                    .execute(
                        Actor::User,
                        Command::Create(crate::pipeline::NewResource {
                            kind: kind.into(),
                            tree: None,
                            parent,
                            name,
                            description: String::new(),
                            tags: vec![],
                            body: JsonMap::new(),
                            plugin_version: None,
                        }),
                    )
                    .await?;
                let id = out.id.ok_or_else(|| internal("no id"))?;
                let tree = tree.to_string();
                Ok(vec![CommandEffect::Reveal { tree: tree.clone(), key: id.clone() }, CommandEffect::Rename { tree, key: id }])
            }
            "node.favorite" | "node.unfavorite" => {
                let id = node_resource(&c)?;
                self.set_favorite(&id, p.id == "node.favorite").await?;
                Ok(vec![])
            }
            "deleted.restore" => {
                let id = c.node_key.clone().ok_or_else(|| invalid_params("nodeKey"))?;
                self.undelete(&id).await?;
                Ok(vec![])
            }
            "deleted.purge" => {
                let id = c.node_key.clone().ok_or_else(|| invalid_params("nodeKey"))?;
                let confirmed = c.args.as_ref().and_then(|a| a.get("confirmed")).and_then(Value::as_bool).unwrap_or(false);
                if !confirmed {
                    // Irreversible: ask first, then the shell runs the command again with `args.confirmed`.
                    return Ok(vec![CommandEffect::Confirm {
                        message: Label::Text("deleted.purge.confirm".into()),
                        command: "deleted.purge".into(),
                        danger: Some(true),
                    }]);
                }
                self.purge(&id).await?;
                Ok(vec![CommandEffect::CloseTarget { target: format!("resource:{id}") }])
            }
            "open.audit" => Ok(vec![CommandEffect::Open { target: "core:audit".into(), params: None, env_id: None }]),
            "open.deleted" => Ok(vec![CommandEffect::Open { target: "core:deleted".into(), params: None, env_id: None }]),
            "plugin.grantFolder" => {
                let plugin = arg("plugin")
                    .or_else(|| c.tree.as_deref().and_then(Registry::split).map(|(p, _)| p.to_string()))
                    .ok_or_else(|| invalid_params("plugin"))?;
                self.registry.plugin(&plugin).ok_or_else(|| not_found("plugin"))?;
                Ok(vec![CommandEffect::PickFolder { plugin }])
            }
            id if id.starts_with("new:") => {
                let kind = &id[4..];
                let (owner, _) = self.registry.kind(kind).ok_or_else(|| not_found("kind"))?;
                if !self.plugin_enabled(&owner.id) {
                    return Err(denied("pluginDisabled"));
                }
                let parent = match &c.node_key {
                    Some(k) => self.read(|conn| store::get(conn, k))?.filter(|r| r.kind == KIND_GROUP).map(|r| r.id),
                    None => None,
                };
                let target = match parent {
                    Some(p) => format!("new:{kind}?parent={}", url_encode(&p)),
                    None => format!("new:{kind}"),
                };
                Ok(vec![CommandEffect::Open { target, params: None, env_id: None }])
            }
            id => {
                let (pid, name) = Registry::split(id).ok_or_else(|| not_found("command"))?;
                let plugin = self.registry.plugin(pid).ok_or_else(|| not_found("command"))?;
                plugin.command(name).ok_or_else(|| not_found("command"))?;
                if !self.plugin_enabled(pid) {
                    return Err(denied("pluginDisabled"));
                }
                let ctx = json!({ "target": c.target, "locale": c.locale });
                let context = serde_json::to_value(&c).map_err(internal)?;
                let out = self.call_plugin(pid, "commands", name, "", json!([ctx, context]), client).await?;
                let out = if out.is_null() { json!([]) } else { out };
                let effects: Vec<CommandEffect> = serde_json::from_value(out).map_err(|e| bad_effects(e.to_string()))?;
                // A plugin's command may not ask for consent dialogs (folder grants, confirmations)
                // on anyone's behalf, and may only open real targets.
                for e in &effects {
                    match e {
                        CommandEffect::Open { target, .. } if !crate::pages::is_target(target) => {
                            return Err(bad_effects(format!("bad open target {target}")))
                        }
                        CommandEffect::PickFolder { .. } | CommandEffect::Confirm { .. } => {
                            return Err(bad_effects("effect not allowed from a plugin command".into()))
                        }
                        _ => {}
                    }
                }
                Ok(effects)
            }
        }
    }

    pub fn grants_of(&self, plugin: &str) -> KResult<PluginGrants> {
        self.registry.plugin(plugin).ok_or_else(|| not_found("plugin"))?;
        Ok(PluginGrants { plugin: plugin.into(), folders: self.folder_grants(plugin)? })
    }

    async fn set_grant(&self, plugin: &str, folder: String, add: bool) -> KResult<()> {
        let out = self.execute(Actor::User, Command::Grant { plugin: plugin.into(), folder, add }).await?;
        if !out.changed {
            return Ok(());
        }
        // Trees the plugin provides may now show different roots.
        if let Some(p) = self.registry.plugin(plugin) {
            for t in p.manifest.contributes.trees.iter().filter(|t| t.source == TreeSource::Provided) {
                self.emit(format!("{}{}", topic::TREE, p.full(&t.id)), None, None);
            }
        }
        Ok(())
    }

    pub async fn grant_folder(&self, p: PluginFolderParams) -> KResult<PluginGrants> {
        let plugin = self.registry.plugin(&p.plugin).ok_or_else(|| not_found("plugin"))?;
        if !plugin.manifest.requires.files {
            return Err(denied("notRequested"));
        }
        let path = std::path::Path::new(&p.path);
        if !path.is_absolute() {
            return Err(invalid("notAbsolute"));
        }
        if !path.is_dir() {
            return Err(invalid("notFolder"));
        }
        let canon = std::fs::canonicalize(path).map_err(internal)?.display().to_string();
        self.set_grant(&p.plugin, canon, true).await?;
        self.grants_of(&p.plugin)
    }

    pub async fn revoke_folder(&self, p: PluginFolderParams) -> KResult<PluginGrants> {
        self.registry.plugin(&p.plugin).ok_or_else(|| not_found("plugin"))?;
        let canon = std::fs::canonicalize(&p.path).map(|c| c.display().to_string()).unwrap_or_else(|_| p.path.clone());
        self.set_grant(&p.plugin, canon.clone(), false).await?;
        if canon != p.path {
            self.set_grant(&p.plugin, p.path.clone(), false).await?;
        }
        self.grants_of(&p.plugin)
    }
}
