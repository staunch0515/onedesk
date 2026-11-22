//! The kernel commands this program uses. The names are the kernel's (docs/handoff/round19-protocol.md); change them
//! here only.

/// Lists the tools for this workspace: `{ tools: [{ name, description, inputSchema }] }`.
pub const TOOLS: &str = "mcp.tools";
/// Calls one tool: `{ name, arguments }`.
pub const CALL: &str = "mcp.call";

/// `client` of the headless connection; the kernel treats a `client` with this prefix as the operator `ai`.
pub const CLIENT_PREFIX: &str = onedesk_host::mcp_socket::CLIENT_PREFIX;
