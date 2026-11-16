use std::path::{Path, PathBuf};

/// `target/<profile>/` of this build: the parent of the `build` folder that holds `OUT_DIR`
/// (`…/<profile>/build/<pkg>[-<hash>]/…/out`; the depth differs between cargo layouts).
fn profile_dir() -> Option<PathBuf> {
    let out = PathBuf::from(std::env::var_os("OUT_DIR")?);
    out.ancestors().find(|a| a.file_name().is_some_and(|n| n == "build")).and_then(Path::parent).map(Path::to_path_buf)
}

fn non_empty(p: &Path) -> bool {
    std::fs::metadata(p).map(|m| m.is_file() && m.len() > 0).unwrap_or(false)
}

fn main() {
    // Tauri refuses to build when a declared sidecar or resource folder is missing, and it copies the sidecar
    // to `target/<profile>/onedesk-worker`. `cargo clippy` and `cargo test --workspace` must work without
    // running `scripts/prepare-bundle.sh`, so a stand-in (git-ignored) is needed — but an EMPTY one would be
    // copied over the real worker. So the stand-in is a copy of the real worker when one is already built,
    // and `scripts/prepare-bundle.sh` still puts the real one there for bundling.
    let target = std::env::var("TARGET").unwrap_or_default();
    let sidecar = PathBuf::from(format!("binaries/onedesk-worker-{target}"));
    let real = profile_dir().map(|d| d.join("onedesk-worker")).filter(|p| non_empty(p));
    let _ = std::fs::create_dir_all("binaries");
    match real {
        Some(real) => {
            // Keep the stand-in identical to the real worker, so the copy Tauri makes changes nothing.
            if std::fs::read(&sidecar).ok() != std::fs::read(&real).ok() {
                let _ = std::fs::copy(&real, &sidecar);
            }
        }
        None => {
            if !sidecar.exists() {
                let _ = std::fs::write(&sidecar, b"");
            }
        }
    }
    let _ = std::fs::create_dir_all("../target/bundle-inputs/plugins");
    tauri_build::build()
}
