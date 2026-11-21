//! The `files` host capability, limited to folders the user granted (D184, D261).
//! Every path is made absolute, normalized and has its symlinks resolved *before* it is compared
//! with the grants, component by component (so `/a/b` does not cover `/a/bc`).

use std::io::Write;
use std::path::{Component, Path, PathBuf};

use serde::Serialize;
use serde_json::{json, Value};

use crate::util::{denied, err_p, outside_grant, internal, invalid, invalid_params, not_found, KResult};
use onedesk_protocol::ErrorCode;

pub const MAX_TEXT: u64 = 2 * 1024 * 1024;
pub const MAX_BATCH: usize = 1000;
pub const DEFAULT_BATCH: usize = 200;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub dir: bool,
    pub size: u64,
    pub modified_at: i64,
    pub hidden: bool,
}

/// Resolves `raw` to a real path inside one of `grants`; anything else is `denied`.
/// For a path that does not exist yet (`writeText` of a new file) the parent must exist.
pub fn resolve(grants: &[PathBuf], raw: &str) -> KResult<PathBuf> {
    let p = Path::new(raw);
    if !p.is_absolute() {
        return Err(denied("notAbsolute"));
    }
    let real = match std::fs::canonicalize(p) {
        Ok(r) => r,
        Err(_) => {
            // New file: canonicalize the parent, keep a plain final name.
            let name = match p.components().next_back() {
                Some(Component::Normal(n)) => n.to_os_string(),
                _ => return Err(outside_grant(raw)),
            };
            let parent = p.parent().ok_or_else(|| outside_grant(raw))?;
            let parent = std::fs::canonicalize(parent).map_err(|_| not_found("path"))?;
            parent.join(name)
        }
    };
    if grants.iter().any(|g| real.starts_with(g)) {
        Ok(real)
    } else {
        Err(outside_grant(raw))
    }
}

fn millis(t: std::io::Result<std::time::SystemTime>) -> i64 {
    t.ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn entry(path: &Path) -> KResult<Entry> {
    let md = std::fs::metadata(path).map_err(|_| not_found("path"))?;
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| path.display().to_string());
    Ok(Entry {
        hidden: name.starts_with('.'),
        name,
        path: path.display().to_string(),
        dir: md.is_dir(),
        size: if md.is_dir() { 0 } else { md.len() },
        modified_at: millis(md.modified()),
    })
}

fn entry_no_follow(path: &Path) -> KResult<Entry> {
    let md = std::fs::symlink_metadata(path).map_err(|_| not_found("path"))?;
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    Ok(Entry {
        hidden: name.starts_with('.'),
        name,
        path: path.display().to_string(),
        dir: false,
        size: 0,
        modified_at: millis(md.modified()),
    })
}

pub fn roots(grants: &[PathBuf]) -> Value {
    Value::Array(
        grants
            .iter()
            .map(|g| {
                json!({ "path": g.display().to_string(),
                        "name": g.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| g.display().to_string()) })
            })
            .collect(),
    )
}

pub fn list(grants: &[PathBuf], raw: &str, opts: &Value) -> KResult<Value> {
    let dir = resolve(grants, raw)?;
    if !dir.is_dir() {
        return Err(invalid("notFolder"));
    }
    let offset = opts.get("offset").and_then(Value::as_u64).unwrap_or(0) as usize;
    let limit = (opts.get("limit").and_then(Value::as_u64).unwrap_or(DEFAULT_BATCH as u64) as usize).clamp(1, MAX_BATCH);
    let mut entries: Vec<Entry> = std::fs::read_dir(&dir)
        .map_err(internal)?
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let path = e.path();
            // A link that leads outside every grant is listed as itself, without following it.
            let follows = std::fs::canonicalize(&path).is_ok_and(|r| grants.iter().any(|g| r.starts_with(g)));
            if follows { entry(&path).ok() } else { entry_no_follow(&path).ok() }
        })
        .collect();
    // Folders first, then by name (case-insensitive).
    entries.sort_by(|a, b| b.dir.cmp(&a.dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    let total = entries.len();
    let page: Vec<Entry> = entries.into_iter().skip(offset).take(limit).collect();
    let next = (offset + page.len() < total).then_some(offset + page.len());
    Ok(json!({ "entries": page, "next": next }))
}

pub fn stat(grants: &[PathBuf], raw: &str) -> KResult<Value> {
    let p = resolve(grants, raw)?;
    Ok(serde_json::to_value(entry(&p)?).expect("json"))
}

pub fn read_text(grants: &[PathBuf], raw: &str) -> KResult<Value> {
    use std::io::Read;
    // Review #3: checked and read through the same descriptor (no second lookup by path).
    let (_, mut f, len) = open_source(grants, raw)?;
    if len > MAX_TEXT {
        return Err(invalid("tooLarge"));
    }
    let mut bytes = Vec::new();
    Read::by_ref(&mut f).take(MAX_TEXT + 1).read_to_end(&mut bytes).map_err(internal)?;
    if bytes.len() as u64 > MAX_TEXT {
        return Err(invalid("tooLarge"));
    }
    let basis = crate::util::fingerprint(&bytes);
    let text = String::from_utf8(bytes).map_err(|_| invalid("notText"))?;
    Ok(json!({ "text": text, "basis": basis }))
}

/// Opens the already-resolved absolute folder `dir` one component at a time from `/`, never
/// following a link (`O_NOFOLLOW | O_DIRECTORY`). The descriptor stays on that real folder even if
/// the path is swapped for a symlink afterwards (review #7).
fn open_dir_nofollow(dir: &Path) -> std::io::Result<std::os::fd::OwnedFd> {
    use std::ffi::CString;
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    use std::os::unix::ffi::OsStrExt;
    let flags = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
    let root = CString::new("/").expect("no nul");
    // SAFETY: plain syscall with a valid C string; the result is checked before use.
    let fd = unsafe { libc::open(root.as_ptr(), flags) };
    if fd < 0 {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: `fd` is a fresh descriptor we own.
    let mut cur = unsafe { OwnedFd::from_raw_fd(fd) };
    for c in dir.components() {
        let name = match c {
            Component::RootDir => continue,
            Component::Normal(n) => n,
            _ => return Err(std::io::Error::other("path not normalized")),
        };
        let cname = CString::new(name.as_bytes()).map_err(std::io::Error::other)?;
        // SAFETY: as above; `cur` is a valid directory descriptor.
        let next = unsafe { libc::openat(cur.as_raw_fd(), cname.as_ptr(), flags) };
        if next < 0 {
            return Err(std::io::Error::last_os_error());
        }
        // SAFETY: fresh descriptor we own.
        cur = unsafe { OwnedFd::from_raw_fd(next) };
    }
    Ok(cur)
}

fn cstr(s: &str) -> std::io::Result<std::ffi::CString> {
    std::ffi::CString::new(s).map_err(std::io::Error::other)
}

/// Writes through a temporary file in the same folder, then renames over the target.
/// Returns the resolved path (for the audit) and the new basis.
pub fn write_text(grants: &[PathBuf], raw: &str, text: &str, basis: Option<&str>) -> KResult<(PathBuf, String)> {
    write_text_with(grants, raw, text, basis, || {})
}

/// `write_text` with a hook that runs right after the folder is pinned (tests swap the folder there).
pub fn write_text_with(
    grants: &[PathBuf],
    raw: &str,
    text: &str,
    basis: Option<&str>,
    after_pin: impl FnOnce(),
) -> KResult<(PathBuf, String)> {
    use std::io::Read;
    use std::os::fd::{AsRawFd, FromRawFd};
    let p = resolve(grants, raw)?;
    if p.is_dir() {
        return Err(invalid("notFile"));
    }
    if text.len() as u64 > MAX_TEXT {
        return Err(invalid("tooLarge"));
    }
    let dir = p.parent().ok_or_else(|| invalid_params("no parent"))?;
    let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).ok_or_else(|| invalid_params("no name"))?;
    let dirfd = open_dir_nofollow(dir).map_err(|_| outside_grant(raw))?;
    after_pin();
    let d = dirfd.as_raw_fd();
    let cname = cstr(&name).map_err(internal)?;
    // Mode of the existing target (not following a link that may have appeared there).
    // SAFETY: zeroed `stat` is a valid out-parameter; `d` and `cname` are valid.
    let mut st: libc::stat = unsafe { std::mem::zeroed() };
    let exists = unsafe { libc::fstatat(d, cname.as_ptr(), &mut st, libc::AT_SYMLINK_NOFOLLOW) } == 0;
    if let Some(b) = basis {
        let current = if exists {
            // SAFETY: valid descriptor and C string; result checked.
            let fd = unsafe { libc::openat(d, cname.as_ptr(), libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC) };
            if fd < 0 {
                None
            } else {
                // SAFETY: fresh descriptor we own.
                let mut f = unsafe { std::fs::File::from_raw_fd(fd) };
                let mut buf = Vec::new();
                f.read_to_end(&mut buf).ok().map(|_| crate::util::fingerprint(&buf))
            }
        } else {
            None
        };
        if current.as_deref() != Some(b) {
            return Err(err_p(ErrorCode::Conflict, &[("reason", "changedOnDisk")]));
        }
    }
    let tmp = cstr(&format!(".{name}.onedesk-{}.tmp", crate::util::new_id())).map_err(internal)?;
    let mode = if exists && (st.st_mode & libc::S_IFMT) == libc::S_IFREG { st.st_mode & 0o7777 } else { 0o644 };
    let res = (|| -> std::io::Result<()> {
        // SAFETY: valid descriptor and C string; result checked.
        let fd = unsafe {
            libc::openat(
                d,
                tmp.as_ptr(),
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                libc::c_uint::from(mode),
            )
        };
        if fd < 0 {
            return Err(std::io::Error::last_os_error());
        }
        // SAFETY: fresh descriptor we own.
        let mut f = unsafe { std::fs::File::from_raw_fd(fd) };
        f.write_all(text.as_bytes())?;
        f.sync_all()?;
        // SAFETY: both names are relative to the same pinned folder.
        if unsafe { libc::renameat(d, tmp.as_ptr(), d, cname.as_ptr()) } != 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    })();
    if let Err(e) = res {
        // SAFETY: valid descriptor and C string.
        unsafe { libc::unlinkat(d, tmp.as_ptr(), 0) };
        return Err(internal(e));
    }
    Ok((p, crate::util::fingerprint(text.as_bytes())))
}

/// Round 8 (`transfer.download`, `transfer.capture`): a file written next to its target as
/// `.<name>.part-<random>` in the pinned folder, renamed into place only by `commit`; dropped
/// before that (failure, timeout, cancellation), the partial file is removed.
pub struct PartFile {
    dir: std::os::fd::OwnedFd,
    name: std::ffi::CString,
    tmp: std::ffi::CString,
    /// The target, resolved (for the result and the audit).
    pub path: PathBuf,
    file: Option<std::fs::File>,
    done: bool,
}

/// Checks `raw` like `writeText` (inside a grant, symlinks resolved, parent exists, not a folder)
/// and opens the partial file. An existing target without `overwrite` → `conflict/exists`.
pub fn part_file(grants: &[PathBuf], raw: &str, overwrite: bool) -> KResult<PartFile> {
    use std::os::fd::{AsRawFd, FromRawFd};
    let p = resolve(grants, raw)?;
    if p.is_dir() {
        return Err(invalid("notFile"));
    }
    let dir = p.parent().ok_or_else(|| invalid_params("no parent"))?;
    let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).ok_or_else(|| invalid_params("no name"))?;
    let dirfd = open_dir_nofollow(dir).map_err(|_| outside_grant(raw))?;
    let d = dirfd.as_raw_fd();
    let cname = cstr(&name).map_err(internal)?;
    // SAFETY: zeroed `stat` is a valid out-parameter; `d` and `cname` are valid.
    let mut st: libc::stat = unsafe { std::mem::zeroed() };
    let exists = unsafe { libc::fstatat(d, cname.as_ptr(), &mut st, libc::AT_SYMLINK_NOFOLLOW) } == 0;
    if exists && !overwrite {
        return Err(err_p(ErrorCode::Conflict, &[("reason", "exists")]));
    }
    if exists && (st.st_mode & libc::S_IFMT) == libc::S_IFDIR {
        return Err(invalid("notFile"));
    }
    // Review #6: an overwritten file keeps its permissions (like `writeText`).
    let mode = if exists && (st.st_mode & libc::S_IFMT) == libc::S_IFREG { st.st_mode & 0o7777 } else { 0o644 };
    let tmp = cstr(&format!(".{name}.part-{}", crate::util::new_id())).map_err(internal)?;
    // SAFETY: valid descriptor and C string; result checked.
    let fd = unsafe {
        libc::openat(d, tmp.as_ptr(), libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC, libc::c_uint::from(mode))
    };
    if fd < 0 {
        return Err(internal(std::io::Error::last_os_error()));
    }
    // SAFETY: fresh descriptor we own.
    let file = unsafe { std::fs::File::from_raw_fd(fd) };
    let part = PartFile { dir: dirfd, name: cname, tmp, path: p, file: Some(file), done: false };
    // Exactly that mode, whatever the process umask.
    // SAFETY: valid descriptor we own.
    if unsafe { libc::fchmod(part.file.as_ref().expect("just opened").as_raw_fd(), mode) } != 0 {
        return Err(internal(std::io::Error::last_os_error()));
    }
    Ok(part)
}

impl PartFile {
    /// The open partial file (taken once, to write to).
    pub fn take_file(&mut self) -> std::fs::File {
        self.file.take().expect("taken once")
    }

    /// Renames the partial file into place. Without `overwrite` a target that appeared meanwhile
    /// is kept (`conflict/exists`) and the partial file removed.
    pub fn commit(mut self, overwrite: bool) -> KResult<()> {
        use std::os::fd::AsRawFd;
        let d = self.dir.as_raw_fd();
        // SAFETY: both names are relative to the same pinned folder.
        let r = unsafe {
            if overwrite {
                libc::renameat(d, self.tmp.as_ptr(), d, self.name.as_ptr())
            } else {
                libc::renameatx_np(d, self.tmp.as_ptr(), d, self.name.as_ptr(), libc::RENAME_EXCL)
            }
        };
        if r != 0 {
            let e = std::io::Error::last_os_error();
            return Err(if e.raw_os_error() == Some(libc::EEXIST) { err_p(ErrorCode::Conflict, &[("reason", "exists")]) } else { internal(e) });
        }
        self.done = true;
        Ok(())
    }
}

impl Drop for PartFile {
    fn drop(&mut self) {
        if !self.done {
            use std::os::fd::AsRawFd;
            // SAFETY: valid descriptor and C string.
            unsafe { libc::unlinkat(self.dir.as_raw_fd(), self.tmp.as_ptr(), 0) };
        }
    }
}

/// A file to read inside a grant (`readText`, `transfer.upload`): resolved and checked, then
/// opened from its pinned folder without following a link (review #3: the descriptor that was
/// checked is the one read — swapping the path for a link afterwards changes nothing).
/// Returns the resolved path, the open file and its size.
pub fn open_source(grants: &[PathBuf], raw: &str) -> KResult<(PathBuf, std::fs::File, u64)> {
    use std::os::fd::{AsRawFd, FromRawFd};
    let p = resolve(grants, raw)?;
    let dir = p.parent().ok_or_else(|| invalid("notFile"))?;
    let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).ok_or_else(|| invalid("notFile"))?;
    let dirfd = open_dir_nofollow(dir).map_err(|_| outside_grant(raw))?;
    let cname = cstr(&name).map_err(internal)?;
    // SAFETY: valid descriptor and C string; result checked.
    let fd = unsafe { libc::openat(dirfd.as_raw_fd(), cname.as_ptr(), libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK) };
    if fd < 0 {
        let e = std::io::Error::last_os_error();
        return Err(match e.raw_os_error() {
            Some(libc::ENOENT) => not_found("path"),
            Some(libc::ELOOP) => outside_grant(raw),
            _ => internal(e),
        });
    }
    // SAFETY: fresh descriptor we own.
    let f = unsafe { std::fs::File::from_raw_fd(fd) };
    let md = f.metadata().map_err(internal)?;
    if !md.is_file() {
        return Err(invalid("notFile"));
    }
    Ok((p, f, md.len()))
}

/* ---------------------------------------------------------------- round 17 (X18) */

/// Most entries `find` looks at.
pub const FIND_MAX_VISIT: usize = 100_000;

/// What to do when the target of `mkdir`, `copy` or `move` exists.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Conflict {
    Fail,
    Overwrite,
    Skip,
    KeepBoth,
}

impl Conflict {
    pub fn as_str(self) -> &'static str {
        match self {
            Conflict::Fail => "fail",
            Conflict::Overwrite => "overwrite",
            Conflict::Skip => "skip",
            Conflict::KeepBoth => "keepBoth",
        }
    }

    pub fn parse(opts: &Value) -> KResult<Conflict> {
        Ok(match opts.get("conflict").filter(|&v| !v.is_null()) {
            None => Conflict::Fail,
            Some(v) => match v.as_str() {
                Some("fail") => Conflict::Fail,
                Some("overwrite") => Conflict::Overwrite,
                Some("skip") => Conflict::Skip,
                Some("keepBoth") => Conflict::KeepBoth,
                _ => return Err(invalid_params("conflict must be fail, overwrite, skip or keepBoth")),
            },
        })
    }
}

/// Like `resolve`, but the final component is never followed: a link is the link itself.
/// The parent must exist. Returns the path and whether it names a granted folder itself.
pub fn resolve_entry(grants: &[PathBuf], raw: &str) -> KResult<(PathBuf, bool)> {
    let p = Path::new(raw);
    if !p.is_absolute() {
        return Err(denied("notAbsolute"));
    }
    let name = match p.components().next_back() {
        Some(Component::Normal(n)) => n.to_os_string(),
        // `/`, `..`, `.` at the end: resolve the whole path (a folder).
        _ => {
            let real = std::fs::canonicalize(p).map_err(|_| not_found("path"))?;
            return if grants.iter().any(|g| real.starts_with(g)) {
                let root = grants.contains(&real);
                Ok((real, root))
            } else {
                Err(outside_grant(raw))
            };
        }
    };
    let parent = p.parent().ok_or_else(|| outside_grant(raw))?;
    let parent = std::fs::canonicalize(parent).map_err(|_| not_found("path"))?;
    let real = parent.join(name);
    if !grants.iter().any(|g| real.starts_with(g)) {
        // A granted folder named through a link to it is still that folder.
        if let Ok(r) = std::fs::canonicalize(&real) {
            if grants.contains(&r) {
                return Ok((r, true));
            }
        }
        return Err(outside_grant(raw));
    }
    let root = grants.contains(&real)
        || std::fs::canonicalize(&real).is_ok_and(|r| grants.contains(&r) && std::fs::symlink_metadata(&real).is_ok_and(|m| !m.file_type().is_symlink()));
    Ok((real, root))
}

fn exists_no_follow(p: &Path) -> bool {
    std::fs::symlink_metadata(p).is_ok()
}

/// `name 2.ext`, `name 3.ext`… (as Finder names copies): the first that is free in `dir`.
pub fn free_name(dir: &Path, name: &str) -> KResult<PathBuf> {
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    for n in 2..10_000 {
        let c = dir.join(format!("{stem} {n}{ext}"));
        if !exists_no_follow(&c) {
            return Ok(c);
        }
    }
    Err(err_p(ErrorCode::Conflict, &[("reason", "exists")]))
}

fn remove_any(p: &Path) -> std::io::Result<()> {
    let md = std::fs::symlink_metadata(p)?;
    if md.is_dir() {
        std::fs::remove_dir_all(p)
    } else {
        std::fs::remove_file(p)
    }
}

/// Copies a file, a link (as a link) or a folder (recursively; links inside as links).
fn copy_tree(src: &Path, dst: &Path) -> std::io::Result<()> {
    let md = std::fs::symlink_metadata(src)?;
    if md.file_type().is_symlink() {
        std::os::unix::fs::symlink(std::fs::read_link(src)?, dst)
    } else if md.is_dir() {
        std::fs::create_dir(dst)?;
        std::fs::set_permissions(dst, md.permissions())?;
        for e in std::fs::read_dir(src)? {
            let e = e?;
            copy_tree(&e.path(), &dst.join(e.file_name()))?;
        }
        Ok(())
    } else {
        std::fs::copy(src, dst).map(|_| ())
    }
}

fn io_err(e: std::io::Error) -> onedesk_protocol::ProtocolError {
    match e.kind() {
        std::io::ErrorKind::NotFound => not_found("path"),
        std::io::ErrorKind::AlreadyExists => err_p(ErrorCode::Conflict, &[("reason", "exists")]),
        _ => internal(e),
    }
}

/// `files.mkdir`: a new folder (`recursive`: with missing parents). Existing → `conflict/exists`.
pub fn mkdir(grants: &[PathBuf], raw: &str, recursive: bool) -> KResult<Entry> {
    let p = if recursive {
        // The deepest existing ancestor decides where it is.
        let path = Path::new(raw);
        if !path.is_absolute() || path.components().any(|c| matches!(c, Component::ParentDir | Component::CurDir)) {
            return Err(if path.is_absolute() { invalid_params("path") } else { denied("notAbsolute") });
        }
        let mut base = path.to_path_buf();
        let mut rest = Vec::new();
        while !exists_no_follow(&base) {
            rest.push(base.file_name().ok_or_else(|| not_found("path"))?.to_os_string());
            base = base.parent().ok_or_else(|| not_found("path"))?.to_path_buf();
        }
        let base = resolve(grants, &base.display().to_string())?;
        if !base.is_dir() {
            return Err(invalid("notFolder"));
        }
        let mut p = base;
        for n in rest.iter().rev() {
            p.push(n);
        }
        if rest.is_empty() {
            return Err(err_p(ErrorCode::Conflict, &[("reason", "exists")]));
        }
        std::fs::create_dir_all(&p).map_err(io_err)?;
        p
    } else {
        let (p, _) = resolve_entry(grants, raw)?;
        std::fs::create_dir(&p).map_err(io_err)?;
        p
    };
    entry(&p)
}

/// Where `copy`/`move` write, after the conflict rule. `None`: skipped.
fn target(src: &Path, dst: &Path, conflict: Conflict) -> KResult<Option<PathBuf>> {
    let src_dir = std::fs::symlink_metadata(src).map_err(|_| not_found("path"))?.is_dir();
    if src == dst || (src_dir && dst.starts_with(src)) {
        return Err(invalid("intoItself"));
    }
    if !exists_no_follow(dst) {
        return Ok(Some(dst.to_path_buf()));
    }
    match conflict {
        Conflict::Fail => Err(err_p(ErrorCode::Conflict, &[("reason", "exists")])),
        Conflict::Skip => Ok(None),
        Conflict::Overwrite => {
            // Never a folder that holds the source.
            if src.starts_with(dst) {
                return Err(invalid("intoItself"));
            }
            remove_any(dst).map_err(io_err)?;
            Ok(Some(dst.to_path_buf()))
        }
        Conflict::KeepBoth => {
            let dir = dst.parent().ok_or_else(|| invalid_params("to"))?;
            let name = dst.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            free_name(dir, &name).map(Some)
        }
    }
}

/// The result of `copy` / `move`.
pub fn placed(p: Option<PathBuf>, asked: &Path) -> Value {
    match p {
        Some(p) => json!({ "path": p.display().to_string(), "skipped": false }),
        None => json!({ "path": asked.display().to_string(), "skipped": true }),
    }
}

/// `files.copy`: returns the path written (or `None` when skipped) and the asked target.
pub fn copy(grants: &[PathBuf], from: &str, to: &str, conflict: Conflict) -> KResult<(PathBuf, Option<PathBuf>, PathBuf)> {
    let (src, _) = resolve_entry(grants, from)?;
    let (dst, _) = resolve_entry(grants, to)?;
    let Some(t) = target(&src, &dst, conflict)? else { return Ok((src, None, dst)) };
    if let Err(e) = copy_tree(&src, &t) {
        let _ = remove_any(&t);
        return Err(io_err(e));
    }
    Ok((src, Some(t), dst))
}

/// `files.move`: rename; across volumes, copy then remove.
pub fn move_to(grants: &[PathBuf], from: &str, to: &str, conflict: Conflict) -> KResult<(PathBuf, Option<PathBuf>, PathBuf)> {
    let (src, root) = resolve_entry(grants, from)?;
    if root {
        return Err(invalid("isRoot"));
    }
    let (dst, _) = resolve_entry(grants, to)?;
    let Some(t) = target(&src, &dst, conflict)? else { return Ok((src, None, dst)) };
    match std::fs::rename(&src, &t) {
        Ok(()) => {}
        Err(e) if e.raw_os_error() == Some(libc::EXDEV) => {
            if let Err(e) = copy_tree(&src, &t) {
                let _ = remove_any(&t);
                return Err(io_err(e));
            }
            remove_any(&src).map_err(io_err)?;
        }
        Err(e) => return Err(io_err(e)),
    }
    Ok((src, Some(t), dst))
}

/// `files.trash`: moved into `trash` (a free name there). Another volume → `invalid/trashUnavailable`.
pub fn trash(grants: &[PathBuf], raw: &str, trash: &Path) -> KResult<(PathBuf, PathBuf)> {
    let (src, root) = resolve_entry(grants, raw)?;
    if root {
        return Err(invalid("isRoot"));
    }
    if !exists_no_follow(&src) {
        return Err(not_found("path"));
    }
    if !trash.is_dir() {
        return Err(invalid("trashUnavailable"));
    }
    let name = src.file_name().map(|n| n.to_string_lossy().into_owned()).ok_or_else(|| invalid_params("path"))?;
    let mut dst = trash.join(&name);
    if exists_no_follow(&dst) {
        dst = free_name(trash, &name)?;
    }
    match std::fs::rename(&src, &dst) {
        Ok(()) => Ok((src, dst)),
        Err(e) if e.raw_os_error() == Some(libc::EXDEV) => Err(invalid("trashUnavailable")),
        Err(e) => Err(io_err(e)),
    }
}

/// `files.remove`: permanently (folders with everything in them).
pub fn remove(grants: &[PathBuf], raw: &str) -> KResult<PathBuf> {
    let (p, root) = resolve_entry(grants, raw)?;
    if root {
        return Err(invalid("isRoot"));
    }
    remove_any(&p).map_err(io_err)?;
    Ok(p)
}

/// `files.open` / `files.reveal`: the path to hand to the system (must exist).
pub fn existing(grants: &[PathBuf], raw: &str) -> KResult<PathBuf> {
    let (p, _) = resolve_entry(grants, raw)?;
    if !exists_no_follow(&p) {
        return Err(not_found("path"));
    }
    Ok(p)
}

/// `files.find`: names containing every word of `query` (case-insensitive), under `raw`;
/// links are not followed, folders starting with `.` are skipped.
pub fn find(grants: &[PathBuf], raw: &str, query: &str, opts: &Value) -> KResult<Value> {
    let dir = resolve(grants, raw)?;
    if !dir.is_dir() {
        return Err(invalid("notFolder"));
    }
    let words: Vec<String> = query.split_whitespace().map(str::to_lowercase).collect();
    if words.is_empty() {
        return Ok(json!({ "entries": [], "next": null }));
    }
    let offset = opts.get("offset").and_then(Value::as_u64).unwrap_or(0) as usize;
    let limit = (opts.get("limit").and_then(Value::as_u64).unwrap_or(DEFAULT_BATCH as u64) as usize).clamp(1, MAX_BATCH);
    let mut found: Vec<PathBuf> = Vec::new();
    let mut stack = vec![dir];
    let (mut visited, mut capped, mut more) = (0usize, false, false);
    'walk: while let Some(d) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else { continue };
        let mut items: Vec<(String, PathBuf, bool)> = rd
            .flatten()
            .map(|e| {
                let is_dir = e.file_type().is_ok_and(|t| t.is_dir());
                (e.file_name().to_string_lossy().into_owned(), e.path(), is_dir)
            })
            .collect();
        items.sort_by_key(|a| a.0.to_lowercase());
        let mut subdirs = Vec::new();
        for (name, path, is_dir) in items {
            visited += 1;
            if visited > FIND_MAX_VISIT {
                capped = true;
                break 'walk;
            }
            let lower = name.to_lowercase();
            if words.iter().all(|w| lower.contains(w.as_str())) {
                if found.len() >= offset + limit {
                    more = true;
                    break 'walk;
                }
                found.push(path.clone());
            }
            if is_dir && !name.starts_with('.') {
                subdirs.push(path);
            }
        }
        // Depth first, in name order.
        stack.extend(subdirs.into_iter().rev());
    }
    let entries: Vec<Entry> = found.iter().skip(offset).filter_map(|p| entry_no_follow_full(p).ok()).collect();
    let next = more.then_some(offset + limit);
    let mut out = json!({ "entries": entries, "next": next });
    if capped {
        out["capped"] = json!(true);
    }
    Ok(out)
}

/// An entry as itself (a link is not followed), with folder and size.
fn entry_no_follow_full(path: &Path) -> KResult<Entry> {
    let md = std::fs::symlink_metadata(path).map_err(|_| not_found("path"))?;
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    Ok(Entry {
        hidden: name.starts_with('.'),
        name,
        path: path.display().to_string(),
        dir: md.is_dir(),
        size: if md.is_file() { md.len() } else { 0 },
        modified_at: millis(md.modified()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Setup {
        _tmp: tempfile::TempDir,
        grant: PathBuf,
        outside: PathBuf,
    }

    fn setup() -> Setup {
        let tmp = tempfile::tempdir().unwrap();
        let base = std::fs::canonicalize(tmp.path()).unwrap();
        let grant = base.join("a").join("b");
        let sibling = base.join("a").join("bc");
        let outside = base.join("outside");
        for d in [&grant, &sibling, &outside] {
            std::fs::create_dir_all(d).unwrap();
        }
        std::fs::write(grant.join("in.txt"), "inside").unwrap();
        std::fs::write(sibling.join("secret.txt"), "sibling").unwrap();
        std::fs::write(outside.join("secret.txt"), "outside").unwrap();
        std::os::unix::fs::symlink(outside.join("secret.txt"), grant.join("link.txt")).unwrap();
        std::os::unix::fs::symlink(&outside, grant.join("linkdir")).unwrap();
        Setup { _tmp: tmp, grant, outside }
    }

    fn code(r: KResult<impl std::fmt::Debug>) -> ErrorCode {
        r.unwrap_err().code
    }

    #[test]
    fn files_inside_the_grant_are_readable_and_writable() {
        let s = setup();
        let g = vec![s.grant.clone()];
        let p = s.grant.join("in.txt").display().to_string();
        let r = read_text(&g, &p).unwrap();
        assert_eq!(r["text"], "inside");
        let (_, b2) = write_text(&g, &p, "changed", r["basis"].as_str()).unwrap();
        assert_eq!(read_text(&g, &p).unwrap()["basis"], b2.as_str());
        let new = s.grant.join("new.txt").display().to_string();
        write_text(&g, &new, "fresh", None).unwrap();
        let l = list(&g, &s.grant.display().to_string(), &json!({})).unwrap();
        assert!(l["entries"].as_array().unwrap().iter().any(|e| e["name"] == "new.txt"));
        // No temporary files left behind.
        assert!(!l["entries"].as_array().unwrap().iter().any(|e| e["name"].as_str().unwrap().ends_with(".tmp")));
    }

    #[test]
    fn files_outside_the_granted_folder_are_denied() {
        let s = setup();
        let g = vec![s.grant.clone()];
        let p = s.outside.join("secret.txt").display().to_string();
        assert_eq!(code(read_text(&g, &p)), ErrorCode::Denied);
        assert_eq!(code(write_text(&g, &p, "x", None)), ErrorCode::Denied);
        assert_eq!(code(list(&g, &s.outside.display().to_string(), &json!({}))), ErrorCode::Denied);
        assert_eq!(std::fs::read_to_string(s.outside.join("secret.txt")).unwrap(), "outside");
    }

    #[test]
    fn review3_a_source_is_read_through_the_descriptor_that_was_checked() {
        use std::io::Read;
        let s = setup();
        let g = vec![s.grant.clone()];
        let p = s.grant.join("in.txt");
        let (_, mut f, len) = open_source(&g, &p.display().to_string()).unwrap();
        assert_eq!(len, 6);
        // The path is swapped for a link out of the grant after the check: nothing changes.
        std::fs::remove_file(&p).unwrap();
        std::os::unix::fs::symlink(s.outside.join("secret.txt"), &p).unwrap();
        let mut got = String::new();
        f.read_to_string(&mut got).unwrap();
        assert_eq!(got, "inside");
        // Opened now, the link is refused; so is a folder.
        assert_eq!(code(open_source(&g, &p.display().to_string())), ErrorCode::Denied);
        assert_eq!(code(open_source(&g, &s.grant.display().to_string())), ErrorCode::Invalid);
        assert_eq!(code(read_text(&g, &p.display().to_string())), ErrorCode::Denied);
    }

    #[test]
    fn review6_an_overwritten_file_keeps_its_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let s = setup();
        let g = vec![s.grant.clone()];
        let p = s.grant.join("in.txt");
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600)).unwrap();
        let part = part_file(&g, &p.display().to_string(), true).unwrap();
        part.commit(true).unwrap();
        assert_eq!(std::fs::metadata(&p).unwrap().permissions().mode() & 0o7777, 0o600);
        let fresh = s.grant.join("fresh.bin");
        part_file(&g, &fresh.display().to_string(), false).unwrap().commit(false).unwrap();
        assert_eq!(std::fs::metadata(&fresh).unwrap().permissions().mode() & 0o7777, 0o644);
    }

    #[test]
    fn files_dotdot_escape_is_denied() {
        let s = setup();
        let g = vec![s.grant.clone()];
        let p = format!("{}/../../outside/secret.txt", s.grant.display());
        assert_eq!(code(read_text(&g, &p)), ErrorCode::Denied);
        let w = format!("{}/../../outside/new.txt", s.grant.display());
        assert_eq!(code(write_text(&g, &w, "x", None)), ErrorCode::Denied);
        assert!(!s.outside.join("new.txt").exists());
        assert_eq!(code(read_text(&g, "relative/in.txt")), ErrorCode::Denied);
    }

    #[test]
    fn files_symlink_pointing_outside_is_denied() {
        let s = setup();
        let g = vec![s.grant.clone()];
        let link = s.grant.join("link.txt").display().to_string();
        assert_eq!(code(read_text(&g, &link)), ErrorCode::Denied);
        assert_eq!(code(write_text(&g, &link, "x", None)), ErrorCode::Denied);
        let through_dir = s.grant.join("linkdir").join("secret.txt").display().to_string();
        assert_eq!(code(read_text(&g, &through_dir)), ErrorCode::Denied);
        assert_eq!(code(write_text(&g, &s.grant.join("linkdir/new.txt").display().to_string(), "x", None)), ErrorCode::Denied);
        assert_eq!(std::fs::read_to_string(s.outside.join("secret.txt")).unwrap(), "outside");
    }

    #[test]
    fn files_same_name_prefix_of_grant_is_denied() {
        let s = setup();
        let g = vec![s.grant.clone()];
        let p = format!("{}c/secret.txt", s.grant.display()); // …/a/bc/secret.txt
        assert_eq!(code(read_text(&g, &p)), ErrorCode::Denied);
        assert_eq!(code(stat(&g, &p)), ErrorCode::Denied);
    }

    #[test]
    fn files_too_large_or_binary_is_invalid_and_stale_basis_conflicts() {
        let s = setup();
        let g = vec![s.grant.clone()];
        let big = s.grant.join("big.txt");
        std::fs::write(&big, vec![b'a'; (MAX_TEXT + 1) as usize]).unwrap();
        let e = read_text(&g, &big.display().to_string()).unwrap_err();
        assert_eq!((e.code, e.params["reason"].as_str()), (ErrorCode::Invalid, "tooLarge"));
        let bin = s.grant.join("bin.dat");
        std::fs::write(&bin, [0xff, 0xfe, 0x00]).unwrap();
        let e = read_text(&g, &bin.display().to_string()).unwrap_err();
        assert_eq!((e.code, e.params["reason"].as_str()), (ErrorCode::Invalid, "notText"));
        let p = s.grant.join("in.txt").display().to_string();
        let old = read_text(&g, &p).unwrap()["basis"].as_str().unwrap().to_string();
        std::fs::write(s.grant.join("in.txt"), "changed elsewhere").unwrap();
        assert_eq!(code(write_text(&g, &p, "mine", Some(&old))), ErrorCode::Conflict);
        assert_eq!(std::fs::read_to_string(s.grant.join("in.txt")).unwrap(), "changed elsewhere");
    }

    #[test]
    fn files_folder_swapped_for_outside_symlink_during_write_leaves_outside_alone() {
        let s = setup();
        let g = vec![s.grant.clone()];
        std::fs::write(s.outside.join("in.txt"), "outside original").unwrap();
        let moved = s.grant.with_file_name("b-moved");
        let p = s.grant.join("in.txt").display().to_string();
        // After the folder is resolved and pinned, an outside process replaces it by a link
        // to the outside folder, which has a file of the same name.
        write_text_with(&g, &p, "written", None, || {
            std::fs::rename(&s.grant, &moved).unwrap();
            std::os::unix::fs::symlink(&s.outside, &s.grant).unwrap();
        })
        .unwrap();
        assert_eq!(std::fs::read_to_string(s.outside.join("in.txt")).unwrap(), "outside original");
        assert_eq!(std::fs::read_to_string(moved.join("in.txt")).unwrap(), "written");
        assert!(std::fs::read_dir(&s.outside).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().ends_with(".tmp")));
    }

    #[test]
    fn files_link_planted_at_the_target_name_is_replaced_not_followed() {
        let s = setup();
        let g = vec![s.grant.clone()];
        let p = s.grant.join("planted.txt");
        let target = p.display().to_string();
        write_text_with(&g, &target, "mine", None, || {
            std::os::unix::fs::symlink(s.outside.join("secret.txt"), &p).unwrap();
        })
        .unwrap();
        assert_eq!(std::fs::read_to_string(s.outside.join("secret.txt")).unwrap(), "outside");
        assert!(!std::fs::symlink_metadata(&p).unwrap().file_type().is_symlink());
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "mine");
    }

    #[test]
    fn round17_keep_both_names_like_finder_and_links_are_not_followed() {
        let s = setup();
        let g = vec![s.grant.clone()];
        std::fs::write(s.grant.join("a.tar.gz"), "").unwrap();
        assert_eq!(free_name(&s.grant, "a.tar.gz").unwrap(), s.grant.join("a.tar 2.gz"));
        assert_eq!(free_name(&s.grant, ".env").unwrap(), s.grant.join(".env 2"));
        assert_eq!(free_name(&s.grant, "folder").unwrap(), s.grant.join("folder 2"));
        // Removing a link inside the grant removes the link, not what it points at.
        remove(&g, &s.grant.join("link.txt").display().to_string()).unwrap();
        assert_eq!(std::fs::read_to_string(s.outside.join("secret.txt")).unwrap(), "outside");
        remove(&g, &s.grant.join("linkdir").display().to_string()).unwrap();
        assert!(s.outside.is_dir());
        // A target that is a link out of the grant is replaced as a link (overwrite), not followed.
        std::os::unix::fs::symlink(s.outside.join("secret.txt"), s.grant.join("planted")).unwrap();
        copy(&g, &s.grant.join("in.txt").display().to_string(), &s.grant.join("planted").display().to_string(), Conflict::Overwrite).unwrap();
        assert_eq!(std::fs::read_to_string(s.outside.join("secret.txt")).unwrap(), "outside");
        assert_eq!(std::fs::read_to_string(s.grant.join("planted")).unwrap(), "inside");
        // Recursive mkdir does not climb out through `..`.
        assert!(mkdir(&g, &format!("{}/../../x/y", s.grant.display()), true).is_err());
    }

    #[test]
    fn list_is_paged() {
        let s = setup();
        let g = vec![s.grant.clone()];
        for i in 0..5 {
            std::fs::write(s.grant.join(format!("f{i}.txt")), "").unwrap();
        }
        let first = list(&g, &s.grant.display().to_string(), &json!({ "limit": 3 })).unwrap();
        assert_eq!(first["entries"].as_array().unwrap().len(), 3);
        let next = first["next"].as_u64().unwrap();
        let rest = list(&g, &s.grant.display().to_string(), &json!({ "offset": next, "limit": 100 })).unwrap();
        assert!(rest["next"].is_null());
    }
}
