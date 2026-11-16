//! `host.events` (round 6 §5, D335–D336): a plugin subscribes in its manifest
//! (`contributes.events`) and registers handlers with `host.events.on(name, handler)`.
//!
//! - `resource.changed` `{ id, kind, change }` — only resources of the plugin's own kinds;
//!   `change` is `created`, `updated`, `deleted`, `restored` or `purged`.
//! - `run.ended` `{ run, resource?, action, status }` — only runs of the plugin's own actions
//!   (`action` is the short action id).
//!
//! Delivered after the write committed, asynchronously, in order, per plugin; a handler runs as
//! the plugin, at most 5 s; a failure is logged and audited (`events.failed`) and never touches
//! the write that raised it. Writes made by a handler raise no `resource.changed` for the same
//! plugin. A disabled plugin, or one whose active version is not confirmed, gets nothing. After
//! each handler the kernel publishes `plugin:<id>` so open pages of the plugin are resolved again.

use std::sync::Weak;
use std::time::Duration;

use onedesk_protocol::*;
use serde_json::{json, Value};
use tokio::sync::mpsc;

use crate::kernel::Inner;
use crate::pipeline::Command;
use crate::sandbox::{CallInfo, SandboxError};

pub const RESOURCE_CHANGED: &str = "resource.changed";
pub const RUN_ENDED: &str = "run.ended";
pub const EVENT_TIMEOUT: Duration = Duration::from_secs(5);

pub struct Delivery {
    pub name: String,
    pub payload: Value,
}

impl Inner {
    /// Queues an event for a plugin if it subscribed and may receive it now.
    pub fn deliver(&self, plugin: &str, name: &str, payload: Value) {
        let Some(p) = self.registry.plugin(plugin) else { return };
        if !p.manifest.contributes.events.iter().any(|e| e == name) || !self.plugin_enabled(plugin) || !self.version_confirmed(p) {
            return;
        }
        let Ok(rt) = tokio::runtime::Handle::try_current() else { return };
        let mut queues = self.event_queues.lock().unwrap();
        let tx = queues.entry(plugin.to_string()).or_insert_with(|| {
            let (tx, rx) = mpsc::unbounded_channel();
            rt.spawn(drain(self.me.clone(), plugin.to_string(), rx));
            tx
        });
        let _ = tx.send(Delivery { name: name.into(), payload });
    }

    async fn handle_event(&self, plugin: &str, d: Delivery) {
        let ctx = json!({ "event": d.name });
        let info = CallInfo { event: true, ..Default::default() };
        let res = self
            .call_plugin_with(plugin, "events", &d.name, "", json!([ctx, d.payload]), info, None, Some(EVENT_TIMEOUT))
            .await;
        match res {
            Ok(_) => {}
            // Disabled or unconfirmed meanwhile: it simply does not receive it.
            Err(SandboxError::Host(e))
                if matches!(e.params.get("reason").map(String::as_str), Some("pluginDisabled" | "unconfirmedVersion" | "notLoaded")) => {}
            Err(e) => {
                eprintln!("onedesk: event handler {plugin} / {} failed: {e}", d.name);
                let mut error = e.to_protocol();
                error.params.insert("event".into(), d.name.clone());
                let actor = self.registry.plugin(plugin).map(|p| p.actor()).unwrap_or(crate::pipeline::Actor::Core);
                let _ = self.pipeline.execute(actor, Command::Refused { op: "events.failed".into(), object: plugin.into(), error }).await;
                self.emit(topic2::AUDIT, None, None);
            }
        }
        // The handler may have changed its storage: open pages of the plugin resolve again.
        self.emit(format!("{}{plugin}", topic6::PLUGIN), None, None);
    }
}

async fn drain(me: Weak<Inner>, plugin: String, mut rx: mpsc::UnboundedReceiver<Delivery>) {
    while let Some(d) = rx.recv().await {
        let Some(k) = me.upgrade() else { return };
        k.handle_event(&plugin, d).await;
    }
}
