//! OneDesk Rust backend. Commands are registered in `run()`.
//! The command contract shared with the front end lives in `src/platform/contract.ts`.

pub mod commands;
pub mod db;
pub mod plugins;
pub mod secrets;
pub mod time;
pub mod transfer;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let state = commands::AppState::init_default();
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            commands::app_status,
            commands::db_select,
            commands::db_execute,
            commands::db_batch,
            commands::secrets_list,
            commands::secrets_get,
            commands::secrets_set,
            commands::secrets_delete,
            commands::plugins_scan,
            commands::export_write,
            commands::import_read,
        ])
        .run(tauri::generate_context!())
        .expect("error while running OneDesk");
}
