//! Round 11 (D379, D382): interface languages from plugins, and startup pages. The kernel only
//! looks things up: which languages enabled plugins provide and one language's shell texts
//! (read from the package, never activating the plugin). It knows no language but the shell's
//! own fallback (`SHELL_LOCALE`).

use std::collections::BTreeMap;

use onedesk_protocol::*;
use serde_json::Value;

use crate::kernel::Inner;
use crate::manifest::{package_program, Plugin, MAX_LANGUAGE_FILE};
use crate::util::{err_p, KResult};

pub const METHODS: &[&str] = &[method11::I18N_LANGUAGES, method11::I18N_SHELL];

/// The shell's own language entry.
fn shell_language() -> LanguageInfo {
    LanguageInfo { locale: SHELL_LOCALE.into(), name: "English".into(), plugin: None }
}

impl Inner {
    /// `i18n.languages`: the shell's English first, then what enabled plugins provide, by
    /// `locale`. The same `locale` from two plugins: the one with the smaller plugin id.
    pub fn languages(&self) -> Vec<LanguageInfo> {
        let mut out = vec![shell_language()];
        out.extend(self.language_sources().into_iter().map(|(l, _)| l));
        out
    }

    /// Plugin-provided languages (locale-sorted) with the plugin version that provides each.
    fn language_sources(&self) -> Vec<(LanguageInfo, &'static Plugin)> {
        let mut by_locale: BTreeMap<String, (LanguageInfo, &'static Plugin)> = BTreeMap::new();
        // `ids()` is sorted: the first plugin to give a locale keeps it.
        for id in self.registry.ids() {
            let Some(p) = self.registry.plugin(&id) else { continue };
            if p.manifest.languages.is_empty() || !self.plugin_enabled(&id) {
                continue;
            }
            for l in &p.manifest.languages {
                // The shell's own language is never replaced by a plugin.
                if l.locale.eq_ignore_ascii_case(SHELL_LOCALE) {
                    continue;
                }
                by_locale
                    .entry(l.locale.to_ascii_lowercase())
                    .or_insert_with(|| (LanguageInfo { locale: l.locale.clone(), name: l.name.clone(), plugin: Some(id.clone()) }, p));
            }
        }
        let mut out: Vec<_> = by_locale.into_values().collect();
        out.sort_by(|a, b| a.0.locale.cmp(&b.0.locale));
        out
    }

    /// `i18n.shell`: the language's texts; empty for the shell's own language, an unknown or
    /// unavailable one, and a file that cannot be used (too large, not a flat string table).
    pub fn shell_texts(&self, locale: &str) -> I18nShellResult {
        let empty = || I18nShellResult { locale: locale.to_string(), texts: BTreeMap::new() };
        let Some((info, p)) = self.language_sources().into_iter().find(|(l, _)| l.locale.eq_ignore_ascii_case(locale)) else {
            return empty();
        };
        let Some(decl) = p.manifest.languages.iter().find(|l| l.locale == info.locale) else { return empty() };
        match read_texts(p, &decl.shell) {
            Ok(texts) => I18nShellResult { locale: info.locale, texts },
            Err(why) => {
                eprintln!("onedesk: language file {} of {}@{} not used: {why}", decl.shell, p.id, p.version);
                I18nShellResult { locale: info.locale, texts: BTreeMap::new() }
            }
        }
    }

    /// Round 11 (D382): `page:<plugin>/<page>` of each enabled plugin's startup page, by plugin id.
    pub fn startup_pages(&self) -> Vec<String> {
        self.registry
            .ids()
            .into_iter()
            .filter_map(|id| {
                let p = self.registry.plugin(&id)?;
                let pg = p.manifest.contributes.pages.iter().find(|pg| pg.startup)?;
                self.plugin_enabled(&id).then(|| format!("page:{id}/{}", pg.id))
            })
            .collect()
    }

    /// Called whenever `plugins` is published: if the languages changed, `languages` follows.
    pub(crate) fn check_languages(&self) {
        let now = self.languages();
        let mut seen = self.languages_seen.lock().unwrap();
        if seen.as_ref() != Some(&now) {
            let first = seen.is_none();
            *seen = Some(now);
            drop(seen);
            if !first {
                self.emit(topic11::LANGUAGES, None, None);
            }
        }
    }

    pub(crate) fn handle11(&self, m: &str, params: Value) -> KResult<Value> {
        let v = match m {
            method11::I18N_LANGUAGES => serde_json::to_value(self.languages()),
            method11::I18N_SHELL => {
                let p: I18nShellParams = crate::kernel::parse(params)?;
                serde_json::to_value(self.shell_texts(&p.locale))
            }
            _ => return Err(err_p(ErrorCode::UnknownMethod, &[("method", m)])),
        };
        v.map_err(crate::util::internal)
    }
}

/// Reads a flat `{ key: text }` file of the package (at most `MAX_LANGUAGE_FILE`).
fn read_texts(p: &Plugin, rel: &str) -> Result<BTreeMap<String, String>, &'static str> {
    let path = package_program(&p.dir, rel).ok_or("outside the package")?;
    let meta = std::fs::metadata(&path).map_err(|_| "missing")?;
    if !meta.is_file() {
        return Err("not a file");
    }
    if meta.len() > MAX_LANGUAGE_FILE {
        return Err("too large");
    }
    let bytes = std::fs::read(&path).map_err(|_| "unreadable")?;
    if bytes.len() as u64 > MAX_LANGUAGE_FILE {
        return Err("too large");
    }
    let raw: serde_json::Map<String, Value> = serde_json::from_slice(&bytes).map_err(|_| "not a JSON object")?;
    raw.into_iter().map(|(k, v)| match v {
        Value::String(s) => Ok((k, s)),
        _ => Err("not a flat table of strings"),
    }).collect()
}
