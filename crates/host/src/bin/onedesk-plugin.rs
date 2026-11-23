//! `onedesk-plugin check <package folder | .odplugin file>` (D456): the kernel's own strict manifest check
//! for plugin authors (scripts/plugin-tool.mjs runs it). Prints one JSON line:
//! `{"ok":true,"id":…,"version":…}` (exit 0) or `{"ok":false,"reason":…,"detail":…}` (exit 1).
//! A package file is unpacked into a temporary folder first, exactly as the app does before installing.

use std::path::{Path, PathBuf};

use onedesk_host::{install, unpack};
use serde_json::json;

fn report(v: serde_json::Value, ok: bool) -> ! {
    println!("{v}");
    std::process::exit(if ok { 0 } else { 1 });
}

fn check_folder(dir: &Path) -> ! {
    if let Err(p) = install::check_package(dir, install::MAX_PACKAGE_BYTES) {
        report(json!({ "ok": false, "reason": p.reason() }), false);
    }
    match onedesk_kernel::manifest::load_package_opts(dir, false) {
        Ok(p) => report(json!({ "ok": true, "id": p.id, "version": p.version }), true),
        Err(r) => report(json!({ "ok": false, "reason": r.reason, "detail": r.detail }), false),
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let (Some("check"), Some(target)) = (args.get(1).map(String::as_str), args.get(2)) else {
        eprintln!("usage: onedesk-plugin check <package folder | .odplugin file>");
        std::process::exit(2);
    };
    let target = std::fs::canonicalize(target).unwrap_or_else(|_| PathBuf::from(target));
    if !unpack::is_package_file(&target) {
        check_folder(&target);
    }
    let tmp = std::env::temp_dir().join(format!("onedesk-plugin-check-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    let root = match unpack::unpack(&target, &tmp, install::MAX_PACKAGE_BYTES) {
        Ok(r) => r,
        Err(p) => report(json!({ "ok": false, "reason": p.reason() }), false),
    };
    // check_folder exits; clean up through a guard that runs first.
    struct Cleanup(PathBuf);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    let result = {
        let _guard = Cleanup(tmp.clone());
        install::check_package(&root, install::MAX_PACKAGE_BYTES)
            .map_err(|p| json!({ "ok": false, "reason": p.reason() }))
            .and_then(|_| onedesk_kernel::manifest::load_package_opts(&root, false).map_err(|r| json!({ "ok": false, "reason": r.reason, "detail": r.detail })))
            .map(|p| json!({ "ok": true, "id": p.id, "version": p.version }))
    };
    match result {
        Ok(v) => report(v, true),
        Err(v) => report(v, false),
    }
}
