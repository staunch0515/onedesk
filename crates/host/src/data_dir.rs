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

/// The folder every installation starts with (and where the first-version database is moved to).
pub fn workspace_dir(data_dir: &Path) -> PathBuf {
    workspace_path(data_dir, "default")
}

/// `<data dir>/workspaces/<folder>`.
pub fn workspace_path(data_dir: &Path, folder: &str) -> PathBuf {
    data_dir.join("workspaces").join(folder)
}

/// The reason code shown by the interface when the first-version database could not be moved (D398).
pub const LEGACY_MOVE_FAILED: &str = "legacyMoveFailed";

/// Companion files of an SQLite database in WAL mode.
const SIDE_FILES: [&str; 2] = ["-wal", "-shm"];

fn has_workspace_db(data_dir: &Path) -> bool {
    std::fs::read_dir(data_dir.join("workspaces"))
        .map(|rd| rd.filter_map(|e| e.ok()).any(|e| e.path().join("workspace.db").is_file()))
        .unwrap_or(false)
}

/// D398, main-process half. When the data directory holds the first version's `onedesk.db` and no workspace has a
/// database yet: copy it (with `-wal`/`-shm`) to `workspaces/default/backups/v1-onedesk.db`, then move the original to
/// `workspaces/default/workspace.db`. Nothing is deleted before both steps succeeded; a failure undoes what was done and
/// returns the reason (`legacyMoveFailed`). Returns whether a move happened. With a `workspaces/` that already has a
/// database, `onedesk.db` is not touched.
pub fn move_legacy_db(data_dir: &Path) -> Result<bool, String> {
    let legacy = data_dir.join("onedesk.db");
    if !legacy.is_file() || has_workspace_db(data_dir) {
        return Ok(false);
    }
    let dest = workspace_dir(data_dir);
    let backups = dest.join("backups");
    std::fs::create_dir_all(&backups).map_err(|e| format!("{LEGACY_MOVE_FAILED}: create {}: {e}", backups.display()))?;
    let backup = backups.join("v1-onedesk.db");
    let mut copied: Vec<PathBuf> = Vec::new();
    let undo_copies = |copied: &[PathBuf]| copied.iter().for_each(|c| drop(std::fs::remove_file(c)));
    for suffix in std::iter::once("").chain(SIDE_FILES) {
        let from = with_suffix(&legacy, suffix);
        if !from.is_file() {
            continue;
        }
        let to = with_suffix(&backup, suffix);
        if let Err(e) = std::fs::copy(&from, &to) {
            undo_copies(&copied);
            return Err(format!("{LEGACY_MOVE_FAILED}: copy {}: {e}", from.display()));
        }
        copied.push(to);
    }
    let target = dest.join("workspace.db");
    let mut moved: Vec<(PathBuf, PathBuf)> = Vec::new();
    for suffix in std::iter::once("").chain(SIDE_FILES) {
        let from = with_suffix(&legacy, suffix);
        if !from.is_file() {
            continue;
        }
        let to = with_suffix(&target, suffix);
        if let Err(e) = std::fs::rename(&from, &to) {
            // Put back what already moved; the backup copies are kept (they are harmless).
            for (a, b) in moved.iter().rev() {
                let _ = std::fs::rename(b, a);
            }
            return Err(format!("{LEGACY_MOVE_FAILED}: move {}: {e}", from.display()));
        }
        moved.push((from, to));
    }
    Ok(true)
}

fn with_suffix(p: &Path, suffix: &str) -> PathBuf {
    let mut s = p.as_os_str().to_os_string();
    s.push(suffix);
    PathBuf::from(s)
}

/// `ONEDESK_WORKER_BIN`, else `onedesk-worker` next to the running executable.
pub fn resolve_worker_bin() -> PathBuf {
    if let Some(p) = std::env::var_os("ONEDESK_WORKER_BIN").filter(|p| !p.is_empty()) {
        return PathBuf::from(p);
    }
    let exe = std::env::current_exe().unwrap_or_default();
    exe.parent().unwrap_or_else(|| Path::new(".")).join("onedesk-worker")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn legacy_fixture(dir: &Path) {
        std::fs::write(dir.join("onedesk.db"), b"v1 database").unwrap();
        std::fs::write(dir.join("onedesk.db-wal"), b"v1 wal").unwrap();
    }

    #[test]
    fn moves_the_first_version_database_after_backing_it_up() {
        let tmp = tempfile::tempdir().unwrap();
        legacy_fixture(tmp.path());
        assert_eq!(move_legacy_db(tmp.path()), Ok(true));
        let ws = workspace_dir(tmp.path());
        assert_eq!(std::fs::read(ws.join("workspace.db")).unwrap(), b"v1 database");
        assert_eq!(std::fs::read(ws.join("workspace.db-wal")).unwrap(), b"v1 wal");
        assert_eq!(std::fs::read(ws.join("backups/v1-onedesk.db")).unwrap(), b"v1 database");
        assert_eq!(std::fs::read(ws.join("backups/v1-onedesk.db-wal")).unwrap(), b"v1 wal");
        assert!(!tmp.path().join("onedesk.db").exists());
        assert!(!tmp.path().join("onedesk.db-wal").exists());
        // A second start finds nothing to do.
        assert_eq!(move_legacy_db(tmp.path()), Ok(false));
    }

    #[test]
    fn leaves_onedesk_db_alone_when_a_workspace_already_has_a_database() {
        let tmp = tempfile::tempdir().unwrap();
        legacy_fixture(tmp.path());
        let other = workspace_path(tmp.path(), "other");
        std::fs::create_dir_all(&other).unwrap();
        std::fs::write(other.join("workspace.db"), b"new").unwrap();
        assert_eq!(move_legacy_db(tmp.path()), Ok(false));
        assert_eq!(std::fs::read(tmp.path().join("onedesk.db")).unwrap(), b"v1 database");
        assert!(!workspace_dir(tmp.path()).join("workspace.db").exists());
    }

    #[test]
    fn a_failed_move_deletes_nothing_and_names_the_reason() {
        let tmp = tempfile::tempdir().unwrap();
        legacy_fixture(tmp.path());
        // A directory where the database should land makes the rename fail.
        let ws = workspace_dir(tmp.path());
        std::fs::create_dir_all(ws.join("workspace.db")).unwrap();
        let e = move_legacy_db(tmp.path()).unwrap_err();
        assert!(e.starts_with(LEGACY_MOVE_FAILED), "{e}");
        assert_eq!(std::fs::read(tmp.path().join("onedesk.db")).unwrap(), b"v1 database");
        assert_eq!(std::fs::read(tmp.path().join("onedesk.db-wal")).unwrap(), b"v1 wal");
    }

    #[test]
    fn a_failed_backup_deletes_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        legacy_fixture(tmp.path());
        // The backup name is taken by a directory: copying onto it fails.
        std::fs::create_dir_all(workspace_dir(tmp.path()).join("backups/v1-onedesk.db")).unwrap();
        let e = move_legacy_db(tmp.path()).unwrap_err();
        assert!(e.starts_with(LEGACY_MOVE_FAILED), "{e}");
        assert!(tmp.path().join("onedesk.db").is_file());
    }
}
