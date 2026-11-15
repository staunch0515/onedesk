//! Worker process: hosts the kernel for exactly one workspace.
//! Exit codes: 0 main side went away / asked us to stop; 2 bad usage or
//! start-up failure; 3 workspace already open in another worker.
use std::path::PathBuf;
use std::time::Instant;

use ks_kernel::kernel::Kernel;
use ks_kernel::sandbox::SandboxConfig;
use ks_kernel::transport::serve_connection;
use ks_kernel::{config_from_env, lock_workspace};

fn arg(name: &str) -> Option<PathBuf> {
    let mut it = std::env::args();
    while let Some(a) = it.next() {
        if a == name {
            return it.next().map(PathBuf::from);
        }
    }
    None
}

fn main() {
    let t0 = Instant::now();
    let (Some(workspace), Some(plugins), Some(socket)) = (arg("--workspace"), arg("--plugins"), arg("--socket")) else {
        eprintln!("usage: worker --workspace <dir> --plugins <dir> --socket <path>");
        std::process::exit(2);
    };
    // The OS drops the lock when this process ends, however it ends.
    let _lock = match lock_workspace(&workspace) {
        Ok(Some(f)) => f,
        Ok(None) => {
            eprintln!("workspace is already open in another worker");
            std::process::exit(3);
        }
        Err(e) => {
            eprintln!("cannot lock workspace: {e}");
            std::process::exit(2);
        }
    };
    let lock_ms = t0.elapsed().as_secs_f64() * 1000.0;
    let cfg: SandboxConfig = config_from_env();
    let kernel = match Kernel::open(&workspace, &plugins, cfg) {
        Ok(k) => k,
        Err(e) => {
            eprintln!("cannot open workspace: {e}");
            std::process::exit(2);
        }
    };
    let opened_ms = t0.elapsed().as_secs_f64() * 1000.0;
    let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(4).enable_all().build().expect("tokio runtime");
    let code = rt.block_on(async move {
        let _ = std::fs::remove_file(&socket);
        let listener = match tokio::net::UnixListener::bind(&socket) {
            Ok(l) => l,
            Err(e) => {
                eprintln!("cannot bind {}: {e}", socket.display());
                return 2;
            }
        };
        let listening_ms = t0.elapsed().as_secs_f64() * 1000.0;
        kernel.set_boot_info(serde_json::json!({ "lockMs": lock_ms, "dbOpenedMs": opened_ms, "listeningMs": listening_ms }));
        // Exactly one peer: the main process. When it disappears, so do we.
        match tokio::time::timeout(std::time::Duration::from_secs(10), listener.accept()).await {
            Ok(Ok((stream, _))) => {
                serve_connection(kernel, stream).await;
                0
            }
            _ => 2,
        }
    });
    std::process::exit(code);
}
