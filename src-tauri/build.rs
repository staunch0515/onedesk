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
    // Round 19: `onedesk-mcp` is a sidecar like the worker, handled the same way.
    let target = std::env::var("TARGET").unwrap_or_default();
    let _ = std::fs::create_dir_all("binaries");
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=tauri.conf.json");
    println!("cargo:rerun-if-changed=capabilities");
    for name in ["onedesk-worker", "onedesk-mcp"] {
        let sidecar = PathBuf::from(format!("binaries/{name}-{target}"));
        let real = profile_dir().map(|d| d.join(name)).filter(|p| non_empty(p));
        match real {
            Some(real) => {
                // Rerun when the program is linked again, so the stand-in follows it and Tauri's copy never puts an
                // older one over a newer one. Tauri does not write the file when the content is identical, so our own
                // copy does not make this rerun forever. (Setting any rerun-if-changed replaces cargo's default "any
                // file of the package", so the files that matter are named too.)
                println!("cargo:rerun-if-changed={}", real.display());
                // Keep the stand-in identical to the real one, so the copy Tauri makes changes nothing.
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
    }
    let _ = std::fs::create_dir_all("../target/bundle-inputs/plugins");
    tauri_build::build()
}
