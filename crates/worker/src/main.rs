//! Worker process: hosts the kernel for exactly one workspace (week1-protocol §2).
//!
//! `onedesk-worker --workspace <dir> --plugins <dir> --socket <path>`
//!
//! Listens on `--socket`, accepts exactly one connection (the main process), and exits with 0 when
//! it closes, after the running requests finish their transactions. Exit codes: 3 = the workspace
//! is locked by another worker; 1 = any other start-up failure (reason on stderr).

use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;
use std::time::Duration;

use onedesk_kernel::workspace::{lock_workspace, LockError};
use onedesk_kernel::{Kernel, KernelConfig};

/// How long to wait for the main process to connect before giving up.
const ACCEPT_TIMEOUT: Duration = Duration::from_secs(30);

struct Args {
    workspace: PathBuf,
    plugins: PathBuf,
    socket: PathBuf,
}

fn parse_args() -> Result<Args, String> {
    let mut workspace = None;
    let mut plugins = None;
    let mut socket = None;
    let mut it = std::env::args().skip(1);
    while let Some(a) = it.next() {
        let slot = match a.as_str() {
            "--workspace" => &mut workspace,
            "--plugins" => &mut plugins,
            "--socket" => &mut socket,
            other => return Err(format!("unknown argument {other}")),
        };
        *slot = Some(PathBuf::from(it.next().ok_or_else(|| format!("{a} needs a value"))?));
    }
    match (workspace, plugins, socket) {
        (Some(workspace), Some(plugins), Some(socket)) => Ok(Args { workspace, plugins, socket }),
        _ => Err("usage: onedesk-worker --workspace <dir> --plugins <dir> --socket <path>".into()),
    }
}

fn fail(msg: impl std::fmt::Display) -> ExitCode {
    eprintln!("onedesk-worker: {msg}");
    ExitCode::from(1)
}

fn main() -> ExitCode {
    let args = match parse_args() {
        Ok(a) => a,
        Err(e) => return fail(e),
    };
    // Held until the process ends; the OS drops it however the process ends.
    let _lock = match lock_workspace(&args.workspace) {
        Ok(f) => f,
        Err(LockError::Busy) => {
            eprintln!("onedesk-worker: workspace {} is open in another worker", args.workspace.display());
            return ExitCode::from(3);
        }
        Err(LockError::Io(e)) => return fail(format!("cannot lock {}: {e}", args.workspace.display())),
    };
    let rt = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
        Ok(rt) => rt,
        Err(e) => return fail(format!("runtime: {e}")),
    };
    rt.block_on(async move {
        let kernel = match Kernel::open(&args.workspace, &args.plugins, KernelConfig::default()) {
            Ok(k) => Arc::new(k),
            Err(e) => return fail(format!("cannot open workspace: {e}")),
        };
        let _ = std::fs::remove_file(&args.socket);
        let listener = match tokio::net::UnixListener::bind(&args.socket) {
            Ok(l) => l,
            Err(e) => return fail(format!("cannot listen on {}: {e}", args.socket.display())),
        };
        let stream = match tokio::time::timeout(ACCEPT_TIMEOUT, listener.accept()).await {
            Ok(Ok((s, _))) => s,
            Ok(Err(e)) => return fail(format!("accept: {e}")),
            Err(_) => return fail("no connection from the main process"),
        };
        // Exactly one peer: stop listening for others.
        drop(listener);
        let _ = std::fs::remove_file(&args.socket);
        onedesk_kernel::transport::serve_connection(kernel.clone(), stream).await;
        kernel.shutdown();
        ExitCode::SUCCESS
    })
}
