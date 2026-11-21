// Query catalog plugin: `.sql` files in the folders the user granted become read-only resources (kind
// "entry", external key = the file's path). The file is the source: the page binds nothing and is read-only.
// Each file starts with a YAML header (id, title, description, params, permissions, tags, datasource); a file
// whose header cannot be read is skipped and listed with the reason. In the text, `:name` is a parameter (as
// in the SQL plugin) and `{{entity}}` / `{{entity.field}}` are placeholders replaced from the mapping file by
// real table and column names; a time-versioned entity becomes "the latest version in force at a moment" and
// the page gets an "as of" field. The syntax is this plugin's own (rule 5); README.md describes both files.
// Runs go through the data source plugin's read-only `query`; "save as SQL" through the SQL plugin's `create`.
// Sandbox rules: no console, timers or fetch; everything through ctx.host.

export const PLUGIN = "org.onedesk.catalog";
export const KIND = "entry";
export const DATASOURCE = "org.onedesk.datasource";
export const SOURCE_KIND = "org.onedesk.datasource:source";
export const SQL_CREATE = "org.onedesk.sql:create";
export const AS_OF = "as_of";
const REPORT_KEY = "lastReport";
const SENT_KEY = "sent";
const SENT_RUNS = 30;
const SENT_MAX = 6000;
const MAPPING_NAMES = ["mapping.yaml", "mapping.yml", "mapping.json"];
const TYPES = ["text", "number", "date", "datetime", "time", "enum"];
const MAX_DEPTH = 12;
const MAX_FILES = 5000;
const PAGE = 500;

/* ---------------------------------------------------------------- text */

export function tr(ctx, key, vars) {
  const label = ctx.t(key);
  let text = typeof label === "string" ? label : label[ctx.locale] || label["en-US"] || key;
  for (const k of Object.keys(vars || {})) text = text.split(`{${k}}`).join(String(vars[k]));
  return text;
}

/* ---------------------------------------------------------------- YAML (the subset headers and mappings use) */

// Block maps and lists by indentation, `- ` items (scalars or maps), inline `[a, b]` and `{a: b}`, quoted
// scalars, `#` comments, `|` / `>` blocks. Scalars stay strings except true/false/null. Throws
// { yamlLine, yamlReason } on anything else, so the caller can say which line.
export function parseYaml(text) {
  const lines = [];
  String(text || "")
    .split("\n")
    .forEach((raw, i) => {
      const noTab = raw.replace(/\r$/, "");
      if (/^\s*\t/.test(noTab)) throw yamlError(i + 1, "tab");
      const body = stripComment(noTab);
      if (body.trim() === "" || body.trim() === "---" || body.trim() === "...") {
        lines.push({ n: i + 1, indent: -1, text: "", raw: noTab });
        return;
      }
      lines.push({ n: i + 1, indent: body.length - body.trimStart().length, text: body.trim(), raw: noTab });
    });
  const st = { lines, i: 0 };
  skipBlank(st);
  if (st.i >= lines.length) return null;
  const v = parseBlock(st, lines[st.i].indent);
  skipBlank(st);
  if (st.i < lines.length) throw yamlError(lines[st.i].n, "indent");
  return v;
}

function yamlError(line, reason) {
  return { yamlLine: line, yamlReason: reason };
}

function stripComment(line) {
  let q = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === q) q = q === "'" && line[i + 1] === "'" ? (i++, q) : "";
    } else if (c === '"' || c === "'") q = c;
    else if (c === "#" && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i).replace(/\s+$/, "");
  }
  return line.replace(/\s+$/, "");
}

function skipBlank(st) {
  while (st.i < st.lines.length && st.lines[st.i].indent < 0) st.i++;
}

function parseBlock(st, indent) {
  const first = st.lines[st.i];
  if (first.text.startsWith("- ") || first.text === "-") return parseList(st, indent);
  return parseMap(st, indent);
}

function parseList(st, indent) {
  const out = [];
  for (;;) {
    skipBlank(st);
    const l = st.lines[st.i];
    if (!l || l.indent < indent) return out;
    if (l.indent > indent) throw yamlError(l.n, "indent");
    if (!(l.text.startsWith("- ") || l.text === "-")) return out; // a key of the enclosing map
    const rest = l.text === "-" ? "" : l.text.slice(2).trim();
    st.i++;
    if (rest === "") {
      skipBlank(st);
      const nx = st.lines[st.i];
      out.push(nx && nx.indent > indent ? parseBlock(st, nx.indent) : null);
    } else if (keyOf(rest)) {
      // `- key: value` starts a map whose other keys sit under the text after "- ".
      const inner = l.indent + (l.text.length - rest.length);
      st.lines[--st.i] = { n: l.n, indent: inner, text: rest, raw: l.raw };
      out.push(parseMap(st, inner));
    } else out.push(scalar(rest, l.n));
  }
}

function keyOf(text) {
  const m = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s"'{[#][^:#]*?)\s*:(\s|$)/.exec(text);
  if (!m) return null;
  const k = m[1];
  return { key: k.startsWith('"') || k.startsWith("'") ? unquote(k) : k.trim(), rest: text.slice(m[0].length).trim() };
}

function parseMap(st, indent) {
  const out = {};
  for (;;) {
    skipBlank(st);
    const l = st.lines[st.i];
    if (!l || l.indent < indent) return out;
    if (l.indent > indent) throw yamlError(l.n, "indent");
    const kv = keyOf(l.text);
    if (!kv) throw yamlError(l.n, "mapKey");
    if (Object.prototype.hasOwnProperty.call(out, kv.key)) throw yamlError(l.n, "duplicateKey");
    st.i++;
    if (kv.rest === "|" || kv.rest === ">" || kv.rest === "|-" || kv.rest === ">-") {
      out[kv.key] = blockScalar(st, indent, kv.rest[0] === ">");
    } else if (kv.rest === "") {
      skipBlank(st);
      const nx = st.lines[st.i];
      // a list may sit at the same indent as its key
      if (nx && (nx.indent > indent || (nx.indent === indent && (nx.text.startsWith("- ") || nx.text === "-")))) out[kv.key] = parseBlock(st, nx.indent);
      else out[kv.key] = null;
    } else out[kv.key] = scalar(kv.rest, l.n);
  }
}

function blockScalar(st, indent, fold) {
  const parts = [];
  let inner = -1;
  while (st.i < st.lines.length) {
    const l = st.lines[st.i];
    const lead = l.raw.length - l.raw.trimStart().length;
    if (l.raw.trim() !== "" && lead <= indent) break;
    if (l.raw.trim() !== "" && inner < 0) inner = lead;
    parts.push(l.raw.trim() === "" ? "" : l.raw.slice(Math.min(inner, lead)));
    st.i++;
  }
  while (parts.length && parts[parts.length - 1] === "") parts.pop();
  return fold ? parts.join(" ").replace(/ {2,}/g, " ").trim() : parts.join("\n");
}

function unquote(s) {
  if (s.startsWith('"')) return s.slice(1, -1).replace(/\\(["\\nt])/g, (_, c) => (c === "n" ? "\n" : c === "t" ? "\t" : c));
  return s.slice(1, -1).replace(/''/g, "'");
}

function splitFlow(inner, n) {
  const out = [];
  let depth = 0;
  let q = "";
  let cur = "";
  for (const c of inner) {
    if (q) {
      cur += c;
      if (c === q) q = "";
      continue;
    }
    if (c === '"' || c === "'") q = c;
    if (c === "[" || c === "{") depth++;
    if (c === "]" || c === "}") depth--;
    if (c === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  if (q || depth !== 0) throw yamlError(n, "flow");
  if (cur.trim() !== "") out.push(cur.trim());
  return out;
}

function scalar(text, n) {
  const t = text.trim();
  if (t.startsWith("[")) {
    if (!t.endsWith("]")) throw yamlError(n, "flow");
    return splitFlow(t.slice(1, -1), n).map((x) => scalar(x, n));
  }
  if (t.startsWith("{")) {
    if (!t.endsWith("}")) throw yamlError(n, "flow");
    const out = {};
    for (const part of splitFlow(t.slice(1, -1), n)) {
      const kv = keyOf(part);
      if (!kv) throw yamlError(n, "mapKey");
      out[kv.key] = kv.rest === "" ? null : scalar(kv.rest, n);
    }
    return out;
  }
  if (t.startsWith('"') || t.startsWith("'")) {
    if (t.length < 2 || t[t.length - 1] !== t[0]) throw yamlError(n, "quote");
    return unquote(t);
  }
  if (t === "true" || t === "false") return t === "true";
  if (t === "null" || t === "~") return null;
  return t;
}

/* ---------------------------------------------------------------- query files */

// The YAML header: a leading `/* --- … --- */` block, or leading `-- ---` … `-- ---` comment lines.
// Returns { yaml, body, offset } (offset = lines before the body) or null when there is none.
export function splitHeader(text) {
  const s = String(text || "").replace(/^\uFEFF/, "");
  const lines = s.split("\n");
  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i++;
  const first = (lines[i] || "").trim();
  if (/^\/\*\s*---\s*$/.test(first)) {
    for (let j = i + 1; j < lines.length; j++) {
      if (/^\s*---\s*\*\/\s*$/.test(lines[j])) return { yaml: lines.slice(i + 1, j).join("\n"), body: lines.slice(j + 1).join("\n").replace(/^\s*\n/, ""), offset: j + 1 };
    }
    return { yaml: null, body: s, offset: 0, unclosed: true };
  }
  if (/^--\s*---\s*$/.test(first)) {
    const yaml = [];
    for (let j = i + 1; j < lines.length; j++) {
      if (/^--\s*---\s*$/.test(lines[j].trim())) return { yaml: yaml.join("\n"), body: lines.slice(j + 1).join("\n").replace(/^\s*\n/, ""), offset: j + 1 };
      if (!/^\s*--/.test(lines[j])) break;
      yaml.push(lines[j].replace(/^\s*-- ?/, ""));
    }
    return { yaml: null, body: s, offset: 0, unclosed: true };
  }
  return null;
}

const ID_RE = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/;
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function str(v) {
  return v === undefined || v === null ? "" : typeof v === "string" ? v : String(v);
}

function listOf(v) {
  if (v === undefined || v === null || v === "") return [];
  return (Array.isArray(v) ? v : [v]).map(str).filter(Boolean);
}

// Header `params`: a list of maps ({ name, type, required, description, values, max }), a list of names, or a
// map name → spec. Returns { params } or { reason, detail }.
export function normalizeParams(raw) {
  if (raw === undefined || raw === null) return { params: [] };
  let items = [];
  if (Array.isArray(raw)) items = raw.map((p) => (typeof p === "string" ? { name: p } : p));
  else if (typeof raw === "object") items = Object.keys(raw).map((k) => ({ ...(raw[k] && typeof raw[k] === "object" ? raw[k] : { type: raw[k] }), name: k }));
  else return { reason: "badParams", detail: "" };
  const params = [];
  for (const p of items) {
    if (!p || typeof p !== "object") return { reason: "badParams", detail: "" };
    const name = str(p.name);
    if (!NAME_RE.test(name)) return { reason: "badParam", detail: name };
    if (params.some((x) => x.name === name)) return { reason: "duplicateParam", detail: name };
    const values = listOf(p.values || p.options);
    let type = str(p.type) || (values.length ? "enum" : "text");
    if (type === "string") type = "text";
    if (type === "timestamp") type = "datetime";
    if (!TYPES.includes(type)) return { reason: "badParamType", detail: `${name}: ${type}` };
    const max = /^\d+$/.test(str(p.max)) ? Number(p.max) : 0;
    params.push({ name, type, required: p.required === true || p.required === "true", description: str(p.description), values, max });
  }
  return { params };
}

// One file → { ok: true, entry } or { ok: false, reason, detail }.
export function parseEntry(path, text) {
  const h = splitHeader(text);
  if (!h) return { ok: false, reason: "noHeader", detail: "" };
  if (h.unclosed) return { ok: false, reason: "unclosedHeader", detail: "" };
  let meta;
  try {
    meta = parseYaml(h.yaml);
  } catch (e) {
    if (e && e.yamlLine) return { ok: false, reason: "badHeader", detail: `${e.yamlLine}: ${e.yamlReason}` };
    return { ok: false, reason: "badHeader", detail: "" };
  }
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return { ok: false, reason: "badHeader", detail: "" };
  const id = str(meta.id).trim();
  if (!id) return { ok: false, reason: "noId", detail: "" };
  if (!ID_RE.test(id)) return { ok: false, reason: "badId", detail: id };
  const p = normalizeParams(meta.params);
  if (p.reason) return { ok: false, reason: p.reason, detail: p.detail };
  if (!h.body.trim()) return { ok: false, reason: "noBody", detail: "" };
  return {
    ok: true,
    entry: {
      id,
      title: str(meta.title || meta.name).trim(),
      description: str(meta.description).trim(),
      params: p.params,
      permissions: listOf(meta.permissions !== undefined ? meta.permissions : meta.permission),
      tags: listOf(meta.tags),
      datasource: str(meta.datasource).trim(),
      sql: h.body.replace(/\s+$/, ""),
      path,
    },
  };
}

/* ---------------------------------------------------------------- SQL text */

const IDENT_CHAR = /[A-Za-z0-9_$\u0080-\uffff]/;
const DOLLAR = /^\$([A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*)?\$/;
const PLACEHOLDER = /^\{\{\s*([A-Za-z_][A-Za-z0-9_]*)(?:\.([A-Za-z_][A-Za-z0-9_]*))?\s*\}\}/;

// Pieces of SQL: { raw }, { param } for `:name`, { entity, field } for `{{entity}}` / `{{entity.field}}`.
// Strings, quoted names, dollar quotes and comments are raw (as in the SQL plugin); so is `::`.
export function tokenize(sql) {
  const out = [];
  let raw = "";
  const s = String(sql || "");
  let i = 0;
  const flush = () => {
    if (raw) out.push({ raw });
    raw = "";
  };
  while (i < s.length) {
    const c = s[i];
    const next = s[i + 1];
    if (c === "'" || c === '"') {
      const escapes = c === "'" && i > 0 && /[eE]/.test(s[i - 1]) && !(i > 1 && IDENT_CHAR.test(s[i - 2]));
      let j = i + 1;
      while (j < s.length) {
        if (escapes && s[j] === "\\") {
          j += 2;
          continue;
        }
        if (s[j] === c) {
          if (s[j + 1] === c) {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      raw += s.slice(i, j + 1);
      i = j + 1;
    } else if (c === "$" && !(i > 0 && IDENT_CHAR.test(s[i - 1])) && DOLLAR.test(s.slice(i, i + 140))) {
      const tag = DOLLAR.exec(s.slice(i, i + 140))[0];
      const end = s.indexOf(tag, i + tag.length);
      const stop = end < 0 ? s.length : end + tag.length;
      raw += s.slice(i, stop);
      i = stop;
    } else if (c === "-" && next === "-") {
      let j = i;
      while (j < s.length && s[j] !== "\n") j++;
      raw += s.slice(i, j);
      i = j;
    } else if (c === "/" && next === "*") {
      let depth = 1;
      let j = i + 2;
      while (j < s.length && depth > 0) {
        if (s[j] === "/" && s[j + 1] === "*") (depth++, (j += 2));
        else if (s[j] === "*" && s[j + 1] === "/") (depth--, (j += 2));
        else j++;
      }
      raw += s.slice(i, j);
      i = j;
    } else if (c === "{" && next === "{" && PLACEHOLDER.test(s.slice(i, i + 200))) {
      const m = PLACEHOLDER.exec(s.slice(i, i + 200));
      flush();
      out.push(m[2] ? { entity: m[1], field: m[2] } : { entity: m[1] });
      i += m[0].length;
    } else if (c === ":" && next === ":") {
      raw += "::";
      i += 2;
    } else if (c === ":" && /[A-Za-z_]/.test(next || "") && !(i > 0 && s[i - 1] === ":")) {
      let j = i + 1;
      while (j < s.length && /[A-Za-z0-9_]/.test(s[j])) j++;
      flush();
      out.push({ param: s.slice(i + 1, j) });
      i = j;
    } else {
      raw += c;
      i++;
    }
  }
  flush();
  return out;
}

export function paramNames(sql) {
  const names = [];
  for (const t of tokenize(sql)) if (t.param !== undefined && !names.includes(t.param)) names.push(t.param);
  return names;
}

export function placeholders(sql) {
  const out = [];
  for (const t of tokenize(sql)) {
    if (t.entity === undefined) continue;
    const name = t.field ? `${t.entity}.${t.field}` : t.entity;
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

export function sqlLiteral(value) {
  if (value === null || value === undefined) return "NULL";
  const v = String(value);
  if (v.includes("\0")) throw new Error("NUL");
  return `'${v.replace(/'/g, "''")}'`;
}

// PostgreSQL's reserved words: as names they need quotes.
const RESERVED = new Set(
  "all analyse analyze and any array as asc asymmetric both case cast check collate column constraint create current_catalog current_date current_role current_time current_timestamp current_user default deferrable desc distinct do else end except false fetch for foreign from grant group having in initially intersect into lateral leading limit localtime localtimestamp not null offset on only or order placing primary references returning select session_user some symmetric system_user table then to trailing true union unique user using variadic when where window with".split(" "),
);

// A name as SQL: plain lower-case names stay as they are, others (and reserved words) are double-quoted
// (quotes doubled). `schema.table` is quoted part by part.
export function quoteIdent(name) {
  return String(name)
    .split(".")
    .map((p) => (/^[a-z_][a-z0-9_$]*$/.test(p) && !RESERVED.has(p) ? p : `"${p.replace(/"/g, '""')}"`))
    .join(".");
}

export function toSqlValue(type, value) {
  if (type === "datetime") {
    if (/Z$|[+-]\d\d:\d\d$/.test(value)) return value;
    return value.length === 16 ? `${value}:00Z` : `${value}Z`;
  }
  return value;
}

export function checkValue(decl, value) {
  if (value === null) return decl.required ? "required" : null;
  if (decl.type === "number" && !/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(value.trim())) return "number";
  if (decl.type === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(value)) return "date";
  if (decl.type === "time" && !/^\d{2}:\d{2}(:\d{2})?$/.test(value)) return "time";
  if (decl.type === "datetime" && !/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d\d:\d\d)?$/.test(value)) return "datetime";
  if (decl.type === "enum" && decl.values.length > 0 && !decl.values.includes(value)) return "enum";
  if (decl.max > 0 && value.length > decl.max) return "max";
  return null;
}

export function renderSql(sql, values, decls) {
  let out = "";
  for (const t of tokenize(sql)) {
    if (t.param === undefined) {
      out += t.raw !== undefined ? t.raw : t.field ? `{{${t.entity}.${t.field}}}` : `{{${t.entity}}}`;
      continue;
    }
    const v = values[t.param];
    const decl = (decls || []).find((d) => d.name === t.param);
    const lit = sqlLiteral(v === undefined || v === null || v === "" ? null : toSqlValue(decl ? decl.type : "text", String(v)));
    // `E:p` / `U&:p` turn the literal into an escape string, where a backslash escapes: double it too (review #9).
    out += lit !== "NULL" && /(^|[^A-Za-z0-9_$])([eE]|[uU]&)$/.test(out) ? lit.replace(/\\/g, "\\\\") : lit;
  }
  return out;
}

/* ---------------------------------------------------------------- mapping */

// The mapping file (README.md): { entities: { NAME: { table, description, columns, versioned } } }.
// Returns { mapping, problems } — problems are { reason, detail } of entries that were left out.
export function normalizeMapping(raw, path) {
  const problems = [];
  const entities = {};
  const src = raw && typeof raw === "object" && !Array.isArray(raw) ? raw.entities || raw.tables || raw : null;
  if (!src || typeof src !== "object" || Array.isArray(src)) return { mapping: { path: path || "", entities }, problems: [{ reason: "mappingShape", detail: "" }] };
  for (const name of Object.keys(src)) {
    const e = src[name];
    if (!NAME_RE.test(name)) {
      problems.push({ reason: "mappingName", detail: name });
      continue;
    }
    const spec = typeof e === "string" ? { table: e } : e;
    if (!spec || typeof spec !== "object" || !str(spec.table).trim()) {
      problems.push({ reason: "mappingTable", detail: name });
      continue;
    }
    const columns = {};
    const rawCols = spec.columns || spec.fields || {};
    if (rawCols && typeof rawCols === "object" && !Array.isArray(rawCols)) {
      for (const f of Object.keys(rawCols)) {
        const c = rawCols[f];
        const col = typeof c === "string" ? { column: c, description: "" } : c && typeof c === "object" ? { column: str(c.column || f), description: str(c.description) } : { column: f, description: "" };
        if (!NAME_RE.test(f) || !col.column) {
          problems.push({ reason: "mappingColumn", detail: `${name}.${f}` });
          continue;
        }
        columns[f] = col;
      }
    } else if (Array.isArray(rawCols)) {
      for (const c of rawCols.map(str)) if (NAME_RE.test(c)) columns[c] = { column: c, description: "" };
    }
    const out = { table: str(spec.table).trim(), description: str(spec.description).trim(), columns };
    if (spec.versioned) {
      const v = spec.versioned === true ? {} : spec.versioned;
      const key = listOf(v.key);
      const from = str(v.from || v.validFrom).trim();
      if (key.length === 0 || !from) {
        problems.push({ reason: "mappingVersioned", detail: name });
      } else {
        out.versioned = { key, from };
        if (str(v.to || v.validTo).trim()) out.versioned.to = str(v.to || v.validTo).trim();
        if (str(v.deleted).trim()) out.versioned.deleted = str(v.deleted).trim();
      }
    }
    entities[name] = out;
  }
  return { mapping: { path: path || "", entities }, problems };
}

export function parseMapping(text, path) {
  let raw;
  try {
    raw = /\.json$/i.test(path || "") ? JSON.parse(text) : parseYaml(text);
  } catch (e) {
    const detail = e && e.yamlLine ? `${e.yamlLine}: ${e.yamlReason}` : "";
    return { mapping: { path: path || "", entities: {} }, problems: [{ reason: "mappingParse", detail }] };
  }
  return normalizeMapping(raw, path);
}

/* ---------------------------------------------------------------- expansion */

const AFTER_TABLE_KEYWORDS = new Set(
  "where join left right inner outer full cross on group order limit union except intersect having window offset fetch for using natural lateral returning set values".split(" "),
);

// `:as_of` is kept as a parameter: empty means now().
export function asOfExpr(param) {
  return `COALESCE(CAST(:${param || AS_OF} AS timestamptz), now())`;
}

// "The latest version in force at T" of a time-versioned table, as a subquery.
export function versionedSubquery(table, v, at) {
  const key = v.key.map(quoteIdent).join(", ");
  const from = quoteIdent(v.from);
  let where = `${from} <= ${at}`;
  if (v.to) where += ` AND (${quoteIdent(v.to)} IS NULL OR ${quoteIdent(v.to)} > ${at})`;
  const latest = `SELECT DISTINCT ON (${key}) * FROM ${quoteIdent(table)} WHERE ${where} ORDER BY ${key}, ${from} DESC`;
  if (!v.deleted) return `(${latest})`;
  return `(SELECT * FROM (${latest}) AS od_v WHERE NOT od_v.${quoteIdent(v.deleted)})`;
}

// Replaces placeholders from the mapping. Returns { sql, unmapped, versioned } — `sql` still has its
// `:params` (and `:as_of` when a time-versioned entity is used); unmapped placeholders stay as written.
export function expand(sql, mapping) {
  const entities = (mapping && mapping.entities) || {};
  const tokens = tokenize(sql);
  const unmapped = [];
  let versioned = false;
  let out = "";
  tokens.forEach((t, i) => {
    if (t.raw !== undefined) return void (out += t.raw);
    if (t.param !== undefined) return void (out += `:${t.param}`);
    const e = entities[t.entity];
    const written = t.field ? `{{${t.entity}.${t.field}}}` : `{{${t.entity}}}`;
    if (!e || (t.field && !e.columns[t.field])) {
      const name = t.field ? `${t.entity}.${t.field}` : t.entity;
      if (!unmapped.includes(name)) unmapped.push(name);
      return void (out += written);
    }
    if (t.field) return void (out += quoteIdent(e.columns[t.field].column));
    if (!e.versioned) return void (out += quoteIdent(e.table));
    versioned = true;
    out += versionedSubquery(e.table, e.versioned, asOfExpr());
    // A subquery in FROM needs a name: add one unless the text names it already.
    const next = tokens[i + 1];
    const word = next && next.raw !== undefined ? /^\s*([A-Za-z_"][A-Za-z0-9_]*)?/.exec(next.raw)[1] : undefined;
    if (!word || AFTER_TABLE_KEYWORDS.has(word.toLowerCase())) out += ` AS ${quoteIdent(t.entity)}`;
  });
  return { sql: out, unmapped, versioned };
}

/* ---------------------------------------------------------------- checks (A8) */

// Warnings of an entry: [{ key, vars }] — the page shows them as a warning strip.
export function checks(entry, mapping, mappingProblem) {
  const out = [];
  const used = paramNames(entry.sql);
  const declared = entry.params.map((p) => p.name);
  const { versioned } = expand(entry.sql, mapping);
  for (const n of used) if (!declared.includes(n)) out.push({ key: "warn.undeclared", vars: { name: n } });
  for (const n of declared) if (!used.includes(n) && !(versioned && n === AS_OF)) out.push({ key: "warn.unused", vars: { name: n } });
  const ph = placeholders(entry.sql);
  if (ph.length > 0 && mappingProblem) out.push({ key: "warn.noMapping", vars: { reason: mappingProblem } });
  else for (const n of expand(entry.sql, mapping).unmapped) out.push({ key: "warn.unmapped", vars: { name: n } });
  return out;
}

/* ---------------------------------------------------------------- grouping (A9) */

// Groups of an id: by its first two segments; the last segment is the entry itself.
// "sales.orders.recent" → ["sales", "sales.orders"]; "sales.top" → ["sales"]; "top" → [].
export function groupsOf(id) {
  const parts = String(id).split(".");
  const out = [];
  for (let i = 1; i <= Math.min(2, parts.length - 1); i++) out.push(parts.slice(0, i).join("."));
  return out;
}

const GROUP = "g:";

// Tree nodes under `parentKey` ("" = root) from the catalog's resources.
// D422: entries whose file is gone stay in the tree, marked (provided nodes cannot carry a state: a warning
// icon and a badge), so they can be opened and their history read; only search drops them.
export function treeChildren(resources, parentKey, missingBadge) {
  const live = resources.filter((r) => !r.deleted);
  const parent = parentKey ? parentKey.slice(GROUP.length) : "";
  const groups = new Set();
  const entries = [];
  for (const r of live) {
    const id = catalogId(r);
    const gs = groupsOf(id);
    const at = gs.length ? gs[gs.length - 1] : "";
    if (at === parent) entries.push(r);
    const idx = parent ? gs.indexOf(parent) : -1;
    const child = parent ? (idx >= 0 ? gs[idx + 1] : undefined) : gs[0];
    if (child) groups.add(child);
  }
  const g = [...groups].sort().map((k) => ({ key: GROUP + k, label: k.split(".").pop(), icon: "folder", expandable: true }));
  const e = entries
    .sort((a, b) => (catalogId(a) < catalogId(b) ? -1 : catalogId(a) > catalogId(b) ? 1 : 0))
    .map((r) => {
      const n = { key: r.id, label: r.name || catalogId(r), icon: "file-search", expandable: false, target: `resource:${r.id}` };
      if (isMissing(r)) (n.icon = "triangle-alert"), (n.badge = missingBadge || "missing");
      return n;
    });
  return [...g, ...e];
}

// A resource whose file is gone (round16-protocol.md §2.3: `missing: true`, shown as broken/sourceMissing).
export function isMissing(r) {
  return !!r && r.missing === true;
}

function catalogId(r) {
  return (r.body && typeof r.body.id === "string" && r.body.id) || r.name || r.id;
}

export function treePath(resources, key) {
  if (key.startsWith(GROUP)) {
    const k = key.slice(GROUP.length);
    return [...groupsOf(`${k}.x`).map((g) => GROUP + g)];
  }
  const r = resources.find((x) => x.id === key);
  if (!r) return [key];
  return [...groupsOf(catalogId(r)).map((g) => GROUP + g), key];
}

/* ---------------------------------------------------------------- files and sync (A1, A3, A4, A5) */

// Review #6: a folder is entered once by its real path (`files.stat` resolves links), so a link back up does
// not loop; when the depth or file limit cuts the walk short, `st.truncated` says so.
async function walk(ctx, dir, st, depth) {
  if (depth > MAX_DEPTH) return void (st.truncated = true);
  let real = dir;
  try {
    real = (await ctx.host.files.stat(dir)).path || dir;
  } catch (e) {
    real = dir;
  }
  if (st.visited.has(real)) return;
  st.visited.add(real);
  let offset = 0;
  for (;;) {
    const page = await ctx.host.files.list(dir, { offset, limit: PAGE });
    for (const e of page.entries || []) {
      if (e.hidden || String(e.name).startsWith(".")) continue;
      if (e.dir) await walk(ctx, e.path, st, depth + 1);
      else if (/\.sql$/i.test(e.name)) {
        if (st.files.length >= MAX_FILES) st.truncated = true;
        else if (!st.seen.has(e.path)) (st.seen.add(e.path), st.files.push(e.path));
      }
    }
    if (page.next === undefined || page.next === null) return;
    offset = page.next;
  }
}

// { files, truncated }
export async function listSqlFiles(ctx) {
  const roots = (await ctx.host.files.roots()) || [];
  const st = { files: [], seen: new Set(), visited: new Set(), truncated: false };
  for (const r of roots) await walk(ctx, r.path, st, 0);
  return { files: st.files.sort(), truncated: st.truncated };
}

// The mapping: the `mappingFile` setting, else mapping.yaml / .yml / .json at the top of a granted folder.
// Returns { mapping, problem } — problem is a reason key, "" when the file was read.
export async function loadMapping(ctx) {
  let configured = "";
  try {
    configured = String((await ctx.host.settings.get("mappingFile")) || "").trim();
  } catch (e) {
    configured = "";
  }
  // Review #17: a relative path would mean the plugin's own folder; only absolute paths are mapping files.
  if (configured && !configured.startsWith("/")) return { mapping: { path: configured, entities: {} }, problem: "mappingNotAbsolute", problems: [] };
  const candidates = [];
  if (configured) candidates.push(configured);
  else {
    const roots = (await ctx.host.files.roots()) || [];
    for (const r of roots) for (const n of MAPPING_NAMES) candidates.push(`${String(r.path).replace(/\/$/, "")}/${n}`);
  }
  for (const path of candidates) {
    let text;
    try {
      text = (await ctx.host.files.readText(path)).text;
    } catch (e) {
      if (configured) return { mapping: { path, entities: {} }, problem: "mappingUnreadable", problems: [] };
      continue;
    }
    const { mapping, problems } = parseMapping(text, path);
    const fatal = problems.find((p) => p.reason === "mappingParse" || p.reason === "mappingShape");
    return { mapping, problem: fatal ? fatal.reason : "", problems };
  }
  return { mapping: { path: "", entities: {} }, problem: "mappingNone", problems: [] };
}

// Reads every `.sql` file, parses it, and writes the index in one batch: each file one resource keyed by its
// path; only `description` and the body are written for files already indexed (tags, favorites and runs stay);
// indexed files that are gone or no longer parse are marked missing. Returns the report it also stores.
export async function sync(ctx) {
  const { files: paths, truncated } = await listSqlFiles(ctx);
  const items = [];
  const skipped = [];
  const seen = {};
  for (const path of paths) {
    let text;
    try {
      text = (await ctx.host.files.readText(path)).text;
    } catch (e) {
      skipped.push({ path, reason: "unreadable", detail: (e && e.code) || "" });
      continue;
    }
    const res = parseEntry(path, text);
    if (!res.ok) {
      skipped.push({ path, reason: res.reason, detail: res.detail });
      continue;
    }
    const e = res.entry;
    if (seen[e.id]) {
      skipped.push({ path, reason: "duplicateId", detail: `${e.id} · ${seen[e.id]}` });
      continue;
    }
    seen[e.id] = path;
    items.push({
      externalKey: path,
      name: e.title || e.id,
      description: e.description,
      body: { id: e.id, path, sql: e.sql, params: e.params, permissions: e.permissions, datasource: e.datasource, tags: e.tags },
    });
  }
  // One batch keyed by external key (round16-protocol.md §2.2). Only description and body are sent, so a name
  // the user gave an entry stays — also when a deleted entry comes back (review #8). Indexed files not in the
  // batch are marked missing, unless the walk was cut short: then nothing is (review #6).
  const existing = new Set(
    ((await ctx.host.resources.list({ kind: KIND })) || []).map((r) => r.externalKey).filter((k) => typeof k === "string"),
  );
  const batch = items.map((it) => ({ key: it.externalKey, description: it.description, body: it.body }));
  const result = (await ctx.host.resources.upsertByKey(KIND, batch, truncated ? {} : { othersMissing: true })) || {};
  await nameNew(ctx, items.filter((it) => !existing.has(it.externalKey)), result);
  const report = {
    at: Date.now(),
    files: paths.length,
    indexed: items.length,
    created: Number(result.created || 0),
    updated: Number(result.updated || 0),
    unchanged: Number(result.unchanged || 0),
    restored: Number(result.restored || 0),
    missing: Number(result.missing || 0),
    truncated,
    skipped,
  };
  await storeReport(ctx, report);
  return report;
}

// New entries are named after their header (title or id). The kernel names a new resource after the last part
// of its key; a deleted entry that came back keeps its name, so when anything was restored only entries still
// carrying that default name are renamed.
async function nameNew(ctx, fresh, result) {
  if (fresh.length === 0) return;
  let rename = fresh;
  if (Number(result.restored || 0) > 0) {
    const ids = result.ids || {};
    rename = [];
    for (const it of fresh) {
      const r = ids[it.externalKey] ? await ctx.host.resources.get(ids[it.externalKey]) : null;
      if (r && r.name === it.externalKey.split("/").pop()) rename.push(it);
    }
  }
  if (rename.length) await ctx.host.resources.upsertByKey(KIND, rename.map((it) => ({ key: it.externalKey, name: it.name })), {});
}

// Review #5: the stored report stays well under the 256 KB value limit (the run's own output has the whole list);
// failing to store it does not fail the sync.
const REPORT_SKIPPED = 300;
const REPORT_DETAIL = 200;

async function storeReport(ctx, report) {
  const short = {
    ...report,
    skippedTotal: report.skipped.length,
    skipped: report.skipped.slice(0, REPORT_SKIPPED).map((x) => ({ path: x.path.slice(0, 1024), reason: x.reason, detail: String(x.detail || "").slice(0, REPORT_DETAIL) })),
  };
  try {
    await ctx.host.storage.set(REPORT_KEY, JSON.stringify(short));
  } catch (e) {
    /* the toast and the run output still have it */
  }
}

async function lastReport(ctx) {
  const raw = await ctx.host.storage.get(REPORT_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

function skippedTable(ctx, report) {
  return {
    type: "table",
    columns: [
      { key: "path", label: tr(ctx, "col.path") },
      { key: "reason", label: tr(ctx, "col.reason") },
    ],
    rows: report.skipped.map((s) => [s.path, reasonText(ctx, s)]),
    total: report.skipped.length,
  };
}

export function reasonText(ctx, s) {
  const base = tr(ctx, `reason.${s.reason}`);
  return s.detail ? `${base} (${s.detail})` : base;
}

function summaryText(ctx, report) {
  const skipped = report.skippedTotal !== undefined ? report.skippedTotal : report.skipped.length;
  const text = tr(ctx, "message.synced", { indexed: report.indexed, skipped, missing: report.missing });
  return report.truncated ? `${text} ${tr(ctx, "message.truncated", { max: MAX_FILES, depth: MAX_DEPTH })}` : text;
}

/* ---------------------------------------------------------------- running */

// The statements runs sent, newest first, in one key: at most SENT_RUNS of them, SENT_MAX characters each
// (review #2: one key per run would fill the plugin's 1000 keys). Writing it never fails the run.
export async function rememberSent(ctx, runId, sql) {
  try {
    let list = [];
    const raw = await ctx.host.storage.get(SENT_KEY);
    if (raw) list = JSON.parse(raw);
    if (!Array.isArray(list)) list = [];
    const text = sql.length > SENT_MAX ? `${sql.slice(0, SENT_MAX)}\n-- …` : sql;
    list = [{ run: runId || "-", sql: text }, ...list.filter((x) => x && x.run !== runId)].slice(0, SENT_RUNS);
    await ctx.host.storage.set(SENT_KEY, JSON.stringify(list));
  } catch (e) {
    /* only a convenience: the run goes on */
  }
}

export async function sentOf(ctx, runId) {
  try {
    const list = JSON.parse((await ctx.host.storage.get(SENT_KEY)) || "[]");
    const hit = Array.isArray(list) ? list.find((x) => x && x.run === runId) : null;
    return hit ? hit.sql : null;
  } catch (e) {
    return null;
  }
}

function entryOf(ctx) {
  const r = ctx.resource || {};
  const b = r.body || {};
  return {
    id: str(b.id) || r.name || "",
    title: r.name || "",
    description: r.description || "",
    sql: str(b.sql),
    path: str(b.path),
    params: Array.isArray(b.params) ? b.params : [],
    permissions: Array.isArray(b.permissions) ? b.permissions : [],
    datasource: str(b.datasource),
  };
}

async function sourceList(ctx) {
  try {
    const all = (await ctx.host.resources.list({ kind: SOURCE_KIND })) || [];
    return Array.isArray(all) ? all : all.items || [];
  } catch (e) {
    return [];
  }
}

// The entry's own data source (header `datasource`, an id or name), else the environment's, else the workspace's.
export async function pickSource(ctx, given) {
  let wanted = String(given || "").trim();
  if (!wanted) {
    const env = await ctx.host.params.get("datasource");
    if (env && env.found && String(env.value).trim()) wanted = String(env.value).trim();
  }
  if (!wanted) {
    const def = await ctx.host.params.config("datasource.default");
    if (def && def.found && String(def.value).trim()) wanted = String(def.value).trim();
  }
  if (!wanted) throw new Error(tr(ctx, "error.noSource"));
  const list = await sourceList(ctx);
  const hit = list.find((r) => r.id === wanted) || list.find((r) => r.name === wanted);
  if (!hit) throw new Error(tr(ctx, "error.sourceMissing", { source: wanted }));
  return hit.id;
}

function declsWithAsOf(entry, versioned) {
  const decls = entry.params.slice();
  if (versioned && !decls.some((d) => d.name === AS_OF)) decls.push({ name: AS_OF, type: "datetime", required: false, description: "", values: [], max: 0 });
  return decls;
}

// Values of the run: typed on the page, else the environment's; checked against the header.
async function valuesOf(ctx, names, decls) {
  const values = {};
  for (const name of names) {
    const typed = ctx.params && ctx.params[name];
    let value = typed !== undefined && typed !== "" ? String(typed) : null;
    if (value === null) {
      const found = await ctx.host.params.get(name);
      if (found && found.found && found.value !== "") value = String(found.value);
    }
    const decl = decls.find((d) => d.name === name) || { type: "text", required: false, values: [], max: 0 };
    const problem = checkValue(decl, value);
    if (problem) throw new Error(tr(ctx, `error.param.${problem}`, { name, max: decl.max }));
    values[name] = value;
  }
  return values;
}

// `-- @param` lines in the SQL plugin's syntax, so a saved copy keeps types and descriptions.
export function paramDeclLines(decls) {
  return decls
    .map((d) => {
      const opts = [];
      if (d.type && d.type !== "text" && d.type !== "enum") opts.push(`type=${d.type}`);
      if (d.values && d.values.length) opts.push(`values=${d.values.join("|")}`);
      if (d.required) opts.push("required");
      if (d.max > 0) opts.push(`max=${d.max}`);
      const desc = d.description ? ` -- ${d.description.replace(/\n/g, " ")}` : "";
      return `-- @param ${d.name}${opts.length ? " " + opts.join(" ") : ""}${desc}`;
    })
    .join("\n");
}

const pad = (n) => String(n).padStart(2, "0");
const formatDay = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const formatMinute = (d) => `${formatDay(d)}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;

function timePresets(ctx, now) {
  const day = (offset) => `${formatDay(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offset)))}T00:00`;
  return [
    { value: formatMinute(now), label: ctx.t("preset.now") },
    { value: day(0), label: ctx.t("preset.today") },
    { value: day(-1), label: ctx.t("preset.yesterday") },
    { value: day(-7), label: ctx.t("preset.week") },
  ];
}

function paramField(ctx, decl, now) {
  const field = { name: decl.name, label: decl.name, kind: decl.type, param: true };
  if (decl.type === "enum") field.options = decl.values.map((v) => ({ value: v, label: v }));
  if (decl.type === "datetime") field.presets = timePresets(ctx, now);
  if (decl.required) field.required = true;
  if (decl.max > 0 && decl.type === "text") field.maxLength = decl.max;
  const hints = [];
  if (decl.description) hints.push(decl.description);
  if (decl.type === "datetime") hints.push(tr(ctx, "hint.utc"));
  if (hints.length) field.hint = hints.join(" · ");
  return field;
}

/* ---------------------------------------------------------------- plugin */

export default {
  activate(host) {
    host.pages.handle("entry", {
      async render(ctx) {
        const entry = entryOf(ctx);
        const { mapping, problem } = await loadMapping(ctx);
        const { versioned } = expand(entry.sql, mapping);
        const view = [];
        if (isMissing(ctx.resource)) view.push({ type: "text", id: "missing", text: tr(ctx, "warn.missing", { path: entry.path }), tone: "danger" });
        checks(entry, mapping, problem ? tr(ctx, `reason.${problem}`) : "").forEach((w, i) => {
          view.push({ type: "text", id: `warn-${i}`, text: tr(ctx, w.key, w.vars), tone: "danger" });
        });
        if (entry.description) view.push({ type: "text", id: "description", text: entry.description });
        const facts = [tr(ctx, "info.id", { id: entry.id }), tr(ctx, "info.path", { path: entry.path })];
        if (entry.permissions.length) facts.push(tr(ctx, "info.permissions", { permissions: entry.permissions.join(", ") }));
        if (entry.datasource) facts.push(tr(ctx, "info.datasource", { source: entry.datasource }));
        view.push({ type: "text", id: "facts", text: facts.join("\n"), tone: "muted" });

        const now = new Date();
        const fields = [];
        for (const decl of entry.params) {
          const field = paramField(ctx, decl, now);
          if (ctx.run) {
            field.envValue = (ctx.run.params && ctx.run.params[decl.name]) || "";
            field.readOnly = true;
          } else {
            const found = await ctx.host.params.get(decl.name);
            if (found && found.found) {
              field.envValue = found.value;
              field.envSource = found.sourceName;
            }
          }
          fields.push(field);
        }
        if (versioned && !entry.params.some((d) => d.name === AS_OF)) {
          const asOf = { name: AS_OF, label: ctx.t("field.asOf"), kind: "datetime", param: true, presets: timePresets(ctx, now), hint: tr(ctx, "field.asOf.hint") };
          if (ctx.run) (asOf.envValue = (ctx.run.params && ctx.run.params[AS_OF]) || ""), (asOf.readOnly = true);
          fields.push(asOf);
        }
        if (fields.length) view.push({ type: "form", id: "params", layout: "strip", fields });
        view.push({
          type: "form",
          id: "sql",
          layout: "stack",
          fields: [{ name: "sql", label: ctx.t("field.sql"), kind: "code", language: "sql", fill: true, readOnly: true }],
        });
        return { view, values: { sql: entry.sql }, readOnly: true, title: entry.title || entry.id, icon: "file-search" };
      },

      async onEvent(ctx, event) {
        if (event !== "copy") throw new Error(`unknown event ${event}`);
        const entry = entryOf(ctx);
        const { mapping } = await loadMapping(ctx);
        await ctx.host.ui.copy(expand(entry.sql, mapping).sql);
        return { message: tr(ctx, "message.copied") };
      },

      async renderResultTab(ctx, tabId) {
        if (tabId !== "sent") throw new Error(`unknown result tab ${tabId}`);
        const raw = ctx.run ? await sentOf(ctx, ctx.run.id) : null;
        if (raw) return [{ type: "text", id: "sent", text: raw, mono: true, language: "sql" }];
        const entry = entryOf(ctx);
        const { mapping } = await loadMapping(ctx);
        return [
          { type: "text", id: "note", text: tr(ctx, "sent.expanded"), tone: "muted" },
          { type: "text", id: "expanded", text: expand(entry.sql, mapping).sql, mono: true, language: "sql" },
        ];
      },
    });

    host.pages.handle("index", {
      async render(ctx) {
        const report = await lastReport(ctx);
        const view = [{ type: "text", id: "about", text: tr(ctx, "index.about"), tone: "muted" }];
        if (!report) view.push({ type: "text", id: "none", text: tr(ctx, "index.none") });
        else {
          view.push({ type: "text", id: "summary", text: summaryText(ctx, report) });
          if (report.skipped.length) {
            const t = skippedTable(ctx, report);
            view.push({ type: "table", id: "skipped", columns: t.columns, rows: t.rows });
            if (report.skippedTotal > report.skipped.length) view.push({ type: "text", id: "more", text: tr(ctx, "index.more", { count: report.skippedTotal - report.skipped.length }), tone: "muted" });
          }
        }
        return { view, title: tr(ctx, "index.title"), icon: "folder-search" };
      },
    });

    host.trees.handle("catalog", {
      async children(ctx, parentKey) {
        const all = (await ctx.host.resources.list({ kind: KIND })) || [];
        return { nodes: treeChildren(Array.isArray(all) ? all : all.items || [], parentKey || "", tr(ctx, "badge.missing")) };
      },
      async path(ctx, key) {
        const all = (await ctx.host.resources.list({ kind: KIND })) || [];
        return treePath(Array.isArray(all) ? all : all.items || [], key);
      },
    });

    const reindex = (ctx) => sync(ctx);

    host.commands.handle("reindex", async (ctx) => {
      const report = await reindex(ctx);
      return [{ type: "toast", message: summaryText(ctx, report), tone: report.skipped.length || report.truncated ? "warning" : "success" }];
    });

    host.commands.handle("openIndex", async () => [{ type: "open", target: `page:${PLUGIN}/index` }]);

    // X13: the index follows the files whenever the workspace opens (manifest `activation`).
    if (host.events && typeof host.events.on === "function") host.events.on("workspace.opened", async (ctx) => void (await reindex(ctx)));

    host.actions.handle("reindex", async (ctx) => {
      ctx.progress(undefined, tr(ctx, "step.indexing"));
      const report = await reindex(ctx);
      return { output: skippedTable(ctx, report), summary: { rows: report.skipped.length, message: summaryText(ctx, report) } };
    });

    // The mapping as other plugins read it (exports.actions): text output holding the normalized JSON.
    // On a data source's page (review #21): the catalog queries whose header names this data source. Declaring
    // an action on the data source kind is also what lets this plugin list data sources (`foreign_kinds`).
    host.actions.handle("queriesHere", async (ctx) => {
      const src = ctx.resource;
      if (!src || !src.id) throw new Error(tr(ctx, "error.noSource"));
      const all = (await ctx.host.resources.list({ kind: KIND })) || [];
      const mine = (Array.isArray(all) ? all : all.items || [])
        .filter((r) => !r.deleted && r.body && (r.body.datasource === src.id || (src.name && r.body.datasource === src.name)))
        .sort((a, b) => (catalogId(a) < catalogId(b) ? -1 : 1));
      return {
        output: {
          type: "table",
          columns: [
            { key: "id", label: tr(ctx, "col.id") },
            { key: "name", label: tr(ctx, "col.name") },
            { key: "path", label: tr(ctx, "col.path") },
          ],
          rows: mine.map((r) => [catalogId(r), r.name || "", (r.body && r.body.path) || ""]),
          total: mine.length,
        },
        summary: { rows: mine.length, message: tr(ctx, "message.queriesHere", { count: mine.length, source: src.name || src.id }) },
      };
    });

    host.actions.handle("mapping", async (ctx) => {
      const { mapping, problem, problems } = await loadMapping(ctx);
      const text = JSON.stringify({ ...mapping, problem, problems: problems || [] });
      return { output: { type: "text", text }, summary: { message: tr(ctx, "message.mapping", { count: Object.keys(mapping.entities).length }) } };
    });

    host.actions.handle("run", async (ctx) => {
      const entry = entryOf(ctx);
      if (!entry.sql.trim()) throw new Error(tr(ctx, "error.empty"));
      const { mapping, problem } = await loadMapping(ctx);
      const ex = expand(entry.sql, mapping);
      if (ex.unmapped.length) throw new Error(problem && placeholders(entry.sql).length ? tr(ctx, `reason.${problem}`) : tr(ctx, "error.unmapped", { names: ex.unmapped.join(", ") }));
      const decls = declsWithAsOf(entry, ex.versioned);
      const values = await valuesOf(ctx, paramNames(ex.sql), decls);
      const rendered = renderSql(ex.sql, values, decls);
      await rememberSent(ctx, ctx.runId, rendered);
      const sourceId = await pickSource(ctx, entry.datasource);
      ctx.progress(undefined, tr(ctx, "step.running"));
      const res = await ctx.host.actions.call(`${DATASOURCE}:query`, { sql: rendered }, { resource: sourceId });
      if (res && typeof res.error === "string") throw new Error(res.error);
      if (!res || !res.output || res.output.type !== "table") throw new Error(tr(ctx, "error.noResult"));
      return { output: res.output, summary: res.summary };
    });

    // A10: a saved SQL statement made from this entry (mapping applied, parameters kept as `:name` with their
    // declarations), opened with the values typed here.
    host.actions.handle("saveAsSql", async (ctx) => {
      const entry = entryOf(ctx);
      const { mapping } = await loadMapping(ctx);
      const ex = expand(entry.sql, mapping);
      if (ex.unmapped.length) throw new Error(tr(ctx, "error.unmapped", { names: ex.unmapped.join(", ") }));
      const decls = declsWithAsOf(entry, ex.versioned);
      const used = paramNames(ex.sql);
      const head = paramDeclLines(decls.filter((d) => used.includes(d.name)));
      const sql = head ? `${head}\n${ex.sql}` : ex.sql;
      const params = {};
      for (const n of used) if (ctx.params && typeof ctx.params[n] === "string" && ctx.params[n] !== "") params[n] = ctx.params[n];
      let source = "";
      if (entry.datasource) {
        const list = await sourceList(ctx);
        const hit = list.find((r) => r.id === entry.datasource) || list.find((r) => r.name === entry.datasource);
        source = hit ? hit.id : "";
      }
      const res = await ctx.host.actions.call(SQL_CREATE, { name: entry.title || entry.id, description: entry.description, sql, source, params });
      if (res && typeof res.error === "string") throw new Error(res.error);
      if (!res || !res.output || res.output.type !== "link") throw new Error(tr(ctx, "error.noResult"));
      return { output: res.output, summary: { message: tr(ctx, "message.savedAs") } };
    });
  },
};
