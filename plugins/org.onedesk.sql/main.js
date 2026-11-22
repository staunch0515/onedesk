// SQL plugin: saved SQL with :name parameters. One kind ("query"), a page with a parameter strip, a data
// source picker and the editor, an action "run" and result tabs for the statement that was actually sent.
// The statement runs through the data source plugin (ctx.host.actions.call), which owns the connection, the
// password and the read-only transaction. Values are rendered into the text as SQL literals (single quotes
// doubled; an empty value is NULL), the way the old sqlpool did; nothing is bound by a driver.
//
// Parameter declarations are optional comment lines at any place in the text:
//   -- @param NAME [type=text|number|date|datetime|time|enum] [required] [max=N] [values=a|b|c] [-- description]
// Without one a parameter is a text field. Sandbox rules: no console, timers or fetch.

export const SOURCE_KIND = "org.onedesk.datasource:source";
export const DATASOURCE = "org.onedesk.datasource";
export const AI = "org.onedesk.ai";
const SENT_KEY = "lastSent";
const PROPOSAL_KEY = "aiProposal";
const TYPES = ["text", "number", "date", "datetime", "time", "enum"];
const MAX_LEN_DEFAULT = 0;

/* ---------------------------------------------------------------- helpers */

export function tr(ctx, key, vars) {
  const label = ctx.t(key);
  let text = typeof label === "string" ? label : label[ctx.locale] || label["en-US"] || key;
  for (const k of Object.keys(vars || {})) text = text.split(`{${k}}`).join(String(vars[k]));
  return text;
}

const IDENT_CHAR = /[A-Za-z0-9_$\u0080-\uffff]/;
const DOLLAR = /^\$([A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*)?\$/;

// Splits SQL into pieces: raw text and parameters. Strings (E'…' with backslash escapes), quoted names,
// dollar-quoted text (a `$` inside a name does not start one), comments (block comments nest, as in
// PostgreSQL) are raw; so is the `::` of a cast. The data source plugin reads the text the same way.
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

// `escapeBackslash`: the literal goes right after an `E`, so it is an E'…' string where a backslash escapes
// the next character (`\'` would end the literal); backslashes are doubled then.
export function sqlLiteral(value, escapeBackslash) {
  if (value === null || value === undefined) return "NULL";
  const v = String(value);
  if (v.includes("\0")) throw new Error("NUL");
  const body = escapeBackslash ? v.replace(/\\/g, "\\\\") : v;
  return `'${body.replace(/'/g, "''")}'`;
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
  if (decl.type === "time" && !/^\d{2}:\d{2}(:\d{2})?$/.test(value)) return "time";
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
    const afterE = /[eE]$/.test(out) && !(out.length > 1 && IDENT_CHAR.test(out[out.length - 2]));
    out += sqlLiteral(v === undefined || v === null || v === "" ? null : toSqlValue(declOf(decls || {}, t.param), String(v)), afterE);
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

// The data source of a run: the statement's own, else the environment's `datasource`, else the workspace's
// `datasource.default`. A value is a resource id (a name is accepted too). Returns the id.
export async function pickSource(ctx, given) {
  let wanted = String(given || "").trim();
  let via = "";
  if (!wanted) {
    const env = await ctx.host.params.get("datasource");
    if (env && env.found && String(env.value).trim()) {
      wanted = String(env.value).trim();
      via = "Env";
    }
  }
  if (!wanted) {
    const def = await ctx.host.params.config("datasource.default");
    if (def && def.found && String(def.value).trim()) {
      wanted = String(def.value).trim();
      via = "Default";
    }
  }
  if (!wanted) throw new Error(tr(ctx, "error.noSource"));
  const list = await sourceList(ctx);
  const hit = list.find((r) => r.id === wanted) || list.find((r) => r.name === wanted);
  if (!hit) throw new Error(tr(ctx, "error.sourceMissing" + via, { source: wanted }));
  return hit.id;
}

function paramField(ctx, name, decl, now) {
  const kind = decl.type === "text" ? "text" : decl.type;
  const field = { name, label: name, kind, param: true };
  if (kind === "enum") field.options = decl.values.map((v) => ({ value: v, label: v }));
  if (kind === "datetime") field.presets = timePresets(ctx, now);
  if (kind === "time") field.presets = [{ value: "00:00", label: "00:00" }, { value: "12:00", label: "12:00" }];
  if (decl.required) field.required = true;
  if (decl.max > 0 && kind === "text") field.maxLength = decl.max;
  const hints = [];
  if (decl.description) hints.push(decl.description);
  if (kind === "datetime") hints.push(tr(ctx, "hint.utc"));
  if (hints.length > 0) field.hint = hints.join(" · ");
  return field;
}


/* ---------------------------------------------------------------- "Write with AI" (K7–K9) */

const proposalKey = (ctx) => `${PROPOSAL_KEY}:${(ctx.resource && ctx.resource.id) || "-"}`;

async function readProposal(ctx) {
  try {
    const raw = await ctx.host.storage.get(proposalKey(ctx));
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

// Table names of the statement on the page, as context for the model (never data).
export function tablesOf(sql) {
  const out = [];
  const re = /\b(?:from|join)\s+((?:[A-Za-z_"][\w$"]*\.)*[A-Za-z_"][\w$"]*)/gi;
  let m;
  while ((m = re.exec(String(sql || "")))) {
    const name = m[1].split(".").pop().replace(/"/g, "");
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

// What the editor page shows about the proposal (the editor itself is not touched until "Accept").
export function proposalView(ctx, p) {
  if (!p) return [];
  const view = [];
  if (p.stage === "preview") {
    view.push({ type: "text", id: "aiPreview", text: tr(ctx, "ai.preview", { connection: p.connection || "", model: p.model || tr(ctx, "ai.modelDefault"), tokens: p.tokens || 0 }), tone: "muted" });
    view.push({ type: "text", id: "aiRequest", text: p.request || "", format: "markdown" });
  } else if (p.stage === "proposal") {
    const note = p.check && p.check.ok ? tr(ctx, "ai.checkOk") : tr(ctx, `ai.check.${(p.check && p.check.reason) || "notSelect"}`);
    view.push({ type: "text", id: "aiNote", text: `${tr(ctx, "ai.proposalFrom", { model: p.model || "" })}\n${note}`, tone: p.check && p.check.ok ? "muted" : "danger" });
    view.push({ type: "text", id: "aiProposal", text: p.text || "", mono: true, language: "sql" });
  } else if (p.stage === "error") {
    view.push({ type: "text", id: "aiError", text: p.message || "", tone: "danger" });
  }
  return view;
}

async function callGenerate(ctx, instruction, sourceId, sql, confirm) {
  const input = { kind: "sql", instruction, context: { tables: tablesOf(sql) } };
  if (sourceId) input.resource = sourceId;
  if (confirm) input.confirm = true;
  try {
    const ret = await ctx.host.actions.call(`${AI}:generate`, input, {});
    return ret && ret.data ? ret.data : ret; // D441
  } catch (e) {
    if (e && e.params && e.params.reason === "notExported") throw new Error(tr(ctx, "ai.missing"));
    throw e;
  }
}

async function finishGenerate(ctx, res, instruction) {
  const key = proposalKey(ctx);
  if (res && res.error) {
    const message = typeof res.error === "string" ? res.error : res.error.message || "";
    await ctx.host.storage.set(key, JSON.stringify({ stage: "error", message }));
    throw new Error(message);
  }
  if (res && res.needsPreview) {
    await ctx.host.storage.set(key, JSON.stringify({ stage: "preview", instruction, request: res.request, connection: res.connection, model: res.model, tokens: res.tokens }));
    const message = tr(ctx, "ai.reviewFirst");
    return { output: { type: "text", text: message }, summary: { message } };
  }
  if (!res || typeof res.text !== "string") throw new Error(tr(ctx, "ai.missing"));
  await ctx.host.storage.set(key, JSON.stringify({ stage: "proposal", instruction, text: res.text, model: res.model || "", check: res.check || { ok: false, reason: "notSelect" } }));
  const message = tr(ctx, res.check && res.check.ok ? "ai.proposed" : "ai.proposedBad");
  return { output: { type: "text", text: res.text }, summary: { message } };
}

async function sourceOf(ctx, input) {
  try {
    return await pickSource(ctx, String((input && input["body.source"]) || ""));
  } catch (e) {
    return "";
  }
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
          fields: [{ name: "source", label: ctx.t("field.source"), kind: "ref", kinds: [SOURCE_KIND], bind: "body.source", options, hint: tr(ctx, "field.source.hint"), ...ro }],
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
        if (!ctx.run) {
          view.push({
            type: "form",
            id: "ai",
            layout: "strip",
            fields: [{ name: "aiInstruction", label: ctx.t("field.ai"), kind: "text", param: true, fill: true, placeholder: ctx.t("field.ai.placeholder") }],
          });
          view.push(...proposalView(ctx, await readProposal(ctx)));
        }
        return { view };
      },

      async onEvent(ctx, event) {
        if (event === "aiAccept" || event === "aiDiscard") {
          const p = await readProposal(ctx);
          if (!p) return { message: tr(ctx, "ai.none") };
          if (event === "aiAccept" && !(p.stage === "proposal" && p.check && p.check.ok)) return { message: tr(ctx, "ai.cannotAccept") };
          await ctx.host.storage.remove(proposalKey(ctx));
          // the proposal enters the editor as an unsaved change; nothing is run or saved
          return event === "aiAccept" ? { changes: { "body.sql": p.text }, message: tr(ctx, "ai.accepted") } : { message: tr(ctx, "ai.discarded") };
        }
        if (event !== "copy") throw new Error(`unknown event ${event}`);
        const { sql } = bodyOf(ctx);
        await ctx.host.ui.copy(sql);
        return { message: tr(ctx, "message.copied") };
      },

      async renderResultTab(ctx, tabId) {
        if (tabId !== "sent") throw new Error(`unknown result tab ${tabId}`);
        const raw = await ctx.host.storage.get(`${SENT_KEY}:${(ctx.run && ctx.run.id) || "-"}`);
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

    // Exported (called by other plugins, e.g. the query catalog): a new saved statement with the given body,
    // data source and description. `params` (values typed elsewhere) come back on the link (D423).
    host.actions.handle("create", async (ctx, input) => {
      const i = input || {};
      const sql = String(i.sql || "");
      if (!sql.trim()) throw new Error(tr(ctx, "error.empty"));
      let source = String(i.source || "").trim();
      if (source) {
        const list = await sourceList(ctx);
        const hit = list.find((r) => r.id === source) || list.find((r) => r.name === source);
        if (!hit) throw new Error(tr(ctx, "error.sourceMissing", { source }));
        source = hit.id;
      }
      const name = String(i.name || "").trim() || tr(ctx, "kind.query.new");
      const made = { kind: "query", name, body: { sql, source } };
      if (typeof i.description === "string" && i.description) made.description = i.description;
      const created = await ctx.host.resources.create(made);
      // D423: the values typed elsewhere open with the statement as its initial page state (text only).
      const out = { type: "link", label: created.name || name, target: `resource:${created.id}` };
      const given = i.params && typeof i.params === "object" ? i.params : {};
      const vals = {};
      for (const k of Object.keys(given)) if (typeof given[k] === "string" && given[k] !== "") vals[k] = given[k];
      if (Object.keys(vals).length > 0) out.params = vals;
      return { output: out, summary: { message: tr(ctx, "summary.created") } };
    });

    // "Write with AI": asks the AI workbench for a proposal. The editor keeps its text until "Accept".
    host.actions.handle("aiWrite", async (ctx, input) => {
      const instruction = String((ctx.params && ctx.params.aiInstruction) || "").trim();
      if (!instruction) throw new Error(tr(ctx, "ai.noInstruction"));
      ctx.progress(undefined, tr(ctx, "ai.step"));
      const res = await callGenerate(ctx, instruction, await sourceOf(ctx, input), String((input && input["body.sql"]) || ""), false);
      return finishGenerate(ctx, res, instruction);
    });

    // After the user has looked at what would be sent (policy "preview"): send it.
    host.actions.handle("aiSend", async (ctx, input) => {
      const p = await readProposal(ctx);
      if (!p || p.stage !== "preview") throw new Error(tr(ctx, "ai.noPreview"));
      ctx.progress(undefined, tr(ctx, "ai.step"));
      const res = await callGenerate(ctx, p.instruction, await sourceOf(ctx, input), String((input && input["body.sql"]) || ""), true);
      return finishGenerate(ctx, res, p.instruction);
    });

    host.actions.handle("run", async (ctx, input) => {
      const sql = String((input && input["body.sql"]) || "");
      if (!sql.trim()) throw new Error(tr(ctx, "error.empty"));

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
        if (problem) throw new Error(tr(ctx, `error.param.${problem}`, { name, max: declOf(decls, name).max }));
        if (value !== null && value.includes("\0")) throw new Error(tr(ctx, "error.param.nul", { name }));
        values[name] = value;
      }
      const rendered = renderSql(sql, values, decls);
      // the statement as sent belongs to this run (not to the resource: a statement not saved yet has none)
      await ctx.host.storage.set(`${SENT_KEY}:${ctx.runId || "-"}`, rendered);

      const sourceId = await pickSource(ctx, String((input && input["body.source"]) || ""));
      ctx.progress(undefined, tr(ctx, "step.running"));
      const res = await ctx.host.actions.call(`${DATASOURCE}:query`, { sql: rendered }, { resource: sourceId });
      if (res && typeof res.error === "string") throw new Error(res.error); // the data source's own message
      if (!res || !res.output || (res.output.type !== "table")) throw new Error(tr(ctx, "error.noResult"));
      return { output: res.output, summary: res.summary };
    });
  },
};
