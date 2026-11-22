//! `onedesk-mcp`: the command-line program that lets an external AI client (Claude Desktop, …) use OneDesk read-only
//! (round 19, D415). It speaks MCP (JSON-RPC, one message per line) on standard input/output, never opens a network
//! port, and knows no plugin: the tool list and every call come from the kernel's `mcp.*` commands.
//!
//! Where the kernel is: with the app open it is the main process, reached on a local socket (`onedesk_host::mcp_socket`);
//! otherwise the program starts a headless `onedesk-worker` itself and lets it go after a few idle seconds.

pub mod backend;
pub mod headless;
pub mod line_conn;
pub mod names;
pub mod server;
pub mod socket;

pub use backend::{Auto, Backend, BackendError};
pub use server::serve;
