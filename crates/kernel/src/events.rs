//! `host.events` (round 6 §5, D335–D336): a plugin subscribes in its manifest
//! (`contributes.events`) and registers handlers with `host.events.on(name, handler)`.
//!
//! - `resource.changed` `{ id, kind, change }` — only resources of the plugin's own kinds;
//!   `change` is `created`, `updated`, `deleted`, `restored` or `purged`.
//! - `run.ended` `{ run, resource?, action, status }` — only runs of the plugin's own actions
//!   (`action` is the short action id).
//!
//! Delivered after the write committed, asynchronously, in order, per plugin (at most 1000
//! waiting: older ones are dropped and counted in the next event's `dropped`); a handler runs as
//! the plugin, at most 5 s; a failure is logged and audited (`events.failed`, one row per drained
//! batch) and never touches the write that raised it. Writes made by a handler raise no
//! `resource.changed` for the same plugin. A disabled plugin, or one whose active version is not
//! confirmed, gets nothing. Each time its queue is drained the kernel publishes `plugin:<id>` so
//! open pages of the plugin are resolved again.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use onedesk_protocol::*;
use serde_json::{json, Value};
use tokio::sync::Notify;

use crate::kernel::Inner;
use crate::pipeline::Command;
use crate::sandbox::{CallInfo, SandboxError};

pub const RESOURCE_CHANGED: &str = "resource.changed";
pub const RUN_ENDED: &str = "run.ended";
pub const EVENT_TIMEOUT: Duration = Duration::from_secs(5);
/// Round 16 (X13): the manifest `activation` event sent once when the workspace is open.
pub const WORKSPACE_OPENED: &str = "workspace.opened";
/// Its handler may index a folder: longer than an ordinary event.
pub const OPEN_TIMEOUT: Duration = Duration::from_secs(60);

pub struct Delivery {
    pub name: String,
    pub payload: Value,
}

/// Review #4: at most this many waiting events per plugin; the oldest are dropped.
pub const MAX_QUEUE: usize = 1000;

/// One plugin's waiting events.
#[derive(Default)]
pub struct Queue {
    state: Mutex<QueueState>,
    notify: Notify,
    closed: std::sync::atomic::AtomicBool,
}

impl Queue {
    /// The kernel is shutting down: the delivery task ends.
    pub fn close(&self) {
        self.closed.store(true, std::sync::atomic::Ordering::SeqCst);
        self.notify.notify_one();
    }
}

#[derive(Default)]
struct QueueState {
    items: VecDeque<Delivery>,
    /// Dropped since the last delivered event (told to the next one as `dropped`).
    dropped: u64,
    /// Counts drained batches: failures within one batch share one audit row.
    batch: u64,
}

impl Inner {
    /// Queues an event for a plugin if it subscribed and may receive it now.
    pub fn deliver(&self, plugin: &str, name: &str, payload: Value) {
        let Some(p) = self.registry.plugin(plugin) else { return };
        let wanted = p.manifest.contributes.events.iter().chain(&p.manifest.activation).any(|e| e == name);
        if !wanted || !self.plugin_enabled(plugin) || !self.version_confirmed(p) {
            return;
        }
        let Ok(rt) = tokio::runtime::Handle::try_current() else { return };
        let q = {
            let mut queues = self.event_queues.lock().unwrap();
            queues
                .entry(plugin.to_string())
                .or_insert_with(|| {
                    let q = Arc::new(Queue::default());
                    rt.spawn(drain(self.me.clone(), plugin.to_string(), q.clone()));
                    q
                })
                .clone()
        };
        {
            let mut st = q.state.lock().unwrap();
            st.items.push_back(Delivery { name: name.into(), payload });
            while st.items.len() > MAX_QUEUE {
                st.items.pop_front();
                st.dropped += 1;
            }
        }
        q.notify.notify_one();
    }

    /// Round 16 (X13): `workspace.opened` to every enabled, confirmed plugin whose active version
    /// declares it in `activation` (each activates for it); in plugin id order.
    pub fn workspace_opened(&self) {
        let mut ids = self.registry.ids();
        ids.sort();
        for id in ids {
            let declares = self.registry.plugin(&id).is_some_and(|p| p.manifest.activation.iter().any(|a| a == WORKSPACE_OPENED));
            if declares {
                self.deliver(&id, WORKSPACE_OPENED, json!({}));
            }
        }
    }

    async fn handle_event(&self, plugin: &str, d: Delivery, batch: u64) {
        let ctx = json!({ "event": d.name });
        let info = CallInfo { event: true, ..Default::default() };
        let timeout = if d.name == WORKSPACE_OPENED { OPEN_TIMEOUT } else { EVENT_TIMEOUT };
        let res = self
            .call_plugin_with(plugin, "events", &d.name, "", json!([ctx, d.payload]), info, None, Some(timeout))
            .await;
        match res {
            Ok(_) => {}
            // Disabled or unconfirmed meanwhile: it simply does not receive it.
            Err(SandboxError::Host(e))
                if matches!(e.params.get("reason").map(String::as_str), Some("pluginDisabled" | "unconfirmedVersion" | "notLoaded")) => {}
            Err(e) => {
                eprintln!("onedesk: event handler {plugin} / {} failed: {e}", d.name);
                let error = e.to_protocol();
                let actor = self.registry.plugin(plugin).map(|p| p.actor()).unwrap_or(crate::pipeline::Actor::Core);
                // Review #4: one row per drained batch, the rest counted.
                let summary = json!({ "event": d.name, "code": error.code, "reason": error.params.get("reason") });
                let cmd = Command::CountedAudit {
                    run: Some(format!("events:{plugin}:{batch}")),
                    op: "events.failed".into(),
                    object: plugin.into(),
                    summary,
                    failed: true,
                    error: Some(error),
                };
                let _ = self.pipeline.execute(actor, cmd).await;
                self.emit(topic2::AUDIT, None, None);
            }
        }
    }
}

async fn drain(me: Weak<Inner>, plugin: String, q: Arc<Queue>) {
    loop {
        let wait = q.notify.notified();
        let next = {
            let mut st = q.state.lock().unwrap();
            st.items.pop_front().map(|mut d| {
                if st.dropped > 0 {
                    if let Some(o) = d.payload.as_object_mut() {
                        o.insert("dropped".into(), json!(st.dropped));
                    }
                    st.dropped = 0;
                }
                (d, st.batch)
            })
        };
        match next {
            Some((d, batch)) => {
                let Some(k) = me.upgrade() else { return };
                k.handle_event(&plugin, d, batch).await;
                let empty = {
                    let mut st = q.state.lock().unwrap();
                    let empty = st.items.is_empty();
                    if empty {
                        st.batch += 1;
                    }
                    empty
                };
                // Review #4: once per drained queue, not per event.
                if empty {
                    k.emit(format!("{}{plugin}", topic6::PLUGIN), None, None);
                }
            }
            None => {
                if me.strong_count() == 0 || q.closed.load(std::sync::atomic::Ordering::SeqCst) {
                    return;
                }
                wait.await;
            }
        }
    }
}
