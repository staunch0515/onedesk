//! The manifest cache `<data_dir>/plugins/.index` (D364): written only here, read by the worker.
//!
//! `{ "version": 1, "entries": [ { "dir": "<id>/<version>", "mtime": <ms>, "size": <bytes>, "manifest": "<text>" } ] }`
//! sorted by `dir`; a package whose manifest cannot be read has no `manifest` and `"error": "unreadable"`.
//! A refresh lists `plugins/*/*/`, stats each `manifest.json` and reads only the ones that are new or whose
//! modification time or size changed. The file is written to a temporary name and renamed. The main process
//! does not interpret manifests.

use std::collections::BTreeMap;
use std::io;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};

pub const FILE_NAME: &str = ".index";
const TMP_PREFIX: &str = ".index.tmp-";
/// Refreshes run one at a time (two writers would race on the last rename), and each writes its own temporary file.
static REFRESH: std::sync::Mutex<()> = std::sync::Mutex::new(());
static TMP_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
const VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct Entry {
    dir: String,
    mtime: u64,
    size: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    manifest: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct Index {
    version: u32,
    entries: Vec<Entry>,
}

/// What one refresh did.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Refresh {
    /// Manifests opened and read this time.
    pub read: usize,
    /// Entries taken from the cache unchanged.
    pub reused: usize,
    /// Cached entries whose package is gone.
    pub removed: usize,
    /// Whether `.index` was written (it is not when nothing differs).
    pub written: bool,
}

fn is_hidden(name: &std::ffi::OsStr) -> bool {
    name.to_str().is_none_or(|n| n.starts_with('.'))
}

fn subdirs(dir: &Path) -> Vec<(String, PathBuf)> {
    let Ok(rd) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut out: Vec<(String, PathBuf)> = rd
        .filter_map(|e| e.ok())
        .filter(|e| !is_hidden(&e.file_name()) && e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .filter_map(|e| Some((e.file_name().to_str()?.to_string(), e.path())))
        .collect();
    out.sort();
    out
}

/// `(mtime in ms, size)` of the manifest file; `None` when it is missing or not a file.
fn stat(manifest: &Path) -> Option<(u64, u64)> {
    let m = std::fs::metadata(manifest).ok().filter(|m| m.is_file())?;
    let ms = m.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0);
    Some((ms, m.len()))
}

fn load(path: &Path) -> BTreeMap<String, Entry> {
    let Ok(text) = std::fs::read_to_string(path) else { return BTreeMap::new() };
    match serde_json::from_str::<Index>(&text) {
        Ok(i) if i.version == VERSION => i.entries.into_iter().map(|e| (e.dir.clone(), e)).collect(),
        _ => BTreeMap::new(),
    }
}

/// Brings `<plugin_root>/.index` up to date. `builtin` lists `<id>@<version>` of the built-in packages: their
/// manifests are always read from disk, never taken from the cache (D371: the built-in version confirms the
/// manifest's permissions by itself, so a cache rewritten by another program must not widen them).
pub fn refresh(plugin_root: &Path, builtin: &[String]) -> io::Result<Refresh> {
    refresh_with(plugin_root, builtin, &mut |p| std::fs::read(p))
}

/// [`refresh`] with the file reader passed in (the tests count reads through it).
pub fn refresh_with(plugin_root: &Path, builtin: &[String], read: &mut dyn FnMut(&Path) -> io::Result<Vec<u8>>) -> io::Result<Refresh> {
    let _one_at_a_time = REFRESH.lock().unwrap_or_else(|e| e.into_inner());
    let always: std::collections::HashSet<String> = builtin.iter().map(|b| b.replacen('@', "/", 1)).collect();
    let index_path = plugin_root.join(FILE_NAME);
    let old_text = std::fs::read_to_string(&index_path).ok();
    let cached = load(&index_path);
    let mut out = Refresh::default();
    let mut entries: Vec<Entry> = Vec::new();
    for (id, id_dir) in subdirs(plugin_root) {
        for (version, dir) in subdirs(&id_dir) {
            let key = format!("{id}/{version}");
            let manifest = dir.join("manifest.json");
            let seen = stat(&manifest);
            let (mtime, size) = seen.unwrap_or((0, 0));
            if let Some(c) = cached.get(&key).filter(|_| !always.contains(&key)) {
                // A missing manifest stays cached as unreadable; a file that exists but failed to read is retried.
                let same = c.mtime == mtime && c.size == size;
                let settled = c.manifest.is_some() || seen.is_none();
                if same && settled {
                    entries.push(c.clone());
                    out.reused += 1;
                    continue;
                }
            }
            let mut entry = Entry { dir: key, mtime, size, manifest: None, error: None };
            let text = if seen.is_some() {
                out.read += 1;
                read(&manifest).ok().and_then(|b| String::from_utf8(b).ok())
            } else {
                None
            };
            match text {
                Some(t) => entry.manifest = Some(t),
                None => entry.error = Some("unreadable".into()),
            }
            entries.push(entry);
        }
    }
    let now: std::collections::HashSet<&str> = entries.iter().map(|e| e.dir.as_str()).collect();
    out.removed = cached.keys().filter(|k| !now.contains(k.as_str())).count();
    // `subdirs` is sorted per level, but "a/1" vs "a-b/1" order by the joined string, so sort once more.
    entries.sort_by(|a, b| a.dir.cmp(&b.dir));
    let text = serde_json::to_string(&Index { version: VERSION, entries }).expect("index serializes");
    if old_text.as_deref() != Some(text.as_str()) {
        let tmp = plugin_root.join(format!("{TMP_PREFIX}{}-{}", std::process::id(), TMP_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
        let written = std::fs::write(&tmp, &text).and_then(|_| std::fs::rename(&tmp, &index_path));
        if let Err(e) = written {
            let _ = std::fs::remove_file(&tmp); // the index itself stays as it was
            return Err(e);
        }
        out.written = true;
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    fn pkg(root: &Path, id: &str, version: &str, body: &str) {
        let dir = root.join(id).join(version);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("manifest.json"), body).unwrap();
    }

    fn counted(root: &Path) -> (Refresh, usize) {
        let n = Cell::new(0usize);
        let r = refresh_with(root, &[], &mut |p| {
            n.set(n.get() + 1);
            std::fs::read(p)
        })
        .unwrap();
        (r, n.get())
    }

    fn entries(root: &Path) -> Vec<Entry> {
        serde_json::from_str::<Index>(&std::fs::read_to_string(root.join(FILE_NAME)).unwrap()).unwrap().entries
    }

    #[test]
    fn builds_the_cache_first_sorted_with_manifest_text() {
        let tmp = tempfile::tempdir().unwrap();
        pkg(tmp.path(), "org.b", "1.0.0", r#"{"id":"org.b"}"#);
        pkg(tmp.path(), "org.a", "0.2.0", "not json at all");
        std::fs::create_dir_all(tmp.path().join(".tmp/x/y")).unwrap();
        std::fs::create_dir_all(tmp.path().join(".removed/org.c/1-2")).unwrap();
        let (r, reads) = counted(tmp.path());
        assert_eq!((r.read, r.reused, r.written, reads), (2, 0, true, 2));
        let e = entries(tmp.path());
        assert_eq!(e.iter().map(|e| e.dir.as_str()).collect::<Vec<_>>(), ["org.a/0.2.0", "org.b/1.0.0"]);
        assert_eq!(e[1].manifest.as_deref(), Some(r#"{"id":"org.b"}"#));
        assert_eq!(e[0].manifest.as_deref(), Some("not json at all")); // the main process does not interpret it
    }

    #[test]
    fn unchanged_reads_nothing_and_does_not_rewrite() {
        let tmp = tempfile::tempdir().unwrap();
        pkg(tmp.path(), "org.a", "1.0.0", "{}");
        counted(tmp.path());
        let before = std::fs::metadata(tmp.path().join(FILE_NAME)).unwrap().modified().unwrap();
        let (r, reads) = counted(tmp.path());
        assert_eq!((r.read, r.reused, r.removed, r.written, reads), (0, 1, 0, false, 0));
        assert_eq!(std::fs::metadata(tmp.path().join(FILE_NAME)).unwrap().modified().unwrap(), before);
    }

    #[test]
    fn a_changed_manifest_is_the_only_one_read() {
        let tmp = tempfile::tempdir().unwrap();
        for i in 0..5 {
            pkg(tmp.path(), &format!("org.p{i}"), "1.0.0", "{}");
        }
        counted(tmp.path());
        pkg(tmp.path(), "org.p3", "1.0.0", r#"{"changed":true}"#); // size differs
        let (r, reads) = counted(tmp.path());
        assert_eq!((r.read, r.reused, reads), (1, 4, 1));
        assert_eq!(entries(tmp.path())[3].manifest.as_deref(), Some(r#"{"changed":true}"#));
    }

    #[test]
    fn same_size_but_newer_mtime_is_read_again() {
        let tmp = tempfile::tempdir().unwrap();
        pkg(tmp.path(), "org.a", "1.0.0", r#"{"v":1}"#);
        counted(tmp.path());
        let file = std::fs::File::options().write(true).open(tmp.path().join("org.a/1.0.0/manifest.json")).unwrap();
        std::io::Write::write_all(&mut &file, br#"{"v":2}"#).unwrap();
        file.set_modified(std::time::SystemTime::now() + std::time::Duration::from_secs(5)).unwrap();
        let (_, reads) = counted(tmp.path());
        assert_eq!(reads, 1);
        assert_eq!(entries(tmp.path())[0].manifest.as_deref(), Some(r#"{"v":2}"#));
    }

    #[test]
    fn new_packages_are_read_and_vanished_ones_dropped() {
        let tmp = tempfile::tempdir().unwrap();
        pkg(tmp.path(), "org.a", "1.0.0", "{}");
        pkg(tmp.path(), "org.b", "1.0.0", "{}");
        counted(tmp.path());
        std::fs::remove_dir_all(tmp.path().join("org.a")).unwrap();
        pkg(tmp.path(), "org.c", "1.0.0", "{}");
        let (r, reads) = counted(tmp.path());
        assert_eq!((r.read, r.reused, r.removed, reads), (1, 1, 1, 1));
        assert_eq!(entries(tmp.path()).iter().map(|e| e.dir.as_str()).collect::<Vec<_>>(), ["org.b/1.0.0", "org.c/1.0.0"]);
    }

    #[test]
    fn a_package_without_a_readable_manifest_is_marked_unreadable() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("org.a/1.0.0")).unwrap(); // no manifest.json
        pkg(tmp.path(), "org.b", "1.0.0", "{}");
        std::fs::write(tmp.path().join("org.b/1.0.0/manifest.json"), [0xff, 0xfe]).unwrap(); // not UTF-8
        counted(tmp.path());
        let e = entries(tmp.path());
        assert!(e.iter().all(|e| e.manifest.is_none() && e.error.as_deref() == Some("unreadable")));
        let (r, reads) = counted(tmp.path()); // the missing one is not retried; the unreadable file is
        assert_eq!((r.reused, reads), (1, 1));
    }

    #[test]
    fn a_damaged_or_unknown_version_cache_is_rebuilt_in_full() {
        let tmp = tempfile::tempdir().unwrap();
        pkg(tmp.path(), "org.a", "1.0.0", "{}");
        pkg(tmp.path(), "org.b", "1.0.0", "{}");
        for bad in ["{ not json", r#"{"version":99,"entries":[]}"#, r#"{"version":1,"entries":"x"}"#, ""] {
            std::fs::write(tmp.path().join(FILE_NAME), bad).unwrap();
            let (r, reads) = counted(tmp.path());
            assert_eq!((r.read, r.written, reads), (2, true, 2), "for {bad:?}");
            assert_eq!(entries(tmp.path()).len(), 2);
        }
    }

    #[test]
    fn the_write_goes_through_a_temporary_file_and_a_rename() {
        let tmp = tempfile::tempdir().unwrap();
        pkg(tmp.path(), "org.a", "1.0.0", "{}");
        // A stale temporary file from a crashed write never becomes the index and is overwritten.
        std::fs::write(tmp.path().join(".index.tmp-1-1"), "garbage").unwrap();
        counted(tmp.path());
        // Our own temporary file is renamed away; nothing of ours is left behind.
        let left: Vec<_> = std::fs::read_dir(tmp.path()).unwrap().filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| n.starts_with(TMP_PREFIX) && n != ".index.tmp-1-1").collect();
        assert!(left.is_empty(), "{left:?}");
        assert!(serde_json::from_str::<Index>(&std::fs::read_to_string(tmp.path().join(FILE_NAME)).unwrap()).is_ok());
    }

    #[test]
    fn builtin_manifests_are_always_read_from_disk_not_taken_from_the_cache() {
        let tmp = tempfile::tempdir().unwrap();
        pkg(tmp.path(), "org.builtin", "1.0.0", r#"{"permissions":["files"]}"#);
        pkg(tmp.path(), "org.other", "1.0.0", r#"{"permissions":[]}"#);
        counted(tmp.path());
        // Someone rewrites both cached manifests; the files on disk (and so mtime and size) did not change.
        let mut index: Index = serde_json::from_str(&std::fs::read_to_string(tmp.path().join(FILE_NAME)).unwrap()).unwrap();
        for e in &mut index.entries {
            e.manifest = Some(r#"{"permissions":["everything"]}"#.into());
        }
        std::fs::write(tmp.path().join(FILE_NAME), serde_json::to_string(&index).unwrap()).unwrap();
        let n = Cell::new(0usize);
        let r = refresh_with(tmp.path(), &["org.builtin@1.0.0".to_string()], &mut |p| {
            n.set(n.get() + 1);
            std::fs::read(p)
        })
        .unwrap();
        assert_eq!((r.read, r.reused, n.get()), (1, 1, 1)); // the built-in one is read, the other trusted as before
        let e = entries(tmp.path());
        assert_eq!(e[0].manifest.as_deref(), Some(r#"{"permissions":["files"]}"#)); // restored from disk
        assert_eq!(e[1].manifest.as_deref(), Some(r#"{"permissions":["everything"]}"#)); // not built in: same risk as editing plugins/ itself
    }

    #[test]
    fn concurrent_refreshes_each_leave_a_valid_index_and_no_temporary_file() {
        let tmp = tempfile::tempdir().unwrap();
        for i in 0..20 {
            pkg(tmp.path(), &format!("org.p{i}"), "1.0.0", "{}");
        }
        let root = tmp.path().to_path_buf();
        let threads: Vec<_> = (0..8).map(|_| { let r = root.clone(); std::thread::spawn(move || (0..5).for_each(|_| { refresh(&r, &[]).unwrap(); })) }).collect();
        threads.into_iter().for_each(|t| t.join().unwrap());
        assert_eq!(entries(&root).len(), 20);
        let temps: Vec<_> = std::fs::read_dir(&root).unwrap().filter_map(|e| e.ok()).filter(|e| e.file_name().to_string_lossy().starts_with(TMP_PREFIX)).collect();
        assert!(temps.is_empty());
    }

    #[test]
    fn ten_thousand_packages_second_refresh_reads_no_manifest() {
        let tmp = tempfile::tempdir().unwrap();
        for i in 0..10_000 {
            pkg(tmp.path(), &format!("org.bulk.p{i:05}"), "1.0.0", &format!(r#"{{"id":"org.bulk.p{i:05}","version":"1.0.0"}}"#));
        }
        let t0 = std::time::Instant::now();
        let (first, reads1) = counted(tmp.path());
        let d1 = t0.elapsed();
        let t1 = std::time::Instant::now();
        let (second, reads2) = counted(tmp.path());
        let d2 = t1.elapsed();
        eprintln!("10000 packages: first refresh {d1:?} ({reads1} reads), second refresh {d2:?} ({reads2} reads)");
        assert_eq!((first.read, reads1), (10_000, 10_000));
        assert_eq!((second.read, second.reused, reads2), (0, 10_000, 0));
    }
}
