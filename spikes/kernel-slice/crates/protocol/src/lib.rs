//! Protocol types: the single source of truth. TypeScript types are generated
//! from these with ts-rs (see `tests/export.rs` and `scripts/check-types.sh`).
use serde::{Deserialize, Serialize};
use ts_rs::TS;

pub const PROTOCOL_VERSION: u32 = 1;

/// `{ id, method, params }`
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Request {
    pub id: u64,
    pub method: String,
    #[serde(default)]
    pub params: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct RpcError {
    pub code: ErrorCode,
    /// User readable message (Chinese in the real product).
    pub message: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS, PartialEq, Eq)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub enum ErrorCode {
    UnknownMethod,
    BadParams,
    NotFound,
    PluginError,
    PluginTimeout,
    PluginOutOfMemory,
    Cancelled,
    InvalidView,
    WorkerGone,
    VersionMismatch,
    Internal,
}

/// `{ id, result | error }`
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Response {
    pub id: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub result: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub error: Option<RpcError>,
}

/// Server pushed event: `{ event, payload }` (no `id`).
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq)]
#[ts(export)]
pub struct Event {
    pub event: String,
    pub payload: serde_json::Value,
}

/// One line on the wire, server → client.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ServerMessage {
    Response(Response),
    Event(Event),
}

// ---------- method params / results ----------

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct HelloParams {
    pub protocol_version: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInfo {
    pub protocol_version: u32,
    pub pid: u32,
    pub resource_count: u64,
    pub activated_plugins: Vec<String>,
    /// Milliseconds spent inside the kernel opening the database.
    pub open_ms: f64,
    /// Worker start-up phases (null in single-process mode).
    pub boot: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct TreePageParams {
    #[ts(optional)]
    pub parent: Option<i64>,
    pub offset: u32,
    pub limit: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct TreeNode {
    pub id: i64,
    pub kind: String,
    pub name: String,
    pub has_children: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct TreePage {
    pub nodes: Vec<TreeNode>,
    pub total: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct PageOpenParams {
    pub resource_id: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct PageOpenResult {
    pub view: ViewNode,
    pub node_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct RecomputeParams {
    pub resource_id: i64,
    /// Unsaved field values keyed by bind path, e.g. `{"body.sql": "..."}`.
    pub unsaved: std::collections::BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq)]
#[ts(export)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ParamDef {
    pub name: String,
    #[serde(rename = "type")]
    pub ty: FieldType,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct RecomputeResult {
    pub params: Vec<ParamDef>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct PageEventParams {
    pub resource_id: i64,
    pub event: String,
    #[serde(default)]
    pub payload: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct CancelParams {
    pub request_id: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct RenameParams {
    pub resource_id: i64,
    pub name: String,
}

// ---------- view tree (kernel-design §9.3) ----------

/// The four basic nodes plus a container.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq)]
#[ts(export)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase", deny_unknown_fields)]
pub enum ViewNode {
    Stack {
        children: Vec<ViewNode>,
    },
    Form {
        fields: Vec<Field>,
    },
    Table {
        columns: Vec<Column>,
        rows: Vec<Vec<serde_json::Value>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        on_row: Option<String>,
    },
    Text {
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        tone: Option<Tone>,
    },
    Link {
        label: String,
        href: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq)]
#[ts(export)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Field {
    pub name: String,
    pub label: String,
    #[serde(rename = "type")]
    pub ty: FieldType,
    /// e.g. `body.sql`: this field edits that part of the resource.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub bind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub value: Option<serde_json::Value>,
    #[serde(default)]
    pub fill: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS, PartialEq, Eq)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub enum FieldType {
    Text,
    Code,
    Number,
    Boolean,
    Date,
    Time,
    Enum,
    Resource,
    Secret,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS, PartialEq, Eq)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub enum Tone {
    Normal,
    Error,
    Muted,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq)]
#[ts(export)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Column {
    pub key: String,
    pub title: String,
}

impl ViewNode {
    /// Counts view nodes, fields and columns; also enforces structural rules
    /// serde cannot express.
    pub fn validate(&self) -> Result<u32, String> {
        fn walk(n: &ViewNode, depth: u32) -> Result<u32, String> {
            if depth > 32 {
                return Err("view tree too deep".into());
            }
            Ok(match n {
                ViewNode::Stack { children } => {
                    let mut c = 1;
                    for ch in children {
                        c += walk(ch, depth + 1)?;
                    }
                    c
                }
                ViewNode::Form { fields } => {
                    for f in fields {
                        if f.name.is_empty() {
                            return Err("field without name".into());
                        }
                        if let Some(b) = &f.bind {
                            if !b.starts_with("body.") {
                                return Err(format!("bad bind path: {b}"));
                            }
                        }
                    }
                    1 + fields.len() as u32
                }
                ViewNode::Table { columns, rows, .. } => {
                    for r in rows {
                        if r.len() != columns.len() {
                            return Err("table row width mismatch".into());
                        }
                    }
                    1 + columns.len() as u32
                }
                ViewNode::Text { .. } => 1,
                ViewNode::Link { href, .. } => {
                    if !(href.starts_with("http://")
                        || href.starts_with("https://")
                        || href.starts_with("mailto:"))
                    {
                        return Err(format!("link scheme not allowed: {href}"));
                    }
                    1
                }
            })
        }
        let n = walk(self, 0)?;
        if n > 5000 {
            return Err("view tree too large".into());
        }
        Ok(n)
    }
}
