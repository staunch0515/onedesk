//! Round 19 (D448): the AI actor. An AI client (MCP) reaches the kernel through `mcp.tools` and
//! `mcp.call` only; every other request is refused (`gate`). The kernel knows no particular plugin:
//! the tools beyond the four general ones are whatever manifests declare (`aiTools`).
//! Names, fields, limits: `docs/handoff/round19-protocol.md`.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use onedesk_protocol::*;
use serde_json::{json, Value};

use crate::kernel::Inner;
use crate::manifest::{AiToolDecl, ActionDef, Plugin};
use crate::pipeline::{Actor, Command};
use crate::reach::SearchOpts;
use crate::sandbox::CallInfo;
use crate::store::{self, Row};
use crate::util::*;

pub const P_ENABLED: &str = "mcp.enabled";
pub const P_RATE: &str = "mcp.rate_per_minute";
pub const P_MAX_ROWS: &str = "mcp.max_rows";
pub const P_FREE_QUERY: &str = "mcp.allow_free_query";
pub const P_ENV: &str = "mcp.env";
/// D487 §29: whether an AI client may propose changes (it never writes them; off until the user turns it on).
pub const P_PROPOSE: &str = "mcp.allow_proposals";
/// Most nodes of one `tree` page.
const TREE_PAGE: usize = 500;

pub const DEFAULT_RATE: u32 = 30;
/// D479: the client name of the writing help's tool calls (audited like an outside client's).
pub const CHAT_CLIENT: &str = "onedesk-chat";
pub const DEFAULT_MAX_ROWS: u32 = 200;
const MAX_RATE: u32 = 600;
const MAX_ROWS_LIMIT: u32 = 2000;
/// Characters of one table cell, and of one text result.
pub const MAX_CELL_CHARS: usize = 2000;
pub const MAX_TEXT_CHARS: usize = 65536;
/// Bytes of JSON of one result.
pub const MAX_RESULT_BYTES: usize = 1024 * 1024;
const SEARCH_MAX_LIMIT: u64 = 50;
const SEARCH_DEFAULT_LIMIT: u64 = 20;
const DESCRIPTION_CHARS: usize = 400;
const ARGS_SUMMARY_BYTES: usize = 1024;
const ARG_STRING_CHARS: usize = 80;
const WINDOW: Duration = Duration::from_secs(60);

/// Requests an AI actor may make besides `mcp.tools` / `mcp.call`.
const PLAIN_METHODS: &[&str] = &[method::HELLO, method::WORKSPACE_INFO, method19::MCP_STATUS];

/// In-process memory only for what the audit table cannot know: calls begun and not yet written
/// (the limit counts finished ones from the audit, so it survives a restart), and when a
/// refusal of the same kind was last written (D450③).
#[derive(Default)]
pub struct McpState {
    /// Taken to admit a call, and to write a call's audit row and release it: so a call is counted
    /// once — as running, or as audited — never in neither or both.
    gate: tokio::sync::Mutex<()>,
    inflight: Mutex<HashMap<String, u32>>,
    quiet: Mutex<HashMap<(String, String), (Instant, u64)>>,
}

/// Longest `object`, `resource`, `runId`, tool name in an audit row.
const AUDIT_FIELD_CHARS: usize = 80;
/// Refusals of one kind by one client are written at most this often.
const REFUSAL_EVERY: Duration = Duration::from_secs(1);

fn short(s: &str) -> String {
    let (c, cut) = cut_chars(s, AUDIT_FIELD_CHARS);
    if cut {
        format!("{c}…")
    } else {
        c
    }
}

/// `mcp.policy` as the workspace configuration says it.
#[derive(Debug, Clone)]
pub struct McpPolicy {
    pub enabled: bool,
    pub rate: u32,
    pub max_rows: u32,
    pub free_query: bool,
    pub env: Option<String>,
    pub propose: bool,
}

fn truthy(v: &str) -> bool {
    crate::policy::truthy(v)
}

/// An AI client name: `[A-Za-z0-9._ -]`, at most 64 characters; anything else becomes `_`.
pub fn clean_client(name: &str) -> String {
    let s: String = name.chars().take(64).map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ' ' | '-') { c } else { '_' }).collect();
    if s.trim().is_empty() {
        "unknown".into()
    } else {
        s
    }
}

/// The client of an `actor` envelope text (`ai:<name>`).
pub fn ai_client(actor: &str) -> KResult<String> {
    actor.strip_prefix("ai:").map(clean_client).ok_or_else(|| invalid_params("actor"))
}

fn label_en(l: &Label) -> String {
    match l {
        Label::Text(t) => t.clone(),
        Label::Localized(m) => m.get("en-US").or_else(|| m.values().next()).cloned().unwrap_or_default(),
    }
}

pub(crate) fn cut_chars(s: &str, n: usize) -> (String, bool) {
    if s.chars().count() <= n {
        return (s.to_string(), false);
    }
    (s.chars().take(n).collect(), true)
}

fn secretish(key: &str) -> bool {
    let k = key.to_ascii_lowercase();
    ["password", "secret", "token", "key", "authorization"].iter().any(|w| k.contains(w))
}

/// What the audit keeps of a call's arguments (§5): short strings, no secrets, small.
pub fn summarize_args(v: &Value, depth: usize) -> Value {
    match v {
        Value::String(s) => {
            let (c, cut) = cut_chars(s, ARG_STRING_CHARS);
            Value::String(if cut { format!("{c}…") } else { c })
        }
        Value::Array(a) => Value::String(format!("[{} items]", a.len())),
        Value::Object(o) if depth >= 2 => Value::String(format!("{{{} keys}}", o.len())),
        Value::Object(o) => Value::Object(
            o.iter().map(|(k, x)| (k.clone(), if secretish(k) { json!("***") } else { summarize_args(x, depth + 1) })).collect(),
        ),
        other => other.clone(),
    }
}

fn capped_args(v: &Value) -> Value {
    let s = summarize_args(v, 0);
    if s.to_string().len() <= ARGS_SUMMARY_BYTES {
        return s;
    }
    let keys: Vec<&String> = v.as_object().map(|o| o.keys().collect()).unwrap_or_default();
    json!({ "truncated": true, "keys": keys })
}

fn code_of(e: &ProtocolError) -> String {
    serde_json::to_value(e.code).ok().and_then(|v| v.as_str().map(String::from)).unwrap_or_default()
}

fn bad_args(path: &str, rule: &str) -> ProtocolError {
    err_p(ErrorCode::InvalidParams, &[("reason", "badArguments"), ("path", path), ("rule", rule)])
}

/// JSON Schema subset check (round19-protocol §2.2).
pub fn validate(schema: &Value, v: &Value, path: &str) -> Result<(), (String, &'static str)> {
    let fail = |rule: &'static str| Err((path.to_string(), rule));
    if let Some(t) = schema.get("type").and_then(Value::as_str) {
        let ok = match t {
            "object" => v.is_object(),
            "string" => v.is_string(),
            "number" => v.is_number(),
            "integer" => v.is_i64() || v.is_u64() || v.as_f64().is_some_and(|f| f.fract() == 0.0),
            "boolean" => v.is_boolean(),
            "array" => v.is_array(),
            _ => true,
        };
        if !ok {
            return fail("type");
        }
    }
    if let Some(e) = schema.get("enum").and_then(Value::as_array) {
        if !e.contains(v) {
            return fail("enum");
        }
    }
    if let Some(n) = v.as_f64() {
        if schema.get("minimum").and_then(Value::as_f64).is_some_and(|m| n < m) {
            return fail("minimum");
        }
        if schema.get("maximum").and_then(Value::as_f64).is_some_and(|m| n > m) {
            return fail("maximum");
        }
    }
    if let Some(s) = v.as_str() {
        let len = s.chars().count() as u64;
        if schema.get("minLength").and_then(Value::as_u64).is_some_and(|m| len < m) {
            return fail("minLength");
        }
        if schema.get("maxLength").and_then(Value::as_u64).is_some_and(|m| len > m) {
            return fail("maxLength");
        }
    }
    if let Some(o) = v.as_object() {
        for r in schema.get("required").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str) {
            if !o.contains_key(r) {
                return Err((format!("{path}/{r}"), "required"));
            }
        }
        let props = schema.get("properties").and_then(Value::as_object);
        for (k, x) in o {
            match props.and_then(|p| p.get(k)) {
                Some(sub) => validate(sub, x, &format!("{path}/{k}"))?,
                None if schema.get("additionalProperties").and_then(Value::as_bool) == Some(false) => {
                    return Err((format!("{path}/{k}"), "additionalProperties"));
                }
                None => {}
            }
        }
    }
    if let (Some(a), Some(items)) = (v.as_array(), schema.get("items")) {
        for (i, x) in a.iter().enumerate() {
            validate(items, x, &format!("{path}/{i}"))?;
        }
    }
    Ok(())
}

/// `<prefix>__<name>`: the prefix is the plugin id with every other character as `_`.
pub fn tool_name(plugin: &str, tool: &str) -> String {
    let prefix: String = plugin.chars().map(|c| if c.is_ascii_lowercase() || c.is_ascii_digit() { c } else { '_' }).collect();
    format!("{prefix}__{tool}")
}

enum Target {
    Search,
    Describe,
    Run,
    GetRun,
    Tree,
    Read,
    Propose,
    Plugin(&'static Plugin, &'static AiToolDecl),
}

fn general_tools() -> Vec<McpTool> {
    let t = |name: &str, description: &str, schema: Value| McpTool { name: name.into(), description: description.into(), input_schema: schema };
    vec![
        t(
            "search",
            "Find resources the user made visible to AI by words in their name, description, tags or content. Returns ids to use with describe and run.",
            json!({ "type": "object", "properties": {
                "query": { "type": "string", "minLength": 1, "maxLength": 200, "description": "Words to look for" },
                "kinds": { "type": "array", "items": { "type": "string" }, "description": "Only these resource types (full names)" },
                "within": { "type": "string", "description": "Only below this resource (a book, a group): its id" },
                "limit": { "type": "integer", "minimum": 1, "maximum": 50, "description": "Most hits (default 20)" } },
                "required": ["query"], "additionalProperties": false }),
        ),
        t(
            "describe",
            "Describe one resource: what it is and which read-only actions it offers with their parameters.",
            json!({ "type": "object", "properties": { "id": { "type": "string", "description": "Resource id from search" } },
                "required": ["id"], "additionalProperties": false }),
        ),
        t(
            "run",
            "Run a read-only action of a resource in the environment the user chose for AI, and return its result (tables are cut to the row limit; use get_run for more).",
            json!({ "type": "object", "properties": {
                "id": { "type": "string", "description": "Resource id" },
                "action": { "type": "string", "description": "Action name from describe (optional when there is only one)" },
                "params": { "type": "object", "description": "Parameter values, by name" } },
                "required": ["id"], "additionalProperties": false }),
        ),
        t(
            "get_run",
            "Read the result of a run you started, page by page.",
            json!({ "type": "object", "properties": {
                "runId": { "type": "string" },
                "offset": { "type": "integer", "minimum": 0 },
                "limit": { "type": "integer", "minimum": 1, "maximum": 2000 } },
                "required": ["runId"], "additionalProperties": false }),
        ),
        // D487 §29: reading a whole structure, a page as it is, and proposing changes (never writing them).
        t(
            "tree",
            "The resources below one resource (a book, a group), in order: id, name, type, depth, revision. Read the structure first; then read pages.",
            json!({ "type": "object", "properties": {
                "id": { "type": "string", "description": "Resource id" },
                "offset": { "type": "integer", "minimum": 0 },
                "limit": { "type": "integer", "minimum": 1, "maximum": 500 } },
                "required": ["id"], "additionalProperties": false }),
        ),
        t(
            "read",
            "Read one resource: name, description, tags, the fields its page shows (texts as written), which of them a proposal may change, and what it refers to. `rev` is what a proposal is made against.",
            json!({ "type": "object", "properties": { "id": { "type": "string", "description": "Resource id" } },
                "required": ["id"], "additionalProperties": false }),
        ),
        t(
            "propose",
            "Propose changes for the user to review: change fields of resources (only those `read` lists as changeable), add resources, delete resources. Nothing is written until the user accepts each item. Say in the title and comment what you changed and why; one proposal per piece of work.",
            json!({ "type": "object", "properties": {
                "title": { "type": "string", "minLength": 1, "maxLength": 200 },
                "comment": { "type": "string", "maxLength": 4000, "description": "What and why" },
                "items": { "type": "array", "minItems": 1, "maxItems": 50, "items": { "type": "object", "properties": {
                    "op": { "type": "string", "enum": ["update", "create", "delete"] },
                    "id": { "type": "string", "description": "update, delete: the resource" },
                    "rev": { "type": "integer", "description": "update, delete: the revision you read" },
                    "changes": { "type": "object", "description": "update: field path (name, description, tags, body.<key>) to new value" },
                    "kind": { "type": "string", "description": "create: the full type name" },
                    "parent": { "type": "string", "description": "create: where it goes" },
                    "before": { "type": "string", "description": "create: the sibling it goes before (else last)" },
                    "name": { "type": "string", "description": "create: its name" },
                    "values": { "type": "object", "description": "create: field path to value" } },
                    "required": ["op"] } } },
                "required": ["title", "items"], "additionalProperties": false }),
        ),
    ]
}

/// Table output → `McpOutput`, from `offset` at most `max_rows` rows, cells cut, the whole under the byte limit.
/// Column names for the client: the readable `label`, else the key; never a bare key when a label
/// exists. A label that is an object (per-language texts) gives its `en`, else its first text.
/// Empty names fall back to the key; repeated names get `_2`, `_3`… so they stay distinct.
fn column_names(columns: Option<&Value>) -> Vec<Value> {
    let mut seen: std::collections::HashMap<String, u32> = std::collections::HashMap::new();
    let mut out = Vec::new();
    for (i, x) in columns.and_then(Value::as_array).into_iter().flatten().enumerate() {
        let text = |v: Option<&Value>| -> Option<String> {
            match v? {
                Value::String(s) => Some(s.trim().to_string()),
                Value::Object(m) => m
                    .get("en")
                    .and_then(Value::as_str)
                    .or_else(|| m.values().find_map(Value::as_str))
                    .map(|s| s.trim().to_string()),
                _ => None,
            }
            .filter(|s| !s.is_empty())
        };
        let base = text(x.get("label")).or_else(|| text(x.get("key"))).unwrap_or_else(|| format!("column_{}", i + 1));
        let mut name = base.clone();
        let mut k = seen.get(&base).copied().unwrap_or(0);
        while seen.contains_key(&name) {
            k += 1;
            name = format!("{base}_{}", k + 1);
        }
        seen.insert(base.clone(), k);
        seen.insert(name.clone(), 0);
        out.push(Value::String(name));
    }
    out
}

fn table_out(o: &Value, offset: usize, max_rows: usize) -> (Value, bool, u64) {
    let columns = column_names(o.get("columns"));
    let all = o.get("rows").and_then(Value::as_array).cloned().unwrap_or_default();
    let total = o.get("total").and_then(Value::as_u64).unwrap_or(all.len() as u64);
    let mut cut_cell = false;
    let mut rows: Vec<Value> = all
        .iter()
        .skip(offset)
        .take(max_rows)
        .map(|r| {
            Value::Array(
                r.as_array()
                    .map(|cells| {
                        cells
                            .iter()
                            .map(|c| {
                                let text = match c {
                                    Value::String(s) => Some(s.clone()),
                                    Value::Array(_) | Value::Object(_) => Some(c.to_string()),
                                    _ => None,
                                };
                                match text {
                                    Some(t) => {
                                        let (s, cut) = cut_chars(&t, MAX_CELL_CHARS);
                                        cut_cell |= cut;
                                        Value::String(if cut { format!("{s}…") } else { s })
                                    }
                                    None => c.clone(),
                                }
                            })
                            .collect()
                    })
                    .unwrap_or_default(),
            )
        })
        .collect();
    let mut out = json!({ "type": "table", "columns": columns, "rows": rows, "total": total, "offset": offset, "truncated": false });
    let mut size_cut = false;
    while out.to_string().len() > MAX_RESULT_BYTES && !rows.is_empty() {
        let keep = rows.len() / 2;
        rows.truncate(keep);
        out["rows"] = Value::Array(rows.clone());
        size_cut = true;
    }
    let n = rows.len() as u64;
    // More rows exist than are returned: the action's own cut, the page, or the row limit.
    let truncated = cut_cell || size_cut || o.get("truncated").and_then(Value::as_bool).unwrap_or(false) || (offset as u64 + n) < total;
    out["truncated"] = json!(truncated);
    (out, truncated, n)
}

/// A run row → `McpRun`. Returns it with `(truncated, rows)`.
fn run_value(row: &store::RunRow, offset: usize, max_rows: usize) -> (Value, bool, u64) {
    let mut v = json!({ "runId": row.id, "status": row.status });
    let (mut truncated, mut rows) = (false, 0);
    if let Some(o) = row.output.as_ref().filter(|_| row.status != "running") {
        let out = match o.get("type").and_then(Value::as_str) {
            Some("table") => {
                let (t, tr, n) = table_out(o, offset, max_rows);
                truncated = tr;
                rows = n;
                t
            }
            Some("text") => {
                let text = o.get("text").and_then(Value::as_str).unwrap_or_default();
                let (s, cut) = cut_chars(text, MAX_TEXT_CHARS);
                truncated = cut;
                json!({ "type": "text", "text": s, "truncated": cut, "totalChars": text.chars().count() })
            }
            Some("link") => json!({ "type": "link", "label": o.get("label"), "target": o.get("target") }),
            _ => json!({ "type": "none" }),
        };
        v["output"] = out;
    }
    if let Some(e) = row.error.as_ref().filter(|e| !e.is_null()) {
        let code = e.get("reason").and_then(Value::as_str).filter(|r| !r.is_empty()).or_else(|| e.get("code").and_then(Value::as_str)).unwrap_or("error");
        let msg = e.get("message").and_then(Value::as_str).unwrap_or_default();
        let (m, _) = cut_chars(msg, 500);
        v["error"] = if m.is_empty() { json!({ "code": code }) } else { json!({ "code": code, "message": m }) };
    }
    if let Some(ms) = row.summary.as_ref().and_then(|s| s.get("durationMs")).and_then(Value::as_i64) {
        v["durationMs"] = json!(ms);
    }
    (v, truncated, rows)
}

impl Inner {
    /* ---------------------------------------------------------------- policy */

    pub(crate) fn mcp_policy(&self) -> KResult<McpPolicy> {
        let get = |n: &str| -> KResult<Option<String>> { Ok(self.config_param(n)?.map(|(_, v)| v)) };
        let num = |n: &str, default: u32, lo: u32, hi: u32| -> KResult<u32> {
            Ok(get(n)?.and_then(|v| v.trim().parse::<f64>().ok()).map(|f| (f as i64).clamp(lo as i64, hi as i64) as u32).unwrap_or(default))
        };
        Ok(McpPolicy {
            enabled: get(P_ENABLED)?.is_some_and(|v| truthy(&v)),
            rate: num(P_RATE, DEFAULT_RATE, 1, MAX_RATE)?,
            max_rows: num(P_MAX_ROWS, DEFAULT_MAX_ROWS, 1, MAX_ROWS_LIMIT)?,
            free_query: get(P_FREE_QUERY)?.is_some_and(|v| truthy(&v)),
            env: get(P_ENV)?.map(|v| v.trim().to_string()).filter(|v| !v.is_empty()),
            propose: get(P_PROPOSE)?.is_some_and(|v| truthy(&v)),
        })
    }

    pub(crate) fn mcp_status(&self) -> KResult<McpStatus> {
        let p = self.mcp_policy()?;
        let env_name = match &p.env {
            Some(e) => self.read(|c| store::get(c, e))?.filter(|r| r.kind == store::KIND_ENV && r.deleted_at.is_none()).map(|r| r.name),
            None => None,
        };
        Ok(McpStatus {
            enabled: p.enabled,
            rate_per_minute: p.rate,
            max_rows: p.max_rows,
            allow_free_query: p.free_query,
            allow_proposals: p.propose,
            env_id: p.env.clone(),
            env_name,
            tools: self.mcp_tool_list(&p).len() as u32,
        })
    }

    /// `resource.setAiVisible` (the user's).
    pub(crate) async fn set_ai_visible(&self, p: SetAiVisibleParams) -> KResult<SetAiVisibleResult> {
        let row = self.live_row(&p.id)?;
        if self.hidden_tree(&row) || !self.in_stored_tree(&row) {
            return Err(not_found("resource"));
        }
        let mut ids = vec![row.id.clone()];
        if p.with_children == Some(true) {
            let mut todo = vec![row.id.clone()];
            while let Some(id) = todo.pop() {
                let kids = self.read(|c| store::children(c, row.tree.as_deref().unwrap_or(""), Some(&id), 0, u32::MAX))?;
                for k in kids {
                    ids.push(k.id.clone());
                    todo.push(k.id);
                }
            }
        }
        let out = self.execute(Actor::User, Command::AiVisible { ids, visible: p.visible }).await?;
        Ok(SetAiVisibleResult { changed: out.rows.len() as u32 })
    }

    /* ---------------------------------------------------------------- the gate */

    /// A request from an AI client: the few methods it may make, nothing else.
    pub(crate) async fn ai_request(&self, client: &str, c: Option<String>, m: &str, params: Value) -> KResult<Value> {
        match m {
            method19::MCP_TOOLS => self.mcp_tools_for_ai().and_then(|t| serde_json::to_value(t).map_err(internal)),
            method19::MCP_CALL => {
                let p: McpCallParams = crate::kernel::parse(params)?;
                serde_json::to_value(self.mcp_call(client, p).await?).map_err(internal)
            }
            m if PLAIN_METHODS.contains(&m) => self.handle(c, m, params).await,
            _ => {
                let e = err_p(ErrorCode::Denied, &[("reason", "aiNotAllowed"), ("method", m)]);
                self.mcp_audit(client, "mcp.refused", m, json!({ "tool": null, "ok": false }), Some(&e)).await;
                Err(e)
            }
        }
    }

    fn mcp_tools_for_ai(&self) -> KResult<Vec<McpTool>> {
        let p = self.mcp_policy()?;
        if !p.enabled {
            return Err(denied("aiOff"));
        }
        Ok(self.mcp_tool_list(&p))
    }

    /// Plugin tools that are on offer: enabled, confirmed, named uniquely and within 64 characters.
    fn plugin_tools(&self, policy: &McpPolicy) -> Vec<(String, &'static Plugin, &'static AiToolDecl)> {
        let mut ids = self.registry.ids();
        ids.sort();
        let mut out: Vec<(String, &'static Plugin, &'static AiToolDecl)> = Vec::new();
        for id in ids {
            let Some(pl) = self.registry.plugin(&id) else { continue };
            if pl.manifest.contributes.ai_tools.is_empty() || !self.plugin_enabled(&pl.id) || !self.version_deps_met(pl) || !self.version_confirmed(pl) {
                continue;
            }
            for t in &pl.manifest.contributes.ai_tools {
                if t.free_query && !policy.free_query {
                    continue;
                }
                let name = tool_name(&pl.id, &t.name);
                if name.len() <= 64 {
                    out.push((name, pl, t));
                }
            }
        }
        // A name two tools would share is offered by neither.
        let dup: Vec<String> = out.iter().filter(|(n, ..)| out.iter().filter(|(m, ..)| m == n).count() > 1).map(|(n, ..)| n.clone()).collect();
        out.retain(|(n, ..)| !dup.contains(n));
        out
    }

    pub(crate) fn mcp_tool_list(&self, policy: &McpPolicy) -> Vec<McpTool> {
        let mut tools = general_tools();
        for (name, pl, t) in self.plugin_tools(policy) {
            tools.push(McpTool { name, description: pl.text(&t.description, Some("en-US")), input_schema: t.input_schema.clone() });
        }
        tools
    }

    fn resolve_tool(&self, policy: &McpPolicy, name: &str) -> Option<Target> {
        match name {
            "search" => Some(Target::Search),
            "describe" => Some(Target::Describe),
            "run" => Some(Target::Run),
            "get_run" => Some(Target::GetRun),
            "tree" => Some(Target::Tree),
            "read" => Some(Target::Read),
            "propose" => Some(Target::Propose),
            _ => self.plugin_tools(policy).into_iter().find(|(n, ..)| n == name).map(|(_, pl, t)| Target::Plugin(pl, t)),
        }
    }

    /* ---------------------------------------------------------------- audit and limits */

    async fn mcp_audit(&self, client: &str, op: &str, object: &str, mut summary: Value, err: Option<&ProtocolError>) {
        let result = match err {
            None => "ok".to_string(),
            Some(e) => format!("failed:{}", code_of(e)),
        };
        if let Some(e) = err {
            summary["ok"] = json!(false);
            summary["code"] = json!(code_of(e));
            summary["reason"] = json!(e.params.get("reason"));
            // D450③: what a client can repeat for free (switch off, over the limit, a method it
            // may not use, a tool that is not there) is written once a second, with the count.
            let reason = e.params.get("reason").map(String::as_str).unwrap_or("");
            if matches!(reason, "aiOff" | "aiRateLimit" | "aiNotAllowed") || e.code == ErrorCode::NotFound && e.params.get("what").map(String::as_str) == Some("tool") {
                let key = (client.to_string(), format!("{op}/{reason}/{}", code_of(e)));
                let mut q = self.mcp.quiet.lock().unwrap();
                if q.len() > 1000 {
                    q.clear();
                }
                let now = Instant::now();
                let slot = q.entry(key).or_insert((now - REFUSAL_EVERY, 0));
                if now.duration_since(slot.0) < REFUSAL_EVERY {
                    slot.1 += 1;
                    return;
                }
                if slot.1 > 0 {
                    summary["suppressed"] = json!(slot.1);
                }
                *slot = (now, 0);
            }
        }
        let cmd = Command::Stopped { op: op.into(), object: short(object), summary, result };
        if self.pipeline.execute(Actor::Ai { client: client.into() }, cmd).await.is_ok() {
            self.emit(onedesk_protocol::topic2::AUDIT, None, None);
        }
    }

    /// Admits one more call, or refuses: the calls of ALL AI clients of the workspace in the last
    /// minute that the audit holds (so a restart does not clear them, and a new client name buys no
    /// new window — D451) plus those still running.
    async fn rate_admit(&self, client: &str, limit: u32) -> KResult<()> {
        let _gate = self.mcp.gate.lock().await;
        // Under the gate: count what the audit holds, add what is running, register this call.
        let mut m = self.mcp.inflight.lock().unwrap();
        let cutoff = now_ms() - WINDOW.as_millis() as i64;
        // Every AI client's rows: the operator type alone, or `<type>:<client>`.
        let kind = "ai";
        let like = format!("{kind}:%");
        let (done, oldest): (i64, Option<i64>) = self.read(|c| {
            c.query_row(
                "SELECT count(*), min(at) FROM audit WHERE op = 'mcp.call' AND (actor = ?2 OR actor LIKE ?3) AND at > ?1
                   AND COALESCE(json_extract(summary, '$.reason'), '') NOT IN ('aiRateLimit', 'aiOff')",
                rusqlite::params![cutoff, kind, like],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
        })?;
        let running: u32 = m.values().sum();
        if done + i64::from(running) >= i64::from(limit) {
            let wait = oldest.map(|t| (t + WINDOW.as_millis() as i64 - now_ms()).clamp(1, WINDOW.as_millis() as i64)).unwrap_or(1000);
            return Err(err_p(ErrorCode::Denied, &[("reason", "aiRateLimit"), ("limit", &limit.to_string()), ("retryAfterMs", &wait.to_string())]));
        }
        *m.entry(client.to_string()).or_default() += 1;
        Ok(())
    }

    fn rate_release(&self, client: &str) {
        if let Some(n) = self.mcp.inflight.lock().unwrap().get_mut(client) {
            *n = n.saturating_sub(1);
        }
    }

    /* ---------------------------------------------------------------- mcp.call */

    pub(crate) async fn mcp_call(&self, client: &str, p: McpCallParams) -> KResult<McpCallResult> {
        self.mcp_call_with(client, p, None).await
    }

    /// `mcp.call`, or (`policy`) the same tools on other terms: the AI chat's (D479).
    async fn mcp_call_with(&self, client: &str, p: McpCallParams, policy: Option<McpPolicy>) -> KResult<McpCallResult> {
        let t0 = Instant::now();
        let args = p.arguments.clone().unwrap_or_else(|| json!({}));
        let mut info = json!({ "tool": short(&p.name), "args": capped_args(&args) });
        let mut admitted = false;
        let res = self.mcp_call_inner(client, &p, &args, &mut info, &mut admitted, policy).await;
        info["ms"] = json!(t0.elapsed().as_millis() as u64);
        // The row and the release together, under the gate (see `McpState::gate`).
        let _gate = if admitted { Some(self.mcp.gate.lock().await) } else { None };
        match &res {
            Ok(r) => {
                info["ok"] = json!(true);
                info["rows"] = json!(r.rows);
                self.mcp_audit(client, "mcp.call", &p.name, info, None).await;
            }
            Err(e) => self.mcp_audit(client, "mcp.call", &p.name, info, Some(e)).await,
        }
        if admitted {
            self.rate_release(client);
        }
        res
    }

    async fn mcp_call_inner(&self, client: &str, p: &McpCallParams, args: &Value, info: &mut Value, admitted: &mut bool, given: Option<McpPolicy>) -> KResult<McpCallResult> {
        let policy = match given {
            Some(p) => p,
            None => self.mcp_policy()?,
        };
        if !policy.enabled {
            return Err(denied("aiOff"));
        }
        self.rate_admit(client, policy.rate).await?;
        *admitted = true;
        let target = self.resolve_tool(&policy, &p.name).ok_or_else(|| not_found("tool"))?;
        if let Target::Plugin(_, t) = &target {
            // Defence in depth: `resolve_tool` already hides the tool (notFound/tool) while it is off.
            if t.free_query && !policy.free_query {
                return Err(denied("aiFreeQuery"));
            }
        }
        if !args.is_object() {
            return Err(bad_args("", "type"));
        }
        let schema = match &target {
            Target::Plugin(_, t) => t.input_schema.clone(),
            _ => general_tools().into_iter().find(|t| t.name == p.name).map(|t| t.input_schema).unwrap_or(Value::Null),
        };
        validate(&schema, args, "").map_err(|(path, rule)| bad_args(&path, rule))?;
        let s = |k: &str| args.get(k).and_then(Value::as_str);
        match target {
            Target::Search => self.tool_search(args, &policy).await,
            Target::Describe => self.tool_describe(s("id").unwrap_or_default()).await,
            Target::Run => {
                info["resource"] = json!(s("id").map(short));
                self.tool_run(client, &policy, args, info).await
            }
            Target::GetRun => self.tool_get_run(client, &policy, args, info).await,
            Target::Tree => {
                info["resource"] = json!(s("id").map(short));
                self.tool_tree(args)
            }
            Target::Read => {
                info["resource"] = json!(s("id").map(short));
                self.tool_read(s("id").unwrap_or_default()).await
            }
            Target::Propose => self.tool_propose(client, &policy, args, info).await,
            Target::Plugin(pl, t) => self.tool_plugin(client, &policy, pl, t, args, info).await,
        }
    }

    /* ---------------------------------------------------------------- D479: the conversation's tools */

    /// The terms of the writing help's conversation tools: those of MCP (rows, free queries, the rate shared
    /// with every outside client), but in the conversation tab's environment, and not behind the MCP switch
    /// (that one is about outside clients; the conversation has its environment's policy).
    fn chat_policy(&self, env: Option<String>) -> KResult<McpPolicy> {
        let mut p = self.mcp_policy()?;
        p.enabled = true;
        p.env = env;
        Ok(p)
    }

    /// `host.tools.list()` / `host.tools.call(name, arguments)`: the writing-help provider uses the tools an
    /// MCP client has — only what the user made visible, read only, rate-limited and audited under `CHAT_CLIENT`.
    pub(crate) async fn host_tools(&self, plugin: &'static Plugin, info: &CallInfo, op: &str, args: &Value) -> KResult<Value> {
        self.assist_reader(plugin)?;
        if info.ai {
            return Err(denied("aiRun"));
        }
        let policy = self.chat_policy(info.env_id.clone())?;
        match op {
            "list" => serde_json::to_value(self.mcp_tool_list(&policy)).map_err(internal),
            "call" => {
                let name = args.get(0).and_then(Value::as_str).ok_or_else(|| invalid_params("name must be a string"))?.to_string();
                let arguments = args.get(1).cloned().filter(|v| !v.is_null());
                // Waiting for a run the tool started is not this invocation's time.
                let _hold = info.hold.enter_wait();
                let r = self.mcp_call_with(CHAT_CLIENT, McpCallParams { name, arguments }, Some(policy)).await?;
                serde_json::to_value(r).map_err(internal)
            }
            _ => Err(err_p(ErrorCode::UnknownMethod, &[("method", &format!("tools.{op}"))])),
        }
    }

    fn result(&self, content: Value, truncated: bool, rows: Option<u64>) -> McpCallResult {
        McpCallResult { content, truncated, rows }
    }

    /// A resource an AI may see: live, shown in a tree, present, and made visible.
    fn ai_row(&self, id: &str) -> KResult<Row> {
        let row = self.read(|c| store::get(c, id))?.ok_or_else(|| not_found("resource"))?;
        let visible = self.read(|c| store::is_ai_visible(c, id))?;
        if row.deleted_at.is_some() || row.state == "missing" || !visible || self.hidden_tree(&row) || !self.in_stored_tree(&row) {
            return Err(not_found("resource"));
        }
        Ok(row)
    }

    async fn tool_search(&self, args: &Value, _policy: &McpPolicy) -> KResult<McpCallResult> {
        let q = args.get("query").and_then(Value::as_str).unwrap_or_default().trim().to_string();
        if q.is_empty() {
            return Err(bad_args("/query", "minLength"));
        }
        let limit = args.get("limit").and_then(Value::as_u64).unwrap_or(SEARCH_DEFAULT_LIMIT).clamp(1, SEARCH_MAX_LIMIT) as u32;
        let kinds: Option<Vec<String>> = args.get("kinds").and_then(Value::as_array).map(|a| a.iter().filter_map(|k| k.as_str().map(String::from)).collect());
        // D487 §29: only below one resource it may see.
        let ids = match args.get("within").and_then(Value::as_str) {
            Some(w) => {
                let root = self.ai_row(w)?;
                Some(self.ai_subtree(&root, usize::MAX).into_iter().map(|(r, _)| r.id).collect::<Vec<_>>())
            }
            None => None,
        };
        let o = SearchOpts {
            ids,
            text: Some(q),
            mode: Some(SearchMode::Any),
            rank: Some(SearchRank::Relevance),
            kinds,
            limit: Some(limit),
            ai_only: true,
            ..Default::default()
        };
        let (res, scores) = self.search_core(&o, true)?;
        let mut items = Vec::new();
        for (it, (score, _)) in res.items.iter().zip(scores) {
            let Some(row) = self.read(|c| store::get(c, &it.id))? else { continue };
            items.push(json!({
                "id": it.id,
                "kind": it.kind,
                "kindLabel": it.kind_label.as_ref().map(label_en).unwrap_or_default(),
                "name": it.name,
                "description": cut_chars(&row.description, DESCRIPTION_CHARS).0,
                "tags": it.tags,
                "score": score,
            }));
        }
        let n = items.len() as u64;
        Ok(self.result(json!({ "items": items, "total": res.total }), u64::from(res.total) > n, Some(n)))
    }

    /// What an AI may see below `root`, in tree order with depths (at most `max`, and 20 000).
    fn ai_subtree(&self, root: &Row, max: usize) -> Vec<(Row, usize)> {
        let tree = root.tree.clone().unwrap_or_default();
        let kids = |id: &str| self.read(|c| store::children(c, &tree, Some(id), 0, u32::MAX)).unwrap_or_default();
        let mut out = Vec::new();
        let mut stack: Vec<(Row, usize)> = kids(&root.id).into_iter().rev().map(|r| (r, 1)).collect();
        while let Some((r, depth)) = stack.pop() {
            if out.len() >= max.min(20_000) {
                break;
            }
            if r.kind == store::KIND_TREE || r.state == store::STATE_MISSING || !self.read(|c| store::is_ai_visible(c, &r.id)).unwrap_or(false) {
                continue;
            }
            stack.extend(kids(&r.id).into_iter().rev().map(|k| (k, depth + 1)));
            out.push((r, depth));
        }
        out
    }

    /// `tree`: the structure below a resource, page by page.
    fn tool_tree(&self, args: &Value) -> KResult<McpCallResult> {
        let root = self.ai_row(args.get("id").and_then(Value::as_str).unwrap_or_default())?;
        let offset = args.get("offset").and_then(Value::as_u64).unwrap_or(0) as usize;
        let limit = (args.get("limit").and_then(Value::as_u64).unwrap_or(TREE_PAGE as u64) as usize).clamp(1, TREE_PAGE);
        let all = self.ai_subtree(&root, offset + limit + 1);
        let more = all.len() > offset + limit;
        let nodes: Vec<Value> = all
            .iter()
            .skip(offset)
            .take(limit)
            .map(|(r, depth)| {
                json!({ "id": r.id, "name": r.name, "kind": r.kind, "kindLabel": label_en(&self.row_meta(r).label),
                        "parent": r.parent_id, "depth": depth, "rev": r.rev })
            })
            .collect();
        let n = nodes.len() as u64;
        Ok(self.result(json!({ "root": { "id": root.id, "name": root.name, "kind": root.kind, "rev": root.rev }, "nodes": nodes,
                               "next": if more { Some(offset + limit) } else { None } }), more, Some(n)))
    }

    /// `read`: a resource's fields as its page shows them (never a secret, withheld or parameter field).
    async fn tool_read(&self, id: &str) -> KResult<McpCallResult> {
        let row = self.ai_row(id)?;
        let meta = self.row_meta(&row);
        let target = format!("resource:{}", row.id);
        let changeable = self.proposable_fields(&target, &row.kind, row.plugin_version.as_deref()).await;
        let mut skip: std::collections::BTreeSet<String> = self.secret_fields(&row.kind, row.plugin_version.as_deref()).into_iter().collect();
        if let Some((_, k)) = self.registry.kind_at(&row.kind, row.plugin_version.as_deref()) {
            skip.extend(k.fields.iter().filter(|(_, f)| f.withheld).map(|(n, _)| format!("body.{n}")));
        }
        let mut fields = Vec::new();
        let mut cut = false;
        let mut seen = std::collections::BTreeSet::new();
        if let Ok(page) = self.resolve(&target, Default::default(), None).await {
            for node in &page.view {
                let list = match node {
                    ViewNode::Form { fields, .. } | ViewNode::Flow { fields, .. } => fields,
                    _ => continue,
                };
                for f in list {
                    let Some(b) = f.bind.as_ref().filter(|b| b.starts_with("body.") && !skip.contains(*b) && f.param != Some(true)) else { continue };
                    if !seen.insert(b.clone()) {
                        continue;
                    }
                    let mut value = store::value_at(&row, b).unwrap_or(Value::Null);
                    if let Value::String(t) = &value {
                        let (c, was_cut) = cut_chars(t, MAX_TEXT_CHARS);
                        cut |= was_cut;
                        value = json!(c);
                    }
                    fields.push(json!({ "path": b, "label": label_en(&f.label), "kind": f.kind, "value": value, "changeable": changeable.contains_key(b) }));
                }
            }
        }
        let refs: Vec<Value> = self
            .refs_outgoing(&row.id)
            .unwrap_or_default()
            .into_iter()
            .map(|r| {
                let to = r.target.filter(|t| self.read(|c| store::is_ai_visible(c, &t.id)).unwrap_or(false)).map(|t| json!({ "id": t.id, "name": t.name }));
                json!({ "text": r.text, "field": r.field, "to": to, "embed": r.embed == Some(true) })
            })
            .collect();
        let location = self.resource(&row).map(|r| r.location).unwrap_or_default();
        Ok(self.result(
            json!({ "id": row.id, "kind": row.kind, "kindLabel": label_en(&meta.label), "name": row.name, "description": row.description,
                    "tags": row.tags, "rev": row.rev, "parent": row.parent_id, "location": location, "fields": fields, "refs": refs,
                    "stamped": self.stamped(&row.id).unwrap_or(false), "readOnlyCopy": row.origin == crate::packages::ORIGIN_COPY }),
            cut,
            None,
        ))
    }

    /// `propose`: a proposal for the user to review (behind its own switch).
    async fn tool_propose(&self, client: &str, policy: &McpPolicy, args: &Value, info: &mut Value) -> KResult<McpCallResult> {
        if !policy.propose {
            return Err(denied("aiProposeOff"));
        }
        let p: ProposalCreateParams = serde_json::from_value(args.clone()).map_err(|_| bad_args("/items", "type"))?;
        let n = p.items.len();
        let id = self.proposal_create(Actor::Ai { client: client.to_string() }, p).await?;
        info["proposal"] = json!(short(&id));
        Ok(self.result(json!({ "proposal": id, "items": n, "status": "pending" }), false, None))
    }

    /// The AI actions of a resource's kind that can be offered, with their plugin.
    fn ai_actions(&self, row: &Row) -> Vec<(&'static Plugin, &'static ActionDef)> {
        let Some((pl, _)) = self.registry.kind_at(&row.kind, row.plugin_version.as_deref()) else { return vec![] };
        if !self.plugin_enabled(&pl.id) || !self.version_deps_met(pl) || !self.version_confirmed(pl) {
            return vec![];
        }
        pl.manifest
            .contributes
            .actions
            .iter()
            .filter(|a| a.ai.as_ref().is_some_and(|x| x.read_only) && a.kinds.as_ref().is_some_and(|ks| ks.iter().any(|k| pl.kind_ref(k) == row.kind)))
            .map(|a| (pl, a))
            .collect()
    }

    /// One `ParamDecl` as the AI gets it: only the known fields, cut to size (§2.3, D450④); `None` if malformed.
    fn sanitize_param(p: &Value) -> Option<Value> {
        let name = p.get("name").and_then(Value::as_str).filter(|n| crate::manifest::valid_ai_name(n, 64))?;
        let ty = p.get("type").and_then(Value::as_str).filter(|t| matches!(*t, "text" | "number" | "boolean" | "enum"))?;
        let required = match p.get("required") {
            None => false,
            Some(r) => r.as_bool()?,
        };
        let mut v = json!({ "name": name, "type": ty, "required": required });
        if let Some(d) = p.get("description").and_then(Value::as_str) {
            v["description"] = json!(cut_chars(d, DESCRIPTION_CHARS).0);
        }
        if ty == "enum" {
            let opts: Vec<String> = p.get("options")?.as_array()?.iter().map(|o| o.as_str().map(|o| cut_chars(o, 200).0)).collect::<Option<_>>()?;
            if opts.is_empty() || opts.len() > 50 {
                return None;
            }
            v["options"] = json!(opts);
        }
        if let Some(d) = p.get("default").and_then(Value::as_str) {
            v["default"] = json!(cut_chars(d, 200).0);
        }
        Some(v)
    }

    fn static_params(pl: &Plugin, a: &ActionDef) -> Vec<Value> {
        a.ai.iter()
            .flat_map(|x| x.params.iter())
            .filter_map(|p| {
                let mut v = json!({ "name": p.name, "type": p.ty, "required": p.required });
                if let Some(d) = &p.description {
                    v["description"] = json!(pl.text(d, Some("en-US")));
                }
                if let Some(o) = &p.options {
                    v["options"] = json!(o);
                }
                if let Some(d) = &p.default {
                    v["default"] = json!(d);
                }
                Self::sanitize_param(&v)
            })
            .collect()
    }

    /// The parameters an AI action takes: the plugin's answer (`ai.describe`) when it has one, else its manifest's.
    async fn action_params(&self, pl: &'static Plugin, a: &ActionDef, row: &Row) -> Result<(Vec<Value>, Option<String>), String> {
        match a.ai.as_ref().and_then(|x| x.describe.as_deref()) {
            Some(d) => self.describe_params(pl, d, row).await,
            None => Ok((Self::static_params(pl, a), None)),
        }
    }

    async fn tool_describe(&self, id: &str) -> KResult<McpCallResult> {
        let row = self.ai_row(id)?;
        let meta = self.row_meta(&row);
        let mut actions = Vec::new();
        for (pl, a) in self.ai_actions(&row) {
            let ai = a.ai.as_ref().expect("filtered");
            let mut entry = json!({ "action": a.id, "label": pl.text(&a.label, Some("en-US")), "params": Self::static_params(pl, a) });
            if let Some(d) = &ai.description {
                entry["description"] = json!(cut_chars(&pl.text(d, Some("en-US")), DESCRIPTION_CHARS).0);
            }
            if ai.describe.is_some() {
                match self.action_params(pl, a, &row).await {
                    Ok((params, desc)) => {
                        entry["params"] = Value::Array(params);
                        if let Some(d) = desc {
                            entry["description"] = json!(d);
                        }
                    }
                    Err(code) => entry["paramsError"] = json!(code),
                }
            }
            actions.push(entry);
        }
        Ok(self.result(
            json!({ "id": row.id, "kind": row.kind, "kindLabel": label_en(&meta.label), "name": row.name,
                    "description": cut_chars(&row.description, DESCRIPTION_CHARS).0, "tags": row.tags, "actions": actions }),
            false,
            None,
        ))
    }

    /// §2.4: the plugin names a resource's parameters. A pure call, no environment, no network.
    /// What it answers is checked and cut like a manifest's (D450④).
    async fn describe_params(&self, pl: &'static Plugin, action: &str, row: &Row) -> Result<(Vec<Value>, Option<String>), String> {
        let resource = self.resource(row).map_err(|e| code_of(&e))?;
        let resource = crate::deps::without_secrets(
            serde_json::to_value(resource).map_err(|_| "internal".to_string())?,
            &self.secret_fields(&row.kind, row.plugin_version.as_deref()),
        );
        let ctx = json!({ "target": format!("resource:{}", row.id), "resource": resource, "envId": null, "params": {}, "runId": null,
                          "locale": "en-US" });
        let info = CallInfo { pure: true, ai: true, resource_id: Some(row.id.clone()), ..Default::default() };
        let v = self
            .call_version(pl, "actions", action, "", json!([ctx, {}]), info, None, Some(Duration::from_secs(10)))
            .await
            .map_err(|_| "pluginError".to_string())?;
        let data = v.get("data").ok_or("badOutput")?;
        let list = data.get("params").and_then(Value::as_array).ok_or("badOutput")?;
        if list.len() > 32 {
            return Err("badOutput".into());
        }
        let mut out = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for p in list {
            let p = Self::sanitize_param(p).ok_or("badOutput")?;
            if !seen.insert(p["name"].as_str().unwrap_or_default().to_string()) {
                return Err("badOutput".into());
            }
            out.push(p);
        }
        Ok((out, data.get("description").and_then(Value::as_str).map(|d| cut_chars(d, DESCRIPTION_CHARS).0)))
    }

    /// The environment the AI runs in, after the checks every run and result read makes.
    fn ai_env(&self, policy: &McpPolicy) -> KResult<Option<String>> {
        if let Some(e) = &policy.env {
            let ok = self.read(|c| store::get(c, e))?.is_some_and(|r| r.kind == store::KIND_ENV && r.deleted_at.is_none());
            if !ok {
                return Err(invalid("aiEnvMissing"));
            }
        }
        self.read(|c| Ok(crate::policy::check(c, crate::policy::NO_EXPORT, policy.env.as_deref())))??;
        Ok(policy.env.clone())
    }

    async fn tool_run(&self, client: &str, policy: &McpPolicy, args: &Value, info: &mut Value) -> KResult<McpCallResult> {
        let row = self.ai_row(args.get("id").and_then(Value::as_str).unwrap_or_default())?;
        let actions = self.ai_actions(&row);
        let (pl, a) = match args.get("action").and_then(Value::as_str) {
            Some(n) => *actions.iter().find(|(_, a)| a.id == n).ok_or_else(|| denied("notAiAction"))?,
            None => match actions.as_slice() {
                [one] => *one,
                [] => return Err(denied("notAiAction")),
                _ => return Err(err_p(ErrorCode::InvalidParams, &[("reason", "needAction")])),
            },
        };
        // What it may pass is what the action declares (its manifest, or its own answer): names,
        // types, options, the required ones — always checked, also when none is given.
        let declared = self
            .action_params(pl, a, &row)
            .await
            .map_err(|code| err_p(ErrorCode::PluginError, &[("reason", "badOutput"), ("what", "params"), ("code", &code)]))?;
        let declared = declared.0;
        let given = args.get("params").and_then(Value::as_object);
        if given.is_some_and(|o| o.len() > 32) {
            return Err(bad_args("/params", "maxProperties"));
        }
        let mut params = std::collections::BTreeMap::new();
        for (k, v) in given.into_iter().flatten() {
            let text = match v {
                Value::String(s) => s.clone(),
                Value::Number(n) => n.to_string(),
                Value::Bool(b) => b.to_string(),
                _ => return Err(bad_args(&format!("/params/{k}"), "type")),
            };
            if text.chars().count() > 1000 {
                return Err(bad_args(&format!("/params/{k}"), "maxLength"));
            }
            let d = declared.iter().find(|d| d["name"] == json!(k)).ok_or_else(|| bad_args(&format!("/params/{k}"), "additionalProperties"))?;
            match d["type"].as_str() {
                Some("enum") if !d["options"].as_array().is_some_and(|o| o.iter().any(|x| x.as_str() == Some(text.as_str()))) => {
                    return Err(bad_args(&format!("/params/{k}"), "enum"));
                }
                Some("number") if text.parse::<f64>().is_err() => return Err(bad_args(&format!("/params/{k}"), "type")),
                Some("boolean") if text != "true" && text != "false" => return Err(bad_args(&format!("/params/{k}"), "type")),
                _ => {}
            }
            params.insert(k.clone(), text);
        }
        for d in declared.iter().filter(|d| d["required"] == json!(true)) {
            let n = d["name"].as_str().unwrap_or_default();
            if !params.contains_key(n) {
                return Err(bad_args(&format!("/params/{n}"), "required"));
            }
        }
        let env = self.ai_env(policy)?;
        let rp = RunStartParams {
            action: pl.full(&a.id),
            resource_id: Some(row.id.clone()),
            target: format!("resource:{}", row.id),
            tab_id: "ai".into(),
            env_id: env,
            // Never the AI's to change: it runs what the user saved.
            input: JsonMap::new(),
            params,
            locale: Some("en-US".into()),
            result_run: None,
        };
        self.finish_ai_run(client, policy, rp, info).await
    }

    async fn tool_plugin(&self, client: &str, policy: &McpPolicy, pl: &'static Plugin, t: &'static AiToolDecl, args: &Value, info: &mut Value) -> KResult<McpCallResult> {
        let env = self.ai_env(policy)?;
        let input: JsonMap = args.as_object().map(|o| o.iter().map(|(k, v)| (k.clone(), v.clone())).collect()).unwrap_or_default();
        let rp = RunStartParams {
            action: pl.full(&t.action),
            resource_id: None,
            target: "ai:tool".into(),
            tab_id: "ai".into(),
            env_id: env,
            input,
            params: Default::default(),
            locale: Some("en-US".into()),
            result_run: None,
        };
        self.finish_ai_run(client, policy, rp, info).await
    }

    async fn finish_ai_run(&self, client: &str, policy: &McpPolicy, rp: RunStartParams, info: &mut Value) -> KResult<McpCallResult> {
        // Told when the run ends (its topic), not asked every few milliseconds; subscribed first so
        // an end that comes at once is not missed.
        let mut events = self.events.subscribe();
        let id = self.run_start_as(rp, None, Some(client)).await?;
        info["runId"] = json!(short(&id));
        let topic = format!("{}{id}", onedesk_protocol::topic3::RUN);
        let deadline = tokio::time::Instant::now() + self.cfg.mcp_wait;
        let row = 'wait: loop {
            let row = self.read(|c| store::run_get(c, &id))?.ok_or_else(|| not_found("run"))?;
            if row.status != "running" || tokio::time::Instant::now() >= deadline {
                break row;
            }
            loop {
                match tokio::time::timeout_at(deadline, events.recv()).await {
                    Ok(Ok(ev)) if ev.topic != topic => continue,
                    Ok(Err(tokio::sync::broadcast::error::RecvError::Closed)) => break 'wait row,
                    // The run's topic, a missed message, or the time is up: look again.
                    _ => continue 'wait,
                }
            }
        };
        let (v, truncated, rows) = run_value(&row, 0, policy.max_rows as usize);
        Ok(self.result(v, truncated, Some(rows)))
    }

    async fn tool_get_run(&self, client: &str, policy: &McpPolicy, args: &Value, info: &mut Value) -> KResult<McpCallResult> {
        let id = args.get("runId").and_then(Value::as_str).unwrap_or_default();
        info["runId"] = json!(short(id));
        let row = self.read(|c| store::run_get(c, id))?.filter(|r| r.source == "ai" && r.actor == format!("ai:{client}")).ok_or_else(|| not_found("run"))?;
        self.read(|c| Ok(crate::policy::check(c, crate::policy::NO_EXPORT, row.env_id.as_deref())))??;
        // Switched off for AI since: its runs are not readable any more.
        if let Some(r) = &row.resource_id {
            self.ai_row(r).map_err(|_| not_found("run"))?;
        }
        let offset = args.get("offset").and_then(Value::as_u64).unwrap_or(0) as usize;
        let limit = args.get("limit").and_then(Value::as_u64).map(|l| l as usize).unwrap_or(usize::MAX).min(policy.max_rows as usize);
        let (v, truncated, rows) = run_value(&row, offset, limit);
        Ok(self.result(v, truncated, Some(rows)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn client_names_are_cleaned() {
        assert_eq!(clean_client("claude-desktop 1.2"), "claude-desktop 1.2");
        assert_eq!(clean_client("a/b:c"), "a_b_c");
        assert_eq!(clean_client("   "), "unknown");
        assert_eq!(clean_client(&"x".repeat(100)).len(), 64);
        assert!(ai_client("user").is_err());
        assert_eq!(ai_client("ai:x").unwrap(), "x");
    }

    #[test]
    fn tool_names_get_the_plugin_prefix() {
        assert_eq!(tool_name("org.onedesk.sql", "list_tables"), "org_onedesk_sql__list_tables");
    }

    #[test]
    fn schema_subset_checks() {
        let s = json!({ "type": "object", "properties": { "n": { "type": "integer", "minimum": 1, "maximum": 5 },
                          "e": { "enum": ["a", "b"] }, "s": { "type": "string", "maxLength": 3 } },
                          "required": ["n"], "additionalProperties": false });
        assert!(validate(&s, &json!({ "n": 2, "e": "a" }), "").is_ok());
        assert_eq!(validate(&s, &json!({}), "").unwrap_err(), ("/n".into(), "required"));
        assert_eq!(validate(&s, &json!({ "n": 0 }), "").unwrap_err().1, "minimum");
        assert_eq!(validate(&s, &json!({ "n": 6 }), "").unwrap_err().1, "maximum");
        assert_eq!(validate(&s, &json!({ "n": 1.5 }), "").unwrap_err().1, "type");
        assert_eq!(validate(&s, &json!({ "n": 1, "e": "c" }), "").unwrap_err().1, "enum");
        assert_eq!(validate(&s, &json!({ "n": 1, "s": "abcd" }), "").unwrap_err().1, "maxLength");
        assert_eq!(validate(&s, &json!({ "n": 1, "x": 1 }), "").unwrap_err(), ("/x".into(), "additionalProperties"));
    }

    #[test]
    fn audit_args_hide_secrets_and_shorten() {
        let a = json!({ "password": "hunter2", "api_key": "k", "q": "x".repeat(200), "list": [1, 2, 3], "n": 5,
                        "deep": { "a": { "b": { "c": 1 } } } });
        let s = summarize_args(&a, 0);
        assert_eq!(s["password"], "***");
        assert_eq!(s["api_key"], "***");
        assert_eq!(s["list"], "[3 items]");
        assert_eq!(s["n"], 5);
        assert_eq!(s["q"].as_str().unwrap().chars().count(), 81);
        assert!(!s.to_string().contains("hunter2"));
        assert!(s["deep"]["a"].as_str().unwrap().contains("keys"));
    }

    #[test]
    fn column_names_use_labels_not_keys() {
        let n = |v: Value| column_names(Some(&v));
        assert_eq!(n(json!([{ "key": "c0", "label": "id" }, { "key": "c1", "label": "label" }])), vec![json!("id"), json!("label")]);
        // Repeated labels get a counter.
        assert_eq!(n(json!([{ "key": "c0", "label": "id" }, { "key": "c1", "label": "id" }, { "key": "c2", "label": "id" }])), vec![json!("id"), json!("id_2"), json!("id_3")]);
        // A later column that already looks like the counter name stays distinct.
        assert_eq!(n(json!([{ "key": "a", "label": "id" }, { "key": "b", "label": "id_2" }, { "key": "c", "label": "id" }])), vec![json!("id"), json!("id_2"), json!("id_3")]);
        // No label, empty label or blank label: the key.
        assert_eq!(n(json!([{ "key": "k1" }, { "key": "k2", "label": "" }, { "key": "k3", "label": "  " }])), vec![json!("k1"), json!("k2"), json!("k3")]);
        // Per-language object: English, else the first text; never the key when there is text.
        assert_eq!(n(json!([{ "key": "c0", "label": { "zh": "名称", "en": "Name" } }, { "key": "c1", "label": { "zh": "年龄" } }])), vec![json!("Name"), json!("年龄")]);
        // Nothing usable at all: a position name, not null.
        assert_eq!(n(json!([{}])), vec![json!("column_1")]);
        assert!(column_names(None).is_empty());
    }

    #[test]
    fn tables_are_cut_to_rows_cells_and_pages() {
        let rows: Vec<Value> = (0..10).map(|i| json!([i, "x".repeat(if i == 0 { 3000 } else { 1 })])).collect();
        let o = json!({ "type": "table", "columns": [{ "key": "a", "label": "A" }, { "key": "b", "label": "B" }], "rows": rows, "total": 10, "truncated": false });
        let (v, tr, n) = table_out(&o, 0, 4);
        assert!(tr);
        assert_eq!(n, 4);
        assert_eq!(v["rows"].as_array().unwrap().len(), 4);
        assert_eq!(v["rows"][0][1].as_str().unwrap().chars().count(), MAX_CELL_CHARS + 1);
        let (v, tr, n) = table_out(&o, 8, 4);
        assert!(!tr, "the last page");
        assert_eq!((n, v["offset"].clone()), (2, json!(8)));
    }
}
