//! OneDesk kernel (kernel-design §3–§5, §7.4–7.5, §9, §12). No Tauri, no interface text, and no
//! knowledge of any particular plugin: it knows resources, plugins and views.

pub mod blobs;
mod calls;
mod carry;
pub mod datafile;
mod commands;
pub mod deps;
mod install;
pub mod events;
pub mod process;
pub mod files;
mod host;
mod i18n;
pub mod kernel;
mod kind_children;
pub mod mcp;
pub mod workspace_settings;
pub mod manifest;
mod pages;
mod reach;
pub mod params;
mod round2;
pub(crate) mod round18;
mod runs;
mod subtree;
pub mod network;
pub mod secrets;
mod versions;
pub mod pipeline;
pub mod policy;
pub mod refs;
pub mod sandbox;
pub mod store;
pub mod transfer;
pub mod transport;
pub mod util;
pub mod workspace;

pub use kernel::{Kernel, KernelConfig, Opener, DEFAULT_PLUGIN_IDLE};
pub use sandbox::SandboxConfig;
