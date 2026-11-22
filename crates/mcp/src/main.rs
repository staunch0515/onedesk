//! `onedesk-mcp [--workspace <id|name|folder>] [--data-dir <dir>] [--print-config]`
//!
//! Standard input/output only; no network port. Without `--workspace` it uses the default workspace (the one the app
//! opens). `--print-config` prints the entry for Claude Desktop's `claude_desktop_config.json` and exits.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use onedesk_host::{default_data_dir, resolve_worker_bin};
use onedesk_mcp::backend::{Auto, AutoConfig};
use serde_json::json;

fn arg(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned()
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    let workspace = arg(&args, "--workspace").filter(|w| !w.is_empty());
    if args.iter().any(|a| a == "--print-config") {
        let exe = std::env::current_exe().unwrap_or_default();
        let mut entry = json!({ "command": exe.to_string_lossy() });
        if let Some(w) = &workspace {
            entry["args"] = json!(["--workspace", w]);
        }
        println!("{}", serde_json::to_string_pretty(&json!({ "mcpServers": { "onedesk": entry } })).expect("json"));
        return;
    }
    if args.iter().any(|a| a == "--help" || a == "-h") {
        eprintln!("usage: onedesk-mcp [--workspace <id|name|folder>] [--data-dir <dir>] [--print-config]");
        return;
    }
    let idle = std::env::var("ONEDESK_MCP_IDLE_MS").ok().and_then(|v| v.parse::<u64>().ok()).map(Duration::from_millis).unwrap_or(Duration::from_secs(5));
    let backend = Auto::new(AutoConfig {
        data_dir: arg(&args, "--data-dir").map(PathBuf::from).unwrap_or_else(default_data_dir),
        workspace,
        worker_bin: resolve_worker_bin(),
        client_name: onedesk_mcp::server::session_name(None),
        builtin_plugins: onedesk_host::plugins::bundled_dir(),
        idle,
        lock_wait: Duration::from_secs(30),
    });
    let stdin = tokio::io::BufReader::new(tokio::io::stdin());
    onedesk_mcp::serve(Arc::new(backend), stdin, tokio::io::stdout()).await;
}
