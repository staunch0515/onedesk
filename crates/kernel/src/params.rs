//! Parameter tables of `core:env` / `core:config` nodes (kernel-design §6.1–6.2, D273–D276).
//! body = `{ "params": { <name>: { "type", "value", "based_on"?: { "value", "source" } } } }`.
//! Values are text; `list` is newline-separated.

use std::collections::BTreeMap;

use onedesk_protocol::ParamType;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::store::Row;

pub const PARAMS_KEY: &str = "params";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BasedOn {
    pub value: String,
    /// The node the inherited value came from.
    pub source: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Param {
    #[serde(rename = "type")]
    pub ty: ParamType,
    pub value: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub based_on: Option<BasedOn>,
}

/// The node's own parameters (malformed entries are skipped).
pub fn params_of(row: &Row) -> BTreeMap<String, Param> {
    row.body
        .get(PARAMS_KEY)
        .and_then(Value::as_object)
        .map(|m| m.iter().filter_map(|(k, v)| serde_json::from_value(v.clone()).ok().map(|p| (k.clone(), p))).collect())
        .unwrap_or_default()
}

pub fn get(row: &Row, name: &str) -> Option<Param> {
    row.body.get(PARAMS_KEY)?.get(name).and_then(|v| serde_json::from_value(v.clone()).ok())
}

/// Sets (`Some`) or removes (`None`) one parameter in the row's body.
pub fn put(row: &mut Row, name: &str, p: Option<&Param>) {
    let table = row.body.entry(PARAMS_KEY.to_string()).or_insert_with(|| Value::Object(Default::default()));
    if !table.is_object() {
        *table = Value::Object(Default::default());
    }
    let m = table.as_object_mut().expect("object");
    match p {
        Some(p) => {
            m.insert(name.to_string(), serde_json::to_value(p).expect("json"));
        }
        None => {
            m.remove(name);
        }
    }
}

/// Nearest ancestor (in `ancestors`, root first) that defines `name`.
pub fn inherited<'a>(ancestors: &'a [Row], name: &str) -> Option<(Param, &'a Row)> {
    ancestors.iter().rev().find_map(|a| get(a, name).map(|p| (p, a)))
}

pub fn is_param_kind(kind: &str) -> bool {
    kind == crate::store::KIND_ENV || kind == crate::store::KIND_CONFIG
}

/// Text that search indexes for a parameter table.
pub fn search_text(row: &Row) -> String {
    params_of(row).iter().map(|(k, p)| format!("{k} {}", p.value)).collect::<Vec<_>>().join("\n")
}
