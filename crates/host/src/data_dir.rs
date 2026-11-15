//! Where the data lives (D264) and where the worker executable is.

use std::path::{Path, PathBuf};

/// `ONEDESK_DATA_DIR` wins; otherwise `~/Library/Application Support/onedesk/` for release
/// builds and `…/onedesk-dev/` for debug builds. The old first-version `onedesk.db` is never touched.
pub fn default_data_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("ONEDESK_DATA_DIR").filter(|d| !d.is_empty()) {
        return PathBuf::from(dir);
    }
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/tmp"));
    let name = if cfg!(debug_assertions) { "onedesk-dev" } else { "onedesk" };
    home.join("Library").join("Application Support").join(name)
}

/// Week 1 has exactly one workspace.
pub fn workspace_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("workspaces").join("default")
}

/// `ONEDESK_WORKER_BIN`, else `onedesk-worker` next to the running executable.
pub fn resolve_worker_bin() -> PathBuf {
    if let Some(p) = std::env::var_os("ONEDESK_WORKER_BIN").filter(|p| !p.is_empty()) {
        return PathBuf::from(p);
    }
    let exe = std::env::current_exe().unwrap_or_default();
    exe.parent().unwrap_or_else(|| Path::new(".")).join("onedesk-worker")
}
