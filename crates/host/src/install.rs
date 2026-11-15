//! Installing and removing plugin packages (round 4, §2.1): only the main process copies or moves
//! plugin files; the worker reads them. Everything here is plain file work and knows no plugin.

use std::io;
use std::path::{Path, PathBuf};

/// Packages larger than this are refused before anything is copied.
pub const MAX_PACKAGE_BYTES: u64 = 200 * 1024 * 1024;

/// Why a package folder is refused (the `reason` of an `invalid` error).
#[derive(Debug, PartialEq, Eq)]
pub enum Problem {
    NotAbsolute,
    NotFolder,
    NoManifest,
    SymlinkOutside,
    SymlinkFolder,
    TooBig,
}

impl Problem {
    pub fn reason(&self) -> &'static str {
        match self {
            Problem::NotAbsolute => "notAbsolute",
            Problem::NotFolder => "notFolder",
            Problem::NoManifest => "noManifest",
            Problem::SymlinkOutside => "symlinkOutside",
            Problem::SymlinkFolder => "symlinkFolder",
            Problem::TooBig => "tooBig",
        }
    }
}

pub fn safe_segment(s: &str) -> bool {
    !s.is_empty() && s != "." && s != ".." && !s.contains(['/', '\\', '\0']) && !s.starts_with('.')
}

/// Looks at a package folder without copying it: a real folder with a readable manifest, no
/// symbolic link that leaves the package (or points at a folder), at most `limit` bytes.
pub fn check_package(root: &Path, limit: u64) -> Result<(), Problem> {
    if !root.is_absolute() {
        return Err(Problem::NotAbsolute);
    }
    let meta = std::fs::symlink_metadata(root).map_err(|_| Problem::NotFolder)?;
    if !meta.is_dir() {
        return Err(Problem::NotFolder);
    }
    if std::fs::read_to_string(root.join("manifest.json")).is_err() {
        return Err(Problem::NoManifest);
    }
    let canonical = std::fs::canonicalize(root).map_err(|_| Problem::NotFolder)?;
    let mut total = 0u64;
    walk(root, &canonical, limit, &mut total)
}

fn walk(dir: &Path, canonical_root: &Path, limit: u64, total: &mut u64) -> Result<(), Problem> {
    let entries = std::fs::read_dir(dir).map_err(|_| Problem::NotFolder)?;
    for entry in entries {
        let entry = entry.map_err(|_| Problem::NotFolder)?;
        let path = entry.path();
        let meta = std::fs::symlink_metadata(&path).map_err(|_| Problem::NotFolder)?;
        if meta.file_type().is_symlink() {
            let target = std::fs::canonicalize(&path).map_err(|_| Problem::SymlinkOutside)?;
            if !target.starts_with(canonical_root) {
                return Err(Problem::SymlinkOutside);
            }
            if target.is_dir() {
                return Err(Problem::SymlinkFolder);
            }
            *total += std::fs::metadata(&target).map(|m| m.len()).unwrap_or(0);
        } else if meta.is_dir() {
            walk(&path, canonical_root, limit, total)?;
        } else {
            *total += meta.len();
        }
        if *total > limit {
            return Err(Problem::TooBig);
        }
    }
    Ok(())
}

/// Copies a checked package; links inside it are copied as the files they point to.
pub fn copy_package(src: &Path, dest: &Path) -> io::Result<()> {
    std::fs::create_dir_all(dest)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        let to = dest.join(entry.file_name());
        let meta = std::fs::metadata(&from)?; // follows a link to a file
        if meta.is_dir() {
            copy_package(&from, &to)?;
        } else {
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

/// `<plugins>/.removed`: removed versions are moved here, never deleted.
pub fn removed_dir(plugin_root: &Path) -> PathBuf {
    plugin_root.join(".removed")
}

/// Moves `<plugins>/<id>/<version>` to `.removed/<id>-<version>-<millis>`.
pub fn remove_version(plugin_root: &Path, id: &str, version: &str) -> io::Result<PathBuf> {
    let src = plugin_root.join(id).join(version);
    if !src.is_dir() {
        return Err(io::Error::new(io::ErrorKind::NotFound, "not installed"));
    }
    let trash = removed_dir(plugin_root);
    std::fs::create_dir_all(&trash)?;
    let millis = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let dest = trash.join(format!("{id}-{version}-{millis}"));
    std::fs::rename(&src, &dest)?;
    Ok(dest)
}

/// Whether a built-in version was removed by the user (so the next start must not put it back).
pub fn was_removed(plugin_root: &Path, id: &str, version: &str) -> bool {
    let prefix = format!("{id}-{version}-");
    std::fs::read_dir(removed_dir(plugin_root)).map(|rd| rd.filter_map(|e| e.ok()).any(|e| e.file_name().to_string_lossy().starts_with(&prefix))).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn package(root: &Path) {
        std::fs::create_dir_all(root).unwrap();
        std::fs::write(root.join("manifest.json"), "{}").unwrap();
        std::fs::write(root.join("main.js"), "export default {};").unwrap();
    }

    #[test]
    fn accepts_a_plain_package_and_copies_it() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("pkg");
        package(&src);
        std::fs::create_dir_all(src.join("locales")).unwrap();
        std::fs::write(src.join("locales/en-US.json"), "{}").unwrap();
        assert_eq!(check_package(&src, MAX_PACKAGE_BYTES), Ok(()));
        let dest = tmp.path().join("out");
        copy_package(&src, &dest).unwrap();
        assert!(dest.join("locales/en-US.json").is_file() && dest.join("main.js").is_file());
    }

    #[test]
    fn refuses_what_is_not_a_package_folder() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(check_package(Path::new("relative/path"), MAX_PACKAGE_BYTES), Err(Problem::NotAbsolute));
        assert_eq!(check_package(&tmp.path().join("missing"), MAX_PACKAGE_BYTES), Err(Problem::NotFolder));
        let file = tmp.path().join("file.txt");
        std::fs::write(&file, "x").unwrap();
        assert_eq!(check_package(&file, MAX_PACKAGE_BYTES), Err(Problem::NotFolder));
        let empty = tmp.path().join("empty");
        std::fs::create_dir_all(&empty).unwrap();
        assert_eq!(check_package(&empty, MAX_PACKAGE_BYTES), Err(Problem::NoManifest));
    }

    #[test]
    fn refuses_links_that_leave_the_package_or_point_at_folders() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("pkg");
        package(&src);
        let outside = tmp.path().join("secret.txt");
        std::fs::write(&outside, "secret").unwrap();
        std::os::unix::fs::symlink(&outside, src.join("leak.txt")).unwrap();
        assert_eq!(check_package(&src, MAX_PACKAGE_BYTES), Err(Problem::SymlinkOutside));
        std::fs::remove_file(src.join("leak.txt")).unwrap();
        // A link to a file inside is fine and is copied as a file.
        std::os::unix::fs::symlink(src.join("main.js"), src.join("alias.js")).unwrap();
        assert_eq!(check_package(&src, MAX_PACKAGE_BYTES), Ok(()));
        let dest = tmp.path().join("out");
        copy_package(&src, &dest).unwrap();
        assert!(!std::fs::symlink_metadata(dest.join("alias.js")).unwrap().file_type().is_symlink());
        // A link to a folder is not.
        std::fs::create_dir_all(src.join("dir")).unwrap();
        std::os::unix::fs::symlink(src.join("dir"), src.join("dirlink")).unwrap();
        assert_eq!(check_package(&src, MAX_PACKAGE_BYTES), Err(Problem::SymlinkFolder));
    }

    #[test]
    fn refuses_oversized_packages() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("pkg");
        package(&src);
        std::fs::write(src.join("big.bin"), vec![0u8; 5000]).unwrap();
        assert_eq!(check_package(&src, 1000), Err(Problem::TooBig));
        assert_eq!(check_package(&src, 1_000_000), Ok(()));
    }

    #[test]
    fn removal_moves_to_the_removed_folder_and_is_remembered() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        package(&root.join("org.x.alpha").join("0.1.0"));
        assert!(!was_removed(root, "org.x.alpha", "0.1.0"));
        let moved = remove_version(root, "org.x.alpha", "0.1.0").unwrap();
        assert!(moved.is_dir() && !root.join("org.x.alpha/0.1.0").exists());
        assert!(was_removed(root, "org.x.alpha", "0.1.0"));
        assert!(!was_removed(root, "org.x.alpha", "0.2.0"));
        assert!(remove_version(root, "org.x.alpha", "0.1.0").is_err());
    }
}
