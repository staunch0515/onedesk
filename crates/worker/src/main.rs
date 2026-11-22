//! Worker process: hosts the kernel for exactly one workspace (week1-protocol §2).
//!
//! `onedesk-worker --workspace <dir> --plugins <dir> --socket <path> [--builtin <id>@<version>]…`
//!
//! `--ai-client <name>` (round 19): every request on the connection is that AI client's (no window,
//! no user): the headless way `onedesk-mcp` runs when the application is closed.
//!
//! `--builtin` (repeatable, D313): built-in packages the main process copied; only these are
//! confirmed without asking.
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
    builtin: Vec<String>,
    ai_client: Option<String>,
}

fn parse_args() -> Result<Args, String> {
    let mut workspace = None;
    let mut plugins = None;
    let mut socket = None;
    let mut builtin = Vec::new();
    let mut ai_client = None;
    let mut it = std::env::args().skip(1);
    while let Some(a) = it.next() {
        if a == "--builtin" {
            let v = it.next().ok_or("--builtin needs a value")?;
            if !v.contains('@') {
                return Err(format!("--builtin expects <id>@<version>, got {v}"));
            }
            builtin.push(v);
            continue;
        }
        if a == "--ai-client" {
            ai_client = Some(it.next().ok_or("--ai-client needs a value")?);
            continue;
        }
        let slot = match a.as_str() {
            "--workspace" => &mut workspace,
            "--plugins" => &mut plugins,
            "--socket" => &mut socket,
            other => return Err(format!("unknown argument {other}")),
        };
        *slot = Some(PathBuf::from(it.next().ok_or_else(|| format!("{a} needs a value"))?));
    }
    match (workspace, plugins, socket) {
        (Some(workspace), Some(plugins), Some(socket)) => Ok(Args { workspace, plugins, socket, builtin, ai_client }),
        _ => Err("usage: onedesk-worker --workspace <dir> --plugins <dir> --socket <path> [--builtin <id>@<version>]… [--ai-client <name>]".into()),
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
    // D340: a panic on the main thread ends the programs listed for this workspace before the
    // process goes (panics inside tasks are caught and do not end the worker).
    let ws_for_panic = args.workspace.clone();
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        if std::thread::current().name() == Some("main") {
            onedesk_kernel::process::cleanup_recorded(&ws_for_panic);
        }
        default_hook(info);
    }));
    let rt = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
        Ok(rt) => rt,
        Err(e) => return fail(format!("runtime: {e}")),
    };
    rt.block_on(async move {
        let mut cfg = KernelConfig { builtin: args.builtin.clone(), plugin_idle: plugin_idle(), ai_only: args.ai_client.clone(), ..KernelConfig::default() };
        test_hooks(&mut cfg, |k| std::env::var(k).ok());
        // Round 9: listen before opening the workspace. With thousands of plugin packages opening
        // takes seconds; the main process may connect meanwhile (the connection waits in the
        // backlog) and its `hello` is answered once the kernel is ready.
        let _ = std::fs::remove_file(&args.socket);
        let listener = match tokio::net::UnixListener::bind(&args.socket) {
            Ok(l) => l,
            Err(e) => return fail(format!("cannot listen on {}: {e}", args.socket.display())),
        };
        let kernel = match Kernel::open(&args.workspace, &args.plugins, cfg) {
            Ok(k) => Arc::new(k),
            Err(e) => {
                let _ = std::fs::remove_file(&args.socket);
                return fail(format!("cannot open workspace: {e}"));
            }
        };
        let stream = match tokio::time::timeout(ACCEPT_TIMEOUT, listener.accept()).await {
            Ok(Ok((s, _))) => s,
            Ok(Err(e)) => return fail(format!("accept: {e}")),
            Err(_) => return fail("no connection from the main process"),
        };
        // Exactly one peer: stop listening for others.
        drop(listener);
        let _ = std::fs::remove_file(&args.socket);
        // D340: SIGTERM / SIGHUP end the programs it started before it exits.
        use tokio::signal::unix::{signal, SignalKind};
        let (Ok(mut term), Ok(mut hup)) = (signal(SignalKind::terminate()), signal(SignalKind::hangup())) else {
            return fail("cannot install signal handlers");
        };
        tokio::select! {
            _ = onedesk_kernel::transport::serve_connection(kernel.clone(), stream) => {}
            _ = term.recv() => eprintln!("onedesk-worker: SIGTERM"),
            _ = hup.recv() => eprintln!("onedesk-worker: SIGHUP"),
        }
        kernel.shutdown();
        ExitCode::SUCCESS
    })
}

/// Round 17 (X18): tests and acceptance never touch the real Trash or open Finder.
/// D433 (review #13): `ONEDESK_TRASH_DIR` and `ONEDESK_OPEN_LOG` count only with `ONEDESK_TEST_HOOKS=1`.
/// Returns whether the hooks were on.
fn test_hooks(cfg: &mut KernelConfig, var: impl Fn(&str) -> Option<String>) -> bool {
    if var("ONEDESK_TEST_HOOKS").as_deref() != Some("1") {
        return false;
    }
    if let Some(d) = var("ONEDESK_TRASH_DIR").filter(|v| !v.is_empty()) {
        cfg.trash_dir = Some(std::path::PathBuf::from(d));
    }
    if let Some(log) = var("ONEDESK_OPEN_LOG").filter(|v| !v.is_empty()) {
        cfg.opener = onedesk_kernel::Opener::log_to(std::path::PathBuf::from(log));
    }
    true
}

/// D365: `ONEDESK_PLUGIN_IDLE_MS` (tests and acceptance only; at least 1000) or the default.
fn plugin_idle() -> std::time::Duration {
    std::env::var("ONEDESK_PLUGIN_IDLE_MS")
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .map(|ms| std::time::Duration::from_millis(ms.max(1000)))
        .unwrap_or(onedesk_kernel::DEFAULT_PLUGIN_IDLE)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn review13_test_hooks_need_onedesk_test_hooks() {
        let env = |hooks: Option<&'static str>| {
            move |k: &str| match k {
                "ONEDESK_TEST_HOOKS" => hooks.map(String::from),
                "ONEDESK_TRASH_DIR" => Some("/tmp/t".to_string()),
                "ONEDESK_OPEN_LOG" => Some("/tmp/o.log".to_string()),
                _ => None,
            }
        };
        let mut cfg = KernelConfig::default();
        assert!(!test_hooks(&mut cfg, env(None)));
        assert!(!test_hooks(&mut cfg, env(Some("yes"))));
        assert_eq!(cfg.trash_dir, None, "the system Trash");
        assert!(test_hooks(&mut cfg, env(Some("1"))));
        assert_eq!(cfg.trash_dir, Some(std::path::PathBuf::from("/tmp/t")));
    }
}
