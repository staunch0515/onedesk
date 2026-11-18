// SQL plugin: saved SQL with :name parameters. One kind ("query"), a page with a parameter strip, a data
// source picker and the editor, an action "run" and result tabs for the statement that was actually sent.
// The statement runs through the data source plugin (ctx.host.actions.call), which owns the connection, the
// password and the read-only transaction. Values are rendered into the text as SQL literals (single quotes
// doubled; an empty value is NULL), the way the old sqlpool did; nothing is bound by a driver.
//
// Parameter declarations are optional comment lines at any place in the text:
//   -- @param NAME [type=text|number|date|datetime|enum] [required] [max=N] [values=a|b|c] [-- description]
// Without one a parameter is a text field. Sandbox rules: no console, timers or fetch.

export const SOURCE_KIND = "org.onedesk.datasource:source";
export const DATASOURCE = "org.onedesk.datasource";
const SENT_KEY = "lastSent";
const TYPES = ["text", "number", "date", "datetime", "enum"];
const MAX_LEN_DEFAULT = 0;

/* ---------------------------------------------------------------- helpers */

export function tr(ctx, key, vars) {
  const label = ctx.t(key);
  let text = typeof label === "string" ? label : label[ctx.locale] || label["en-US"] || key;
  for (const k of Object.keys(vars || {})) text = text.split(`{${k}}`).join(String(vars[k]));
  return text;
}

// Splits SQL into pieces: raw text and parameters. Strings, quoted names, dollar-quoted text and comments
// are raw; so is the `::` of a cast.
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
      let j = i + 1;
      while (j < s.length) {
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
    } else if (c === "$") {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(s.slice(i, i + 80));
      if (m) {
        const end = s.indexOf(m[0], i + m[0].length);
        const stop = end < 0 ? s.length : end + m[0].length;
        raw += s.slice(i, stop);
        i = stop;
      } else {
        raw += c;
        i++;
      }
    } else if (c === "-" && next === "-") {
      let j = i;
      while (j < s.length && s[j] !== "\n") j++;
      raw += s.slice(i, j);
      i = j;
    } else if (c === "/" && next === "*") {
      const end = s.indexOf("*/", i + 2);
      const stop = end < 0 ? s.length : end + 2;
      raw += s.slice(i, stop);
      i = stop;
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

// `-- @param NAME key=value … | description` lines → { NAME: { type, required, max, values, description } }.
export function declarations(sql) {
  const out = {};
  for (const line of String(sql || "").split("\n")) {
    const m = /^\s*--\s*@param\s+([A-Za-z_][A-Za-z0-9_]*)(.*)$/.exec(line);
    if (!m) continue;
    const bar = m[2].indexOf(" -- ");
    const opts = (bar < 0 ? m[2] : m[2].slice(0, bar)).trim().split(/\s+/).filter(Boolean);
    const decl = { type: "text", required: false, max: MAX_LEN_DEFAULT, values: [], description: bar < 0 ? "" : m[2].slice(bar + 4).trim() };
    for (const o of opts) {
      const eq = o.indexOf("=");
      const k = eq < 0 ? o : o.slice(0, eq);
      const v = eq < 0 ? "" : o.slice(eq + 1);
      if (k === "required") decl.required = true;
      else if (k === "type" && TYPES.includes(v)) decl.type = v;
      else if (k === "max" && /^\d+$/.test(v)) decl.max = Number(v);
      else if (k === "values") decl.values = v.split("|").filter(Boolean);
    }
    if (decl.values.length > 0 && decl.type === "text") decl.type = "enum";
    out[m[1]] = decl;
  }
  return out;
}

export function declOf(decls, name) {
  return decls[name] || { type: "text", required: false, max: MAX_LEN_DEFAULT, values: [], description: "" };
}

export function sqlLiteral(value) {
  if (value === null || value === undefined) return "NULL";
  const v = String(value);
  if (v.includes("\0")) throw Object.assign(new Error("NUL"), { code: "invalid" });
  return `'${v.replace(/'/g, "''")}'`;
}

// A datetime-local form value is UTC without a zone ("2026-01-01T00:00" → "2026-01-01T00:00:00Z").
export function toSqlValue(decl, value) {
  if (decl.type === "datetime") {
    if (/Z$|[+-]\d\d:\d\d$/.test(value)) return value;
    return value.length === 16 ? `${value}:00Z` : `${value}Z`;
  }
  return value;
}

// null when fine, else the reason key.
export function checkValue(decl, value) {
  if (value === null) return decl.required ? "required" : null;
  if (decl.type === "number" && !/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(value.trim())) return "number";
  if (decl.type === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(value)) return "date";
  if (decl.type === "datetime" && !/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d\d:\d\d)?$/.test(value)) return "datetime";
  if (decl.type === "enum" && decl.values.length > 0 && !decl.values.includes(value)) return "enum";
  if (decl.max > 0 && value.length > decl.max) return "max";
  return null;
}

// Renders the text with every parameter replaced by its literal. `values[name]`: a string, or null/""/missing = NULL.
export function renderSql(sql, values, decls) {
  let out = "";
  for (const t of tokenize(sql)) {
    if (t.param === undefined) {
      out += t.raw;
      continue;
    }
    const v = values[t.param];
    out += sqlLiteral(v === undefined || v === null || v === "" ? null : toSqlValue(declOf(decls || {}, t.param), String(v)));
  }
  return out;
}

const pad = (n) => String(n).padStart(2, "0");
export const formatDay = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
export const formatMinute = (d) => `${formatDay(d)}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;

// Quick values of a datetime field (UTC).
export function timePresets(ctx, now) {
  const day = (offset) => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offset));
    return `${formatDay(d)}T00:00`;
  };
  const monthStart = `${formatDay(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)))}T00:00`;
  return [
    { value: formatMinute(now), label: ctx.t("preset.now") },
    { value: day(0), label: ctx.t("preset.today") },
    { value: day(-1), label: ctx.t("preset.yesterday") },
    { value: day(-7), label: ctx.t("preset.week") },
    { value: monthStart, label: ctx.t("preset.month") },
  ];
}

function bodyOf(ctx) {
  const pick = (key, dflt) => {
    if (ctx.run && ctx.run.input && typeof ctx.run.input[`body.${key}`] === "string") return ctx.run.input[`body.${key}`];
    if (ctx.draft && typeof ctx.draft[`body.${key}`] === "string") return ctx.draft[`body.${key}`];
    const b = ctx.resource && ctx.resource.body;
    return b && typeof b[key] === "string" ? b[key] : dflt;
  };
  return { sql: pick("sql", ""), source: pick("source", "") };
}

async function sourceList(ctx) {
  try {
    const all = (await ctx.host.resources.list({ kind: SOURCE_KIND })) || [];
    return Array.isArray(all) ? all : all.items || [];
  } catch (e) {
    return [];
  }
}

function paramField(ctx, name, decl, now) {
  const kind = decl.type === "number" ? "number" : decl.type === "date" ? "date" : decl.type === "datetime" ? "datetime" : decl.type === "enum" ? "enum" : "text";
  const field = { name, label: name, kind, param: true };
  if (kind === "enum") field.options = decl.values.map((v) => ({ value: v, label: v }));
  if (kind === "datetime") field.presets = timePresets(ctx, now);
  const hints = [];
  if (decl.description) hints.push(decl.description);
  if (decl.required) hints.push(tr(ctx, "hint.required"));
  if (decl.max > 0) hints.push(tr(ctx, "hint.max", { max: decl.max }));
  if (kind === "datetime") hints.push(tr(ctx, "hint.utc"));
  if (hints.length > 0) field.hint = hints.join(" · ");
  return field;
}

/* ---------------------------------------------------------------- plugin */

export default {
  activate(host) {
    host.pages.handle("editor", {
      async render(ctx) {
        const { sql, source } = bodyOf(ctx);
        const ro = ctx.run ? { readOnly: true } : {};
        const decls = declarations(sql);
        const names = paramNames(sql);
        const view = [];

        const sources = await sourceList(ctx);
        const options = [{ value: "", label: ctx.t("source.default") }, ...sources.map((r) => ({ value: r.id, label: r.name }))];
        if (source && !sources.some((r) => r.id === source)) options.push({ value: source, label: source });
        view.push({
          type: "form",
          id: "source",
          layout: "strip",
          fields: [{ name: "source", label: ctx.t("field.source"), kind: "enum", bind: "body.source", options, hint: ctx.t("field.source.hint"), ...ro }],
        });

        if (names.length > 0) {
          const now = new Date();
          const fields = [];
          for (const name of names) {
            const field = paramField(ctx, name, declOf(decls, name), now);
            if (ctx.run) {
              field.envValue = (ctx.run.params && ctx.run.params[name]) || "";
              field.readOnly = true;
            } else {
              const found = await ctx.host.params.get(name);
              if (found.found) {
                field.envValue = found.value;
                field.envSource = found.sourceName;
              }
            }
            fields.push(field);
          }
          view.push({ type: "form", id: "params", layout: "strip", fields });
        }

        view.push({
          type: "form",
          id: "editor",
          layout: "stack",
          fields: [{ name: "sql", label: ctx.t("field.sql"), kind: "code", bind: "body.sql", fill: true, language: "sql", placeholder: ctx.t("field.sql.placeholder"), ...ro }],
        });
        return { view };
      },

      async onEvent(ctx, event) {
        if (event !== "copy") throw new Error(`unknown event ${event}`);
        const { sql } = bodyOf(ctx);
        await ctx.host.ui.copy(sql);
        return { message: tr(ctx, "message.copied") };
      },

      async renderResultTab(ctx, tabId) {
        if (tabId !== "sent") throw new Error(`unknown result tab ${tabId}`);
        const id = (ctx.run && ctx.run.resourceId) || "-";
        const raw = await ctx.host.storage.get(`${SENT_KEY}:${id}`);
        if (!raw) return [{ type: "text", id: "none", text: tr(ctx, "sent.none"), tone: "muted" }];
        return [{ type: "text", id: "sent", text: raw, mono: true, language: "sql" }];
      },
    });

    // Creates a statement on the data source the user is looking at, and opens it.
    host.actions.handle("newHere", async (ctx) => {
      const src = ctx.resource;
      if (!src) throw new Error(tr(ctx, "error.noSource"));
      const created = await ctx.host.resources.create({ kind: "query", name: tr(ctx, "kind.query.newOn", { source: src.name || "" }), body: { sql: "", source: src.id } });
      return { output: { type: "link", label: created.name || tr(ctx, "kind.query.new"), target: `resource:${created.id}` }, summary: { message: tr(ctx, "summary.created") } };
    });

    host.actions.handle("run", async (ctx, input) => {
      const sql = String((input && input["body.sql"]) || "");
      const source = String((input && input["body.source"]) || "");
      if (!sql.trim()) throw Object.assign(new Error(tr(ctx, "error.empty")), { code: "invalid" });

      const decls = declarations(sql);
      const values = {};
      for (const name of paramNames(sql)) {
        const typed = ctx.params && ctx.params[name];
        let value = typed !== undefined && typed !== "" ? String(typed) : null;
        if (value === null) {
          const found = await ctx.host.params.get(name);
          if (found.found && found.value !== "") value = String(found.value);
        }
        const problem = checkValue(declOf(decls, name), value);
        if (problem) throw Object.assign(new Error(tr(ctx, `error.param.${problem}`, { name, max: declOf(decls, name).max })), { code: "invalid" });
        values[name] = value;
      }
      const rendered = renderSql(sql, values, decls);
      const id = (ctx.resource && ctx.resource.id) || "-";
      await ctx.host.storage.set(`${SENT_KEY}:${id}`, rendered);

      ctx.progress(undefined, tr(ctx, "step.running"));
      const res = await ctx.host.actions.call(`${DATASOURCE}:query`, { source, sql: rendered });
      const out = res && res.output;
      if (!out || out.type !== "table") throw new Error(tr(ctx, "error.noResult"));
      return { output: out, summary: res.summary || { rows: out.rows.length } };
    });
  },
};
