//! Round 15 (X2, D239): an action's result given as a data file instead of inline content.
//!
//! The action returns `{ output: { type: "table", file, header?, columns? } }` or
//! `{ output: { type: "text", file } }`. `file` is a path relative to the plugin's own folder
//! (`plugin-data/<id>/`) or an absolute path the plugin may read (the same rules as a
//! `transfer` file end). The kernel reads the file itself: its content never passes through the
//! sandbox's memory.
//!
//! - Tables are CSV (RFC 4180, UTF-8, `,`, `"`-quoted, LF or CRLF). An unquoted empty field is
//!   `null`, a quoted empty field is `""` (so a program's NULL and empty text stay apart).
//!   `header` (default true): the first record names the columns. `columns`, if given, replaces
//!   the names and must have as many entries as the records have fields.
//! - The whole file is read once: every record counts toward `total`; at most `MAX_ROWS` rows
//!   and about 6 MB of cells are kept in the run (`truncated`). A table that was cut keeps a copy
//!   of the file in `<workspace>/run-files/` so that `run.export` writes all rows; the copy goes
//!   when the run is deleted.
//! - A file inside the plugin's own folder is handed over: the kernel removes it after reading.
//!   A file in a granted folder stays.
//! - Text: at most `MAX_TEXT_BYTES`, cut at a character boundary.

use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};

use onedesk_protocol::{OutputColumn, RunOutput};
use serde_json::{Map, Value};

/// Cells kept in a run's table (serialized, roughly); the rest only counts toward `total`.
pub const MAX_CELL_BYTES: usize = 6 * 1024 * 1024;
pub const MAX_TEXT_BYTES: usize = 6 * 1024 * 1024;
/// The folder (in the workspace) of full results kept for export.
pub const RUN_FILES: &str = "run-files";

/// Reads CSV records one at a time.
pub struct CsvReader<R: Read> {
    r: BufReader<R>,
    done: bool,
}

impl<R: Read> CsvReader<R> {
    pub fn new(r: R) -> Self {
        CsvReader { r: BufReader::with_capacity(64 * 1024, r), done: false }
    }

    fn byte(&mut self) -> std::io::Result<Option<u8>> {
        let buf = self.r.fill_buf()?;
        if buf.is_empty() {
            return Ok(None);
        }
        let b = buf[0];
        self.r.consume(1);
        Ok(Some(b))
    }

    fn peek(&mut self) -> std::io::Result<Option<u8>> {
        Ok(self.r.fill_buf()?.first().copied())
    }

    /// The next record (`None` at the end). A field is `None` when it was empty and unquoted.
    pub fn record(&mut self) -> std::io::Result<Option<Vec<Option<String>>>> {
        if self.done {
            return Ok(None);
        }
        let mut rec: Vec<Option<String>> = Vec::new();
        let mut field: Vec<u8> = Vec::new();
        let mut quoted = false;
        let mut any = false;
        let finish = |field: &mut Vec<u8>, quoted: bool| -> Option<String> {
            let f = std::mem::take(field);
            if f.is_empty() && !quoted {
                None
            } else {
                Some(String::from_utf8(f).unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned()))
            }
        };
        loop {
            let Some(b) = self.byte()? else {
                self.done = true;
                if !any {
                    return Ok(None);
                }
                rec.push(finish(&mut field, quoted));
                return Ok(Some(rec));
            };
            any = true;
            match b {
                b'"' if field.is_empty() && !quoted => {
                    quoted = true;
                    // Inside quotes until the closing quote; `""` is one quote.
                    loop {
                        match self.byte()? {
                            None => break,
                            Some(b'"') => {
                                if self.peek()? == Some(b'"') {
                                    self.byte()?;
                                    field.push(b'"');
                                } else {
                                    break;
                                }
                            }
                            Some(c) => field.push(c),
                        }
                    }
                }
                b',' => {
                    rec.push(finish(&mut field, quoted));
                    quoted = false;
                }
                b'\r' if self.peek()? == Some(b'\n') => {}
                b'\n' => {
                    rec.push(finish(&mut field, quoted));
                    return Ok(Some(rec));
                }
                c => field.push(c),
            }
        }
    }
}

fn bad(m: impl Into<String>) -> String {
    m.into()
}

fn numeric(v: &str) -> bool {
    !v.is_empty() && v.trim() == v && v.parse::<f64>().is_ok_and(f64::is_finite)
}

/// What reading a data file gave.
pub struct FromFile {
    pub output: RunOutput,
    /// The table was cut: keep the file for a full export.
    pub cut: bool,
}

/// Reads an output data file. `o` is the plugin's output object (without `file`).
pub fn read(path: &Path, o: &Map<String, Value>) -> Result<FromFile, String> {
    let ty = o.get("type").and_then(Value::as_str).unwrap_or_default();
    for k in o.keys() {
        let ok = match ty {
            "table" => ["type", "header", "columns"].contains(&k.as_str()),
            "text" => k == "type",
            _ => false,
        };
        if !ok {
            return Err(bad(format!("{ty:?} output from a file does not take {k:?}")));
        }
    }
    let f = std::fs::File::open(path).map_err(|e| bad(format!("data file: {e}")))?;
    match ty {
        "text" => {
            let mut buf = Vec::new();
            f.take(MAX_TEXT_BYTES as u64 + 4).read_to_end(&mut buf).map_err(|e| e.to_string())?;
            let mut text = String::from_utf8_lossy(&buf).into_owned();
            if text.len() > MAX_TEXT_BYTES {
                let mut i = MAX_TEXT_BYTES;
                while !text.is_char_boundary(i) {
                    i -= 1;
                }
                text.truncate(i);
            }
            Ok(FromFile { output: RunOutput::Text { text }, cut: false })
        }
        "table" => {
            let header = match o.get("header") {
                None => true,
                Some(Value::Bool(b)) => *b,
                Some(_) => return Err(bad("header must be true or false")),
            };
            let given: Option<Vec<OutputColumn>> = match o.get("columns") {
                None => None,
                Some(v) => Some(serde_json::from_value(v.clone()).map_err(|e| format!("columns: {e}"))?),
            };
            let mut rd = CsvReader::new(f);
            let first = if header { rd.record().map_err(|e| e.to_string())? } else { None };
            let mut rows: Vec<Vec<Value>> = Vec::new();
            let (mut total, mut size, mut cut, mut width) = (0u64, 0usize, false, first.as_ref().map(Vec::len));
            if let Some(g) = &given {
                width = Some(g.len());
            }
            while let Some(rec) = rd.record().map_err(|e| e.to_string())? {
                // A blank line is no record (a one-column file's empty value is written `""`).
                if rec.len() == 1 && rec[0].is_none() {
                    continue;
                }
                let w = *width.get_or_insert(rec.len());
                if rec.len() != w {
                    return Err(bad(format!("record {} has {} fields, expected {w}", total + 1, rec.len())));
                }
                total += 1;
                if cut {
                    continue;
                }
                let cost: usize = rec.iter().map(|c| c.as_ref().map_or(4, |s| s.len() + 3)).sum::<usize>() + 2;
                if rows.len() >= crate::runs::MAX_ROWS || size + cost > MAX_CELL_BYTES {
                    cut = true;
                    continue;
                }
                size += cost;
                rows.push(rec.into_iter().map(|c| c.map_or(Value::Null, Value::String)).collect());
            }
            let width = width.unwrap_or(0);
            let columns = match (given, first) {
                (Some(g), Some(f)) if f.len() != g.len() => {
                    return Err(bad(format!("{} columns given, the header has {}", g.len(), f.len())));
                }
                (Some(g), _) => g,
                (None, first) => (0..width)
                    .map(|i| {
                        let label = first.as_ref().and_then(|f| f[i].clone()).unwrap_or_else(|| (i + 1).to_string());
                        let all_numbers = !rows.is_empty()
                            && rows.iter().all(|r| match &r[i] {
                                Value::String(s) => numeric(s),
                                _ => true,
                            })
                            && rows.iter().any(|r| !r[i].is_null());
                        OutputColumn { key: format!("c{i}"), label, numeric: all_numbers.then_some(true) }
                    })
                    .collect(),
            };
            Ok(FromFile { output: RunOutput::Table { columns, rows, total, truncated: cut, paged: Some(true) }, cut })
        }
        other => Err(bad(format!("output type {other:?} cannot come from a file"))),
    }
}

/// Where a run's kept full result is (`<id>.csv`, `<id>.h.csv` when its first record is a header).
pub fn kept(ws: &Path, run: &str) -> Option<(PathBuf, bool)> {
    let dir = ws.join(RUN_FILES);
    [(format!("{run}.h.csv"), true), (format!("{run}.csv"), false)]
        .into_iter()
        .map(|(n, h)| (dir.join(n), h))
        .find(|(p, _)| p.is_file())
}

pub fn keep(ws: &Path, run: &str, from: &Path, header: bool, take: bool) -> std::io::Result<()> {
    let dir = ws.join(RUN_FILES);
    std::fs::create_dir_all(&dir)?;
    let to = dir.join(if header { format!("{run}.h.csv") } else { format!("{run}.csv") });
    if take && std::fs::rename(from, &to).is_ok() {
        return Ok(());
    }
    std::fs::copy(from, &to).map(|_| ())
}

/// Removes kept files whose run is gone.
pub fn sweep(ws: &Path, exists: impl Fn(&str) -> bool) {
    let Ok(rd) = std::fs::read_dir(ws.join(RUN_FILES)) else { return };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let id = name.trim_end_matches(".csv").trim_end_matches(".h");
        if !exists(id) {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn recs(s: &str) -> Vec<Vec<Option<String>>> {
        let mut r = CsvReader::new(s.as_bytes());
        let mut out = vec![];
        while let Some(x) = r.record().unwrap() {
            out.push(x);
        }
        out
    }

    fn o(v: Value) -> Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    #[test]
    fn csv_quotes_line_breaks_and_null_versus_empty() {
        let s = "a,b,c\r\n1,\"x,\"\"y\"\"\nz\",\n,\"\",3\n";
        let r = recs(s);
        assert_eq!(r.len(), 3);
        assert_eq!(r[1], vec![Some("1".into()), Some("x,\"y\"\nz".into()), None]);
        assert_eq!(r[2], vec![None, Some(String::new()), Some("3".into())]);
        // No final line break.
        assert_eq!(recs("a,b"), vec![vec![Some("a".into()), Some("b".into())]]);
        assert!(recs("").is_empty());
    }

    #[test]
    fn a_table_file_is_read_counted_and_typed() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("r.csv");
        std::fs::write(&p, "id,name\n1,ann\n2,\n10,\"\"\n").unwrap();
        let r = read(&p, &o(json!({ "type": "table" }))).unwrap();
        let RunOutput::Table { columns, rows, total, truncated, .. } = r.output else { panic!() };
        assert_eq!(total, 3);
        assert!(!truncated && !r.cut);
        assert_eq!(columns[0].label, "id");
        assert_eq!(columns[0].numeric, Some(true));
        assert_eq!(columns[1].numeric, None);
        assert_eq!(rows[1], vec![json!("2"), Value::Null]);
        assert_eq!(rows[2], vec![json!("10"), json!("")]);
    }

    #[test]
    fn a_long_table_is_cut_but_counted() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("r.csv");
        let mut s = String::from("n\n");
        for i in 0..(crate::runs::MAX_ROWS + 5) {
            s.push_str(&format!("{i}\n"));
        }
        std::fs::write(&p, s).unwrap();
        let r = read(&p, &o(json!({ "type": "table" }))).unwrap();
        let RunOutput::Table { rows, total, truncated, .. } = r.output else { panic!() };
        assert_eq!(total as usize, crate::runs::MAX_ROWS + 5);
        assert_eq!(rows.len(), crate::runs::MAX_ROWS);
        assert!(truncated && r.cut);
    }

    #[test]
    fn ragged_records_unknown_keys_and_mismatched_columns_are_refused() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("r.csv");
        std::fs::write(&p, "a,b\n1\n").unwrap();
        assert!(read(&p, &o(json!({ "type": "table" }))).is_err());
        std::fs::write(&p, "a,b\n1,2\n").unwrap();
        assert!(read(&p, &o(json!({ "type": "table", "rows": [] }))).is_err());
        assert!(read(&p, &o(json!({ "type": "link" }))).is_err());
        let cols = json!([{ "key": "x", "label": "X" }]);
        assert!(read(&p, &o(json!({ "type": "table", "columns": cols }))).is_err());
        let cols = json!([{ "key": "x", "label": "X" }, { "key": "y", "label": "Y" }]);
        let r = read(&p, &o(json!({ "type": "table", "header": false, "columns": cols }))).unwrap();
        let RunOutput::Table { total, columns, .. } = r.output else { panic!() };
        assert_eq!((total, columns[1].label.as_str()), (2, "Y"));
    }

    #[test]
    fn text_is_cut_at_a_character_boundary() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("t.txt");
        std::fs::write(&p, "中".repeat(MAX_TEXT_BYTES / 3 + 2)).unwrap();
        let r = read(&p, &o(json!({ "type": "text" }))).unwrap();
        let RunOutput::Text { text } = r.output else { panic!() };
        assert!(text.len() <= MAX_TEXT_BYTES && text.ends_with('中'));
    }
}
