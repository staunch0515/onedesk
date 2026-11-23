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
    /// Any link at all (D312): a package is plain files and folders.
    Symlink,
    TooBig,
}

impl Problem {
    pub fn reason(&self) -> &'static str {
        match self {
            Problem::NotAbsolute => "notAbsolute",
            Problem::NotFolder => "notFolder",
            Problem::NoManifest => "noManifest",
            Problem::Symlink => "symlink",
            Problem::TooBig => "tooBig",
        }
    }
}

pub fn safe_segment(s: &str) -> bool {
    !s.is_empty() && s != "." && s != ".." && !s.contains(['/', '\\', '\0']) && !s.starts_with('.')
}

/// Looks at a package folder without copying it: a real folder with a readable manifest, no
/// symbolic link anywhere inside, at most `limit` bytes.
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
    let mut total = 0u64;
    walk(root, limit, &mut total)
}

fn walk(dir: &Path, limit: u64, total: &mut u64) -> Result<(), Problem> {
    let entries = std::fs::read_dir(dir).map_err(|_| Problem::NotFolder)?;
    for entry in entries {
        let entry = entry.map_err(|_| Problem::NotFolder)?;
        let path = entry.path();
        let meta = std::fs::symlink_metadata(&path).map_err(|_| Problem::NotFolder)?;
        if meta.file_type().is_symlink() {
            return Err(Problem::Symlink);
        } else if meta.is_dir() {
            walk(&path, limit, total)?;
        } else {
            *total += meta.len();
        }
        if *total > limit {
            return Err(Problem::TooBig);
        }
    }
    Ok(())
}

/// Copies a package without following links: a link is refused (the check already did, this is the
/// second line of defence against a package that changed in between).
pub fn copy_package(src: &Path, dest: &Path) -> io::Result<()> {
    std::fs::create_dir_all(dest)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        if onedesk_kernel::util::is_junk_name(&entry.file_name()) {
            continue;
        }
        let from = entry.path();
        let to = dest.join(entry.file_name());
        let meta = std::fs::symlink_metadata(&from)?;
        if meta.file_type().is_symlink() {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "package contains a link"));
        } else if meta.is_dir() {
            copy_package(&from, &to)?;
        } else {
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

/// `<plugins>/.tmp`: where packages are copied before the final rename and checked once more.
pub fn tmp_dir(plugin_root: &Path) -> PathBuf {
    plugin_root.join(".tmp")
}

/// `<plugins>/.removed`: removed versions are moved here, never deleted.
pub fn removed_dir(plugin_root: &Path) -> PathBuf {
    plugin_root.join(".removed")
}

/// Moves `<plugins>/<id>/<version>` to `.removed/<id>/<version>-<millis>`. The folder is exact, so a
/// plugin id like `x-1.2.3` cannot be mistaken for version `1.2.3` of plugin `x`.
pub fn remove_version(plugin_root: &Path, id: &str, version: &str) -> io::Result<PathBuf> {
    let src = plugin_root.join(id).join(version);
    if !src.is_dir() {
        return Err(io::Error::new(io::ErrorKind::NotFound, "not installed"));
    }
    let trash = removed_dir(plugin_root).join(id);
    std::fs::create_dir_all(&trash)?;
    let millis = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let dest = trash.join(format!("{version}-{millis}"));
    std::fs::rename(&src, &dest)?;
    Ok(dest)
}

/// Whether exactly `<id>@<version>` was removed by the user (so the next start must not put a built-in copy back).
pub fn was_removed(plugin_root: &Path, id: &str, version: &str) -> bool {
    let Ok(entries) = std::fs::read_dir(removed_dir(plugin_root).join(id)) else { return false };
    entries.filter_map(|e| e.ok()).any(|e| {
        let name = e.file_name().to_string_lossy().into_owned();
        name.rsplit_once('-').is_some_and(|(v, millis)| v == version && !millis.is_empty() && millis.bytes().all(|b| b.is_ascii_digit()))
    })
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
    fn copy_leaves_appledouble_and_ds_store_behind() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("pkg");
        package(&src);
        std::fs::create_dir_all(src.join("locales")).unwrap();
        std::fs::write(src.join("locales/en-US.json"), "{}").unwrap();
        std::fs::write(src.join("._main.js"), [0xffu8, 0xfe]).unwrap();
        std::fs::write(src.join("._manifest.json"), [0xffu8]).unwrap();
        std::fs::write(src.join("locales/._en-US.json"), [0xffu8]).unwrap();
        std::fs::write(src.join(".DS_Store"), [0u8]).unwrap();
        let dest = tmp.path().join("out");
        copy_package(&src, &dest).unwrap();
        assert!(dest.join("main.js").is_file() && dest.join("locales/en-US.json").is_file());
        for junk in ["._main.js", "._manifest.json", "locales/._en-US.json", ".DS_Store"] {
            assert!(!dest.join(junk).exists(), "{junk}");
        }
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
    fn refuses_any_link_inside_a_package() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("pkg");
        package(&src);
        // Even a link that stays inside the package.
        std::os::unix::fs::symlink(src.join("main.js"), src.join("alias.js")).unwrap();
        assert_eq!(check_package(&src, MAX_PACKAGE_BYTES), Err(Problem::Symlink));
        // Pointing outside, or at a folder: the same answer.
        std::fs::remove_file(src.join("alias.js")).unwrap();
        let outside = tmp.path().join("secret.txt");
        std::fs::write(&outside, "secret").unwrap();
        std::os::unix::fs::symlink(&outside, src.join("leak.txt")).unwrap();
        assert_eq!(check_package(&src, MAX_PACKAGE_BYTES), Err(Problem::Symlink));
        std::fs::remove_file(src.join("leak.txt")).unwrap();
        std::fs::create_dir_all(src.join("dir")).unwrap();
        std::os::unix::fs::symlink(src.join("dir"), src.join("dirlink")).unwrap();
        assert_eq!(check_package(&src, MAX_PACKAGE_BYTES), Err(Problem::Symlink));
    }

    #[test]
    fn copy_never_follows_a_link_even_if_one_appears_after_the_check() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("pkg");
        package(&src);
        assert_eq!(check_package(&src, MAX_PACKAGE_BYTES), Ok(()));
        let outside = tmp.path().join("secret.txt");
        std::fs::write(&outside, "secret").unwrap();
        std::os::unix::fs::symlink(&outside, src.join("late.txt")).unwrap();
        assert!(copy_package(&src, &tmp.path().join("out")).is_err());
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
    fn removal_moves_to_the_removed_folder_and_is_remembered_exactly() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        package(&root.join("org.x.alpha").join("0.1.0"));
        package(&root.join("x-1.2.3").join("0.1.0"));
        assert!(!was_removed(root, "org.x.alpha", "0.1.0"));
        let moved = remove_version(root, "org.x.alpha", "0.1.0").unwrap();
        assert!(moved.is_dir() && !root.join("org.x.alpha/0.1.0").exists());
        assert!(was_removed(root, "org.x.alpha", "0.1.0"));
        assert!(!was_removed(root, "org.x.alpha", "0.2.0"));
        assert!(remove_version(root, "org.x.alpha", "0.1.0").is_err());
        // An id that looks like another plugin's id and version does not collide.
        assert!(!was_removed(root, "x", "1.2.3"));
        remove_version(root, "x-1.2.3", "0.1.0").unwrap();
        assert!(was_removed(root, "x-1.2.3", "0.1.0"));
        assert!(!was_removed(root, "x", "1.2.3-0.1.0"));
        // A version with a dash is matched whole.
        package(&root.join("org.x.beta").join("1.0.0-beta"));
        remove_version(root, "org.x.beta", "1.0.0-beta").unwrap();
        assert!(was_removed(root, "org.x.beta", "1.0.0-beta"));
        assert!(!was_removed(root, "org.x.beta", "1.0.0"));
    }
}
