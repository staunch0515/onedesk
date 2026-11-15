//! Stand-in for the main process: spawns a supervised worker, prints the
//! worker pid, then idles. Used to show the worker exits when this dies.
use std::path::PathBuf;

use ks_kernel::transport::{Client, Supervisor, WorkerSpec};
use serde_json::json;

#[tokio::main]
async fn main() {
    let a: Vec<String> = std::env::args().collect();
    if a.len() != 5 {
        eprintln!("usage: mainhost <worker-bin> <workspace> <plugins> <socket>");
        std::process::exit(2);
    }
    let spec = WorkerSpec { worker_bin: PathBuf::from(&a[1]), workspace: PathBuf::from(&a[2]), plugins_dir: PathBuf::from(&a[3]), socket: PathBuf::from(&a[4]) };
    let client = Client::supervised(Supervisor::start(spec).await.expect("start worker"));
    let info = client.request("workspace.info", json!({})).await.expect("workspace.info");
    println!("worker_pid={}", info["pid"]);
    std::future::pending::<()>().await;
}
