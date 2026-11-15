fn main() {
    // Tauri refuses to build when a declared sidecar or resource folder is missing. `cargo clippy` and
    // `cargo test --workspace` must work without running `scripts/prepare-bundle.sh`, so leave empty
    // stand-ins (git-ignored); the script replaces them with the real worker and plugins.
    let target = std::env::var("TARGET").unwrap_or_default();
    let sidecar = std::path::PathBuf::from(format!("binaries/onedesk-worker-{target}"));
    if !sidecar.exists() {
        let _ = std::fs::create_dir_all("binaries");
        let _ = std::fs::write(&sidecar, b"");
    }
    let _ = std::fs::create_dir_all("../target/bundle-inputs/plugins");
    tauri_build::build()
}
