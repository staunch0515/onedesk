//! `onedesk-devhost --data-dir <dir> --port <port> --token <token> [--plugins <dir>]`
//! Headless host for interface checks (D266): WebSocket on 127.0.0.1 only. Prints `READY`
//! on stdout when it accepts connections.

use std::path::PathBuf;

use onedesk_host::{resolve_worker_bin, ws, Host, HostConfig};

fn arg(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned()
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    let (Some(data_dir), Some(token)) = (arg(&args, "--data-dir"), arg(&args, "--token")) else {
        eprintln!("usage: onedesk-devhost --data-dir <dir> --port <port> --token <token> [--plugins <dir>]");
        std::process::exit(2);
    };
    if token.is_empty() {
        eprintln!("onedesk-devhost: --token must not be empty");
        std::process::exit(2);
    }
    let port: u16 = arg(&args, "--port").and_then(|p| p.parse().ok()).unwrap_or(0);
    let builtin = arg(&args, "--plugins").map(PathBuf::from).or_else(|| {
        let default = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../plugins");
        default.is_dir().then_some(default)
    });
    let cfg = HostConfig { data_dir: PathBuf::from(data_dir), worker_bin: resolve_worker_bin(), builtin_plugins: builtin, secrets: None };
    let host = match Host::start(cfg).await {
        Ok(h) => h,
        Err(e) => {
            eprintln!("onedesk-devhost: {e}");
            std::process::exit(1);
        }
    };
    let listener = match tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("onedesk-devhost: cannot listen on 127.0.0.1:{port}: {e}");
            std::process::exit(1);
        }
    };
    eprintln!("onedesk-devhost: listening on {:?}", listener.local_addr());
    println!("READY");
    let server = tokio::spawn(ws::serve(host.clone(), listener, token));
    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("sigterm handler");
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {}
        _ = term.recv() => {}
    }
    server.abort();
    host.shutdown().await;
}
