//! OneDesk window shell (week1-protocol §2). No database, no business logic: it owns an
//! `onedesk-host::Host`, hands the interface two things (`protocol_request`, `pick_folder`)
//! and one event (`protocol-event`).

use std::path::PathBuf;
use std::sync::Arc;

use onedesk_host::{default_data_dir, resolve_worker_bin, Host, HostConfig};
use onedesk_protocol::{ErrorCode, ProtocolError};
use serde_json::Value;
use tauri::{Emitter, Manager, RunEvent, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

/// Either the running host or the reason it could not start (shown by the interface).
struct HostState {
    host: Option<Arc<Host>>,
    start_error: Option<String>,
}

fn builtin_plugins_dir() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("ONEDESK_BUILTIN_PLUGINS") {
        return Some(PathBuf::from(p));
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../plugins");
    if cfg!(debug_assertions) && dev.is_dir() {
        return Some(dev);
    }
    // Release bundle: `OneDesk.app/Contents/Resources/plugins`.
    let exe = std::env::current_exe().ok()?;
    let bundled = exe.parent()?.parent()?.join("Resources").join("plugins");
    bundled.is_dir().then_some(bundled)
}

/// The window's label is its `client` id: interface state is kept per client.
#[tauri::command]
async fn protocol_request(
    window: WebviewWindow,
    state: tauri::State<'_, HostState>,
    method: String,
    params: Value,
) -> Result<Value, ProtocolError> {
    match &state.host {
        Some(host) => host.request(Some(window.label()), &method, params).await,
        None => Err(ProtocolError {
            code: ErrorCode::WorkerGone,
            params: Default::default(),
            detail: state.start_error.clone(),
        }),
    }
}

/// The system folder dialog. Choosing a folder is the user's consent (D184).
#[tauri::command]
async fn pick_folder(app: tauri::AppHandle) -> Option<String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_folder(move |p| {
        let _ = tx.send(p);
    });
    rx.await.ok().flatten().and_then(|p| p.into_path().ok()).map(|p| p.to_string_lossy().into_owned())
}

/// The system "save as" dialog (exporting a result). The user chooses where the new file goes; the
/// file itself is written by the kernel. `name` is the suggested file name.
#[tauri::command]
async fn pick_save_file(app: tauri::AppHandle, name: Option<String>) -> Option<String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut dialog = app.dialog().file();
    if let Some(name) = name {
        dialog = dialog.set_file_name(name);
    }
    dialog.save_file(move |p| {
        let _ = tx.send(p);
    });
    rx.await.ok().flatten().and_then(|p| p.into_path().ok()).map(|p| p.to_string_lossy().into_owned())
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![protocol_request, pick_folder, pick_save_file])
        .setup(|app| {
            let cfg = HostConfig { data_dir: default_data_dir(), worker_bin: resolve_worker_bin(), builtin_plugins: builtin_plugins_dir() };
            let state = match tauri::async_runtime::block_on(Host::start(cfg)) {
                Ok(host) => {
                    let handle = app.handle().clone();
                    let mut events = host.events();
                    tauri::async_runtime::spawn(async move {
                        loop {
                            match events.recv().await {
                                Ok(ev) => {
                                    let _ = match &ev.client {
                                        Some(label) => handle.emit_to(label.as_str(), "protocol-event", &ev),
                                        None => handle.emit("protocol-event", &ev),
                                    };
                                }
                                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                            }
                        }
                    });
                    HostState { host: Some(host), start_error: None }
                }
                Err(e) => {
                    eprintln!("onedesk: cannot start the workspace worker: {e}");
                    HostState { host: None, start_error: Some(e.to_string()) }
                }
            };
            app.manage(state);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building OneDesk");
    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            if let Some(state) = handle.try_state::<HostState>() {
                if let Some(host) = &state.host {
                    tauri::async_runtime::block_on(host.shutdown());
                }
            }
        }
    });
}
