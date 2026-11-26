//! OneDesk window shell (week1-protocol §2). No database, no business logic: it owns an
//! `onedesk-host::Host`, hands the interface two things (`protocol_request`, `pick_folder`)
//! and one event (`protocol-event`).

use std::path::PathBuf;
use std::sync::Arc;

use onedesk_host::workspaces::WindowBounds;
use onedesk_host::{default_data_dir, resolve_worker_bin, Host, HostConfig};
use onedesk_protocol::{ErrorCode, ProtocolError};
use serde_json::Value;
use tauri::{Emitter, Manager, RunEvent, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_dialog::DialogExt;

/// Either the running host or the reason it could not start (shown by the interface).
struct HostState {
    host: Option<Arc<Host>>,
    /// The MCP socket file this process bound (and so may remove when it exits).
    mcp_socket: Option<PathBuf>,
    start_error: Option<String>,
}

fn builtin_plugins_dir() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("ONEDESK_BUILTIN_PLUGINS") {
        return Some(PathBuf::from(p));
    }
    // Debug builds only: the checkout's plugins. Release builds must not embed the builder's path.
    #[cfg(debug_assertions)]
    {
        let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../plugins");
        if dev.is_dir() {
            return Some(dev);
        }
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

/// The system open-file dialog for a plugin package file (D456: `<id>-<version>.odplugin`, a zip). Choosing the
/// file is the user's consent to look inside it; nothing is installed before the confirmation dialog.
#[tauri::command]
async fn pick_package_file(app: tauri::AppHandle) -> Option<String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().add_filter("OneDesk plugin", &["odplugin", "zip"]).pick_file(move |p| {
        let _ = tx.send(p);
    });
    rx.await.ok().flatten().and_then(|p| p.into_path().ok()).map(|p| p.to_string_lossy().into_owned())
}

/// D487 §21: the system open-file dialog for a resource package (`.odpack`). Choosing the file is the user's consent to
/// look inside it; nothing is imported before the confirmation dialog.
#[tauri::command]
async fn pick_resource_package(app: tauri::AppHandle) -> Option<String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().add_filter("OneDesk package", &["odpack"]).pick_file(move |p| {
        let _ = tx.send(p);
    });
    rx.await.ok().flatten().and_then(|p| p.into_path().ok()).map(|p| p.to_string_lossy().into_owned())
}

/// D484 §16: the system "open" dialog for an image (png, jpeg, gif, webp). Choosing the file is the user's consent to
/// store it; the kernel reads it and checks what it is.
#[tauri::command]
async fn pick_image_file(app: tauri::AppHandle) -> Option<String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().add_filter("Image", &["png", "jpg", "jpeg", "gif", "webp"]).pick_file(move |p| {
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

/// Opens an address in the system browser. The protocol is checked again here (D380); the interface only asks.
#[tauri::command]
async fn open_external(url: String) -> Result<(), String> {
    // `open` is waited for, so it runs off the async threads; a failure goes back to the interface (D380).
    tauri::async_runtime::spawn_blocking(move || onedesk_host::external::open_external(&url).map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())?
}

/// "New window" (D403): opens another window bound to a workspace (several windows may share one workspace; a window
/// belongs to one workspace at a time). Its position and size come from that workspace's `workspace.json`.
#[tauri::command]
async fn open_window(app: tauri::AppHandle, state: tauri::State<'_, HostState>, workspace: String) -> Result<(), ProtocolError> {
    static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(1);
    let Some(host) = &state.host else {
        return Err(ProtocolError { code: ErrorCode::WorkerGone, params: Default::default(), detail: state.start_error.clone() });
    };
    let label = format!("win-{}", NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst));
    // Bound before the window loads, so its first `hello` already belongs to that workspace.
    let entry = host.bind_client(&label, &workspace).await?;
    let mut builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("workbench.html".into())).title("OneDesk").min_inner_size(1100.0, 720.0);
    builder = match host.window_bounds(&entry.folder) {
        // A little offset so a second window on the same workspace does not hide the first.
        Some(b) => builder.position(b.x + 24.0, b.y + 24.0).inner_size(b.width, b.height),
        None => builder.inner_size(1440.0, 900.0),
    };
    if let Err(e) = builder.build() {
        host.unbind_client(&label).await;
        return Err(ProtocolError { code: ErrorCode::Internal, params: Default::default(), detail: Some(e.to_string()) });
    }
    Ok(())
}

/// Remembers where a window is, in the `workspace.json` of the workspace it shows.
fn remember_bounds(window: &tauri::Window, host: &Host) {
    let (Ok(pos), Ok(size)) = (window.outer_position(), window.inner_size()) else { return };
    let scale = window.scale_factor().unwrap_or(1.0);
    let (pos, size) = (pos.to_logical::<f64>(scale), size.to_logical::<f64>(scale));
    if size.width < 200.0 || size.height < 200.0 {
        return;
    }
    host.set_window_bounds(&host.client_folder(window.label()), Some(WindowBounds { x: pos.x, y: pos.y, width: size.width, height: size.height }));
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
        .invoke_handler(tauri::generate_handler![protocol_request, pick_folder, pick_package_file,
            pick_resource_package, pick_image_file, pick_save_file, open_external, open_window])
        .on_window_event(|window, event| {
            let Some(state) = window.try_state::<HostState>() else { return };
            let Some(host) = state.host.clone() else { return };
            match event {
                // The position is saved when the window is closed; a crash loses at most the last move.
                WindowEvent::CloseRequested { .. } => remember_bounds(window, &host),
                // Its workspace's worker stops when this was the last window using it.
                WindowEvent::Destroyed => {
                    let label = window.label().to_string();
                    tauri::async_runtime::spawn(async move { host.unbind_client(&label).await });
                }
                _ => {}
            }
        })
        .setup(|app| {
            let cfg = HostConfig { data_dir: default_data_dir(), worker_bin: resolve_worker_bin(), builtin_plugins: builtin_plugins_dir(), secrets: None };
            // Round 19 (D450): listen on the MCP socket BEFORE waiting for the workspace lock. An AI client that arrives
            // while this process waits for a headless worker of another client to let go then queues here instead of
            // starting yet another headless worker that would keep the lock from us. Not being able to listen only
            // costs the socket: `onedesk-mcp` then starts a worker of its own.
            let data_dir = default_data_dir();
            let _ = std::fs::create_dir_all(&data_dir);
            let mcp = match tauri::async_runtime::block_on(async { onedesk_host::mcp_socket::bind(&data_dir) }) {
                Ok(b) => Some(b),
                Err(e) => {
                    eprintln!("onedesk: MCP socket not available: {e}");
                    None
                }
            };
            let state = match tauri::async_runtime::block_on(Host::start(cfg)) {
                Ok(host) => {
                    let handle = app.handle().clone();
                    let mut events = host.events();
                    let events_host = host.clone();
                    tauri::async_runtime::spawn(async move {
                        loop {
                            match events.recv().await {
                                Ok(ev) => {
                                    // Each window sees the events of the workspace it uses (D400).
                                    for label in handle.webview_windows().keys() {
                                        if events_host.visible_to(&ev, label) {
                                            let _ = handle.emit_to(label.as_str(), "protocol-event", &ev.event);
                                        }
                                    }
                                }
                                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                            }
                        }
                    });
                    let mcp_socket = mcp.map(|(listener, path)| {
                        tauri::async_runtime::spawn(onedesk_host::mcp_socket::serve(host.clone(), listener));
                        path
                    });
                    HostState { host: Some(host), mcp_socket, start_error: None }
                }
                Err(e) => {
                    eprintln!("onedesk: cannot start the workspace worker: {e}");
                    if let Some((_, path)) = mcp {
                        let _ = std::fs::remove_file(path);
                    }
                    HostState { host: None, mcp_socket: None, start_error: Some(e.to_string()) }
                }
            };
            // The first window opens where the workspace it shows was last (D403).
            if let (Some(host), Some(window)) = (&state.host, app.get_webview_window("main")) {
                if let Some(b) = host.window_bounds(&host.client_folder("main")) {
                    let _ = window.set_size(tauri::LogicalSize::new(b.width, b.height));
                    let _ = window.set_position(tauri::LogicalPosition::new(b.x, b.y));
                }
            }
            app.manage(state);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building OneDesk");
    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            if let Some(state) = handle.try_state::<HostState>() {
                if let Some(host) = &state.host {
                    if let Some(path) = &state.mcp_socket {
                        let _ = std::fs::remove_file(path);
                    }
                    tauri::async_runtime::block_on(host.shutdown());
                }
            }
        }
    });
}
