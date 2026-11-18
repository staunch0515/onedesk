//! The workspace folders under `workspaces/` (kernel-design §3.1, D228, D400): listing them from their
//! `workspace.json`, creating, renaming and moving them to `trash/`. No database is opened for writing here; the
//! only read is the workspace id and the secret names of a workspace that is being deleted.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::data_dir::workspace_path;

pub const INFO_FILE: &str = "workspace.json";
pub const DB_FILE: &str = "workspace.db";
pub use onedesk_protocol::INIT_SETTINGS_FILE;
pub const MAX_NAME_CHARS: usize = 100;

pub use onedesk_protocol::WorkspaceEntry;

/// The same file the kernel writes (`WorkspaceFile` in `onedesk-kernel`): the main process reads it without a database.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InfoFile {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub last_opened_at: i64,
    /// Where the last window of this workspace was (logical pixels); written by the main process (D403).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window: Option<WindowBounds>,
}

/// Position and size of a window, in logical pixels.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct WindowBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// 32 random hex characters (the kernel's id shape), from the system's random source.
pub fn new_id() -> String {
    use std::io::Read;
    let mut b = [0u8; 16];
    let ok = std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut b)).is_ok();
    if !ok {
        // Only if the system source is unavailable: time and process id still make a distinct id.
        let n = now_ms() as u128 * 1_000_003 + std::process::id() as u128;
        b.copy_from_slice(&n.to_le_bytes());
    }
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// `Some(trimmed)` when the name is 1–100 characters.
pub fn valid_name(name: &str) -> Option<String> {
    let t = name.trim();
    (!t.is_empty() && t.chars().count() <= MAX_NAME_CHARS).then(|| t.to_string())
}

/// A folder name from a display name: letters and digits stay, separators become `-`, the rest is dropped.
fn slug(name: &str) -> String {
    let mut out = String::new();
    for c in name.chars() {
        if c.is_alphanumeric() {
            out.extend(c.to_lowercase());
        } else if (c.is_whitespace() || c == '-' || c == '_' || c == '.') && !out.ends_with('-') {
            out.push('-');
        }
    }
    let t: String = out.trim_matches('-').chars().take(40).collect();
    let t = t.trim_matches('-').to_string();
    if t.is_empty() {
        "workspace".into()
    } else {
        t
    }
}

pub fn read_info(dir: &Path) -> Option<InfoFile> {
    std::fs::read(dir.join(INFO_FILE)).ok().and_then(|b| serde_json::from_slice(&b).ok())
}

/// Puts a remembered window position back into `workspace.json` after the kernel rewrote the file.
pub fn keep_window(dir: &Path, window: Option<WindowBounds>) {
    if let (Some(w), Some(mut info)) = (window, read_info(dir)) {
        if info.window != Some(w) {
            info.window = Some(w);
            let _ = write_info(dir, &info);
        }
    }
}

pub fn write_info(dir: &Path, info: &InfoFile) -> std::io::Result<()> {
    let tmp = dir.join(".workspace.json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(info).expect("serializes"))?;
    std::fs::rename(&tmp, dir.join(INFO_FILE))
}

/// Folders that are workspaces (have a `workspace.json` or a `workspace.db`). The main process never opens a database
/// (D404): one without a readable `workspace.json` is listed with the folder's name and a pending id (`""`); the kernel
/// writes `workspace.json` with the real id when its worker opens the workspace.
pub fn scan(data_dir: &Path) -> Vec<(String, InfoFile)> {
    let Ok(rd) = std::fs::read_dir(data_dir.join("workspaces")) else { return Vec::new() };
    let mut out = Vec::new();
    // In folder order, so which of two folders with one id is "first" does not change between runs.
    let mut entries: Vec<_> = rd.filter_map(|e| e.ok()).collect();
    entries.sort_by_key(|e| e.file_name());
    let mut seen = std::collections::HashSet::new();
    for e in entries {
        let dir = e.path();
        let folder = e.file_name().to_string_lossy().into_owned();
        if folder.starts_with('.') || !dir.is_dir() || !(dir.join(INFO_FILE).is_file() || dir.join(DB_FILE).is_file()) {
            continue;
        }
        let info = match read_info(&dir) {
            Some(i) if !i.id.is_empty() => i,
            _ => InfoFile { id: String::new(), name: folder.clone(), last_opened_at: 0, window: None },
        };
        // A folder copied by hand has its twin's id (§3.1): the one found later is pending, like one without a file —
        // it cannot be renamed or deleted, so the twin's keychain entries are safe.
        let info = if !info.id.is_empty() && !seen.insert(info.id.clone()) { InfoFile { id: String::new(), ..info } } else { info };
        out.push((folder, info));
    }
    out
}

/// Newest `lastOpened` first; ties by name.
pub fn sorted(mut v: Vec<(String, InfoFile)>) -> Vec<(String, InfoFile)> {
    v.sort_by(|a, b| b.1.last_opened_at.cmp(&a.1.last_opened_at).then_with(|| a.1.name.cmp(&b.1.name)));
    v
}

/// The id a workspace without `workspace.json` is listed under.
pub fn pending_id(folder: &str) -> String {
    format!("pending:{folder}")
}

pub fn entry(folder: &str, info: &InfoFile, current: bool) -> WorkspaceEntry {
    WorkspaceEntry {
        id: if info.id.is_empty() { pending_id(folder) } else { info.id.clone() },
        name: info.name.clone(),
        folder: folder.to_string(),
        last_opened: (info.last_opened_at > 0).then_some(info.last_opened_at),
        current,
    }
}

/// Creates the folder with its `workspace.json` (and the settings to apply at the first open, if any).
pub fn create(data_dir: &Path, name: &str, init_settings: Option<&serde_json::Value>) -> Result<(String, InfoFile), String> {
    let root = data_dir.join("workspaces");
    std::fs::create_dir_all(&root).map_err(|e| format!("create {}: {e}", root.display()))?;
    // `create_dir` fails when the folder exists, so two creations of one name at once cannot share a folder: the loser
    // takes the next suffix.
    let base = slug(name);
    let mut folder = base.clone();
    let mut n = 2;
    let dir = loop {
        let dir = root.join(&folder);
        match std::fs::create_dir(&dir) {
            Ok(()) => break dir,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                folder = format!("{base}-{n}");
                n += 1;
            }
            Err(e) => return Err(format!("create {}: {e}", dir.display())),
        }
    };
    let info = InfoFile { id: new_id(), name: name.to_string(), last_opened_at: 0, window: None };
    let done = write_info(&dir, &info).and_then(|_| match init_settings {
        Some(v) => std::fs::write(dir.join(INIT_SETTINGS_FILE), serde_json::to_vec_pretty(v).expect("serializes")),
        None => Ok(()),
    });
    if let Err(e) = done {
        let _ = std::fs::remove_dir_all(&dir);
        return Err(format!("write {}: {e}", dir.display()));
    }
    Ok((folder, info))
}

/// Moves the folder to `<data dir>/trash/workspaces/<folder>-<UTC stamp>`; returns where it went.
pub fn move_to_trash(data_dir: &Path, folder: &str) -> Result<PathBuf, String> {
    let from = workspace_path(data_dir, folder);
    let root = data_dir.join("trash").join("workspaces");
    std::fs::create_dir_all(&root).map_err(|e| format!("create {}: {e}", root.display()))?;
    let stamp = onedesk_kernel::workspace::stamp(now_ms());
    let mut to = root.join(format!("{folder}-{stamp}"));
    let mut n = 2;
    while to.exists() {
        to = root.join(format!("{folder}-{stamp}-{n}"));
        n += 1;
    }
    std::fs::rename(&from, &to).map_err(|e| format!("move {} to {}: {e}", from.display(), to.display()))?;
    Ok(to)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folder_names_are_made_from_the_name_and_never_collide() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(slug("My Work / 2026"), "my-work-2026");
        assert_eq!(slug("日本語 ワーク"), "日本語-ワーク");
        assert_eq!(slug("../.."), "workspace");
        let (a, _) = create(tmp.path(), "Team", None).unwrap();
        let (b, _) = create(tmp.path(), "team", None).unwrap();
        assert_eq!((a.as_str(), b.as_str()), ("team", "team-2"));
    }

    #[test]
    fn a_folder_without_workspace_json_is_listed_with_a_pending_id_and_nothing_is_written() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = workspace_path(tmp.path(), "old-one");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(DB_FILE), b"not opened by the main process").unwrap();
        let found = scan(tmp.path());
        assert_eq!(found.len(), 1);
        let e = entry(&found[0].0, &found[0].1, false);
        assert_eq!((e.name.as_str(), e.id.as_str()), ("old-one", "pending:old-one"));
        assert!(!dir.join(INFO_FILE).exists());
        // A corrupt file counts the same.
        std::fs::write(dir.join(INFO_FILE), b"{ nope").unwrap();
        assert!(scan(tmp.path())[0].1.id.is_empty());
    }

    #[test]
    fn creating_the_same_name_at_once_gives_every_creator_its_own_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let data = tmp.path().to_path_buf();
        let threads: Vec<_> = (0..12)
            .map(|_| {
                let data = data.clone();
                std::thread::spawn(move || create(&data, "Team", None).unwrap().0)
            })
            .collect();
        let mut folders: Vec<String> = threads.into_iter().map(|t| t.join().unwrap()).collect();
        folders.sort();
        folders.dedup();
        assert_eq!(folders.len(), 12);
        assert_eq!(scan(&data).len(), 12);
    }

    #[test]
    fn a_copied_folder_with_the_same_id_is_pending_and_the_first_keeps_its_id() {
        let tmp = tempfile::tempdir().unwrap();
        let info = InfoFile { id: "same".into(), name: "Work".into(), last_opened_at: 5, window: None };
        for folder in ["a-work", "b-work-copy"] {
            let dir = workspace_path(tmp.path(), folder);
            std::fs::create_dir_all(&dir).unwrap();
            write_info(&dir, &info).unwrap();
        }
        let found = sorted(scan(tmp.path()));
        let ids: Vec<(String, String)> = found.iter().map(|(f, i)| (f.clone(), entry(f, i, false).id)).collect();
        assert!(ids.contains(&("a-work".into(), "same".into())));
        assert!(ids.contains(&("b-work-copy".into(), "pending:b-work-copy".into())));
    }

    #[test]
    fn names_are_one_to_a_hundred_characters() {
        assert_eq!(valid_name("  a "), Some("a".into()));
        assert_eq!(valid_name("   "), None);
        assert!(valid_name(&"あ".repeat(100)).is_some());
        assert!(valid_name(&"あ".repeat(101)).is_none());
    }
}
