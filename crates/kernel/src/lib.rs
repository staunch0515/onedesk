//! OneDesk kernel (kernel-design §3–§5, §7.4–7.5, §9, §12). No Tauri, no interface text, and no
//! knowledge of any particular plugin: it knows resources, plugins and views.

mod commands;
pub mod files;
mod host;
pub mod kernel;
pub mod manifest;
mod pages;
pub mod params;
mod round2;
mod runs;
pub mod network;
pub mod secrets;
mod versions;
pub mod pipeline;
pub mod sandbox;
pub mod store;
pub mod transport;
pub mod util;
pub mod workspace;

pub use kernel::{Kernel, KernelConfig};
pub use sandbox::SandboxConfig;
