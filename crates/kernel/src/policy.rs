//! Prohibition policies and the parameters the kernel itself interprets (kernel-design §6.3, D327).
//!
//! A prohibition is a boolean parameter; any layer that says true forbids. The layers are every
//! configuration node, then (for a save or a run that carries a tab's environment) the
//! environment's parent chain from the root down.

use onedesk_protocol::{KnownParam, ParamType, PolicyMerge};
use rusqlite::Connection;

use crate::store::{self, KIND_CONFIG, KIND_ENV};
use crate::util::{err_p, KResult};

pub const READONLY: &str = "protection.readonly";
pub const NO_EXPORT: &str = "protection.no_export";
pub const UI_LANGUAGE: &str = "ui.language";

/// `denied` reason of each prohibition (and the value of `PageDescriptor.restrictions`).
pub fn reason(name: &str) -> &'static str {
    if name == READONLY {
        "readonly"
    } else {
        "noExport"
    }
}

pub fn truthy(v: &str) -> bool {
    matches!(v.trim().to_ascii_lowercase().as_str(), "true" | "1" | "yes" | "on")
}

/// The first layer that forbids `name`: configuration nodes, then `env` and its ancestors.
pub fn deny_layer(conn: &Connection, name: &str, env: Option<&str>) -> rusqlite::Result<Option<String>> {
    let says = |r: &store::Row| crate::params::get(r, name).is_some_and(|p| truthy(&p.value));
    let mut configs = store::of_kind(conn, KIND_CONFIG)?;
    configs.sort_by_key(|r| r.parent_id.is_some());
    if let Some(r) = configs.iter().find(|r| says(r)) {
        return Ok(Some(r.id.clone()));
    }
    if let Some(e) = env.map(|e| store::get(conn, e)).transpose()?.flatten().filter(|r| r.kind == KIND_ENV) {
        let mut chain = store::ancestors(conn, &e)?;
        chain.push(e);
        if let Some(r) = chain.iter().find(|r| r.deleted_at.is_none() && says(r)) {
            return Ok(Some(r.id.clone()));
        }
    }
    Ok(None)
}

/// `denied` with `reason` and the layer that forbids (§6.3).
pub fn check(conn: &Connection, name: &str, env: Option<&str>) -> KResult<()> {
    match deny_layer(conn, name, env).map_err(crate::util::internal)? {
        Some(layer) => Err(err_p(onedesk_protocol::ErrorCode::Denied, &[("reason", reason(name)), ("layer", &layer)])),
        None => Ok(()),
    }
}

/// `PageDescriptor.restrictions` for a page shown with `env`.
pub fn restrictions(conn: &Connection, env: Option<&str>) -> rusqlite::Result<Vec<String>> {
    let mut out = Vec::new();
    for name in [READONLY, NO_EXPORT] {
        if deny_layer(conn, name, env)?.is_some() {
            out.push(reason(name).to_string());
        }
    }
    Ok(out)
}

/// `params.known` (D327).
pub fn known() -> Vec<KnownParam> {
    let p = |name: &str, ty: ParamType, merge: PolicyMerge, layers: &[&str]| KnownParam {
        name: name.into(),
        param_type: ty,
        merge,
        layers: layers.iter().map(|s| s.to_string()).collect(),
    };
    vec![
        p(UI_LANGUAGE, ParamType::Text, PolicyMerge::Plain, &["config"]),
        p(crate::network::ALLOW_PARAM, ParamType::List, PolicyMerge::AllowList, &["config", "env"]),
        p(READONLY, ParamType::Boolean, PolicyMerge::Deny, &["config", "env"]),
        p(NO_EXPORT, ParamType::Boolean, PolicyMerge::Deny, &["config", "env"]),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truthy_values() {
        for v in ["true", "TRUE", " 1", "yes", "on"] {
            assert!(truthy(v), "{v}");
        }
        for v in ["false", "0", "", "no", "maybe"] {
            assert!(!truthy(v), "{v}");
        }
    }
}
