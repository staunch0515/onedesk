// AI workbench: "Analyze" on a result (K1), a preview page that shows exactly what will be sent and sends only on
// "Send" (K3), masking before anything leaves (K4), reference documents from an authorized folder (K2), saving
// an analysis with its run (K6), and an exported `generate` for other plugins (K7–K9, a proposal, never data).
// It never talks to a provider directly: the chat goes through the plugin interface `onedesk.ai.chat/1` to the
// connection resource the user picked (ctx.host.interfaces.call). Sandbox rules: no console, timers or fetch.

export const PLUGIN = "org.onedesk.ai";
export const IFACE = "onedesk.ai.chat/1";
export const KIND_ANALYSIS = "analysis";
export const KIND_DOC = "doc";
export const KIND_SETTINGS = "settings";
export const MAX_DOCS = 8;
export const POLICIES = ["off", "preview", "allow"];
const AUDIT_KEY = "audit";
const AUDIT_MAX = 200;
const DOC_FILE = /\.(md|markdown|txt)$/i;
const DOC_MAX_FILES = 500;
const DOC_MAX_CHARS = 20000;
const PAGE = 200;
const TEXT_MAX = 4000;

/* ---------------------------------------------------------------- helpers */

export function tr(ctx, key, vars) {
  const label = ctx.t(key);
  let text = typeof label === "string" ? label : label[ctx.locale] || label["en-US"] || key;
  for (const k of Object.keys(vars || {})) text = text.split(`{${k}}`).join(String(vars[k]));
  return text;
}

// About how many tokens: ASCII ~4 characters each, everything else ~1 each. An estimate, said so on the page.
export function estimateTokens(text) {
  let ascii = 0;
  let other = 0;
  for (const ch of String(text || "")) {
    if (ch.charCodeAt(0) < 128) ascii++;
    else other++;
  }
  return Math.ceil(ascii / 4) + other;
}

async function setting(ctx, name, dflt) {
  try {
    const v = await ctx.host.settings.get(name);
    return v === undefined || v === null || v === "" ? dflt : String(v);
  } catch (e) {
    return dflt;
  }
}
async function settingNumber(ctx, name, dflt) {
  const n = Number(await setting(ctx, name, String(dflt)));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
}

async function envValue(ctx, name) {
  try {
    const v = await ctx.host.params.get(name);
    return v && v.found && String(v.value).trim() ? String(v.value).trim() : "";
  } catch (e) {
    return "";
  }
}

// ai.policy of the environment: off (no AI), preview (look first, the default), allow (a request without data
// may go at once). Anything else counts as preview — never more permissive than asked.
export async function policyOf(ctx) {
  const v = await envValue(ctx, "ai.policy");
  return POLICIES.includes(v) ? v : "preview";
}

export async function requireAllowed(ctx) {
  if ((await policyOf(ctx)) === "off") throw new Error(tr(ctx, "error.policyOff"));
}

// The connection: the one chosen on the page, else the environment's `ai.connection`, else the workspace default
// `ai.connection.default` (a resource reference, like `datasource.default` of the SQL plugin). { id, name, model }.
export async function pickConnection(ctx, given) {
  let wanted = String(given || "").trim();
  let via = "Page";
  if (!wanted) {
    wanted = await envValue(ctx, "ai.connection");
    via = "Env";
  }
  if (!wanted) {
    try {
      const def = await ctx.host.params.config("ai.connection.default");
      wanted = def && def.found && String(def.value).trim() ? String(def.value).trim() : "";
    } catch (e) {
      wanted = "";
    }
    via = "Default";
  }
  if (!wanted) {
    wanted = await settingsConnection(ctx);
    via = "Settings";
  }
  if (!wanted) throw new Error(tr(ctx, "error.noConnection"));
  let r = null;
  try {
    r = await ctx.host.resources.get(wanted);
  } catch (e) {
    r = null;
  }
  if (!r) {
    for (const x of await connectionList(ctx)) if (x.id === wanted || x.name === wanted) r = x;
  }
  if (!r) throw new Error(tr(ctx, `error.connectionMissing${via}`, { connection: wanted }));
  const model = r.body && typeof r.body.model === "string" ? r.body.model : "";
  return { id: r.id, name: r.name || r.id, model };
}

// The default connection chosen on the workbench settings page (a resource of this plugin). When generate is
// called through the interface, that resource is the call's own.
export async function settingsConnection(ctx) {
  const own = ctx.resource && ctx.resource.body && typeof ctx.resource.body.connection === "string" ? ctx.resource : null;
  if (own && String(ctx.resource.kind || "").endsWith(`:${KIND_SETTINGS}`)) return own.body.connection.trim();
  try {
    const all = (await ctx.host.resources.list({ kind: `${PLUGIN}:${KIND_SETTINGS}` })) || [];
    for (const r of Array.isArray(all) ? all : all.items || []) {
      const full = r.body ? r : await ctx.host.resources.get(r.id);
      const v = full && full.body && typeof full.body.connection === "string" ? full.body.connection.trim() : "";
      if (v) return v;
    }
  } catch (e) {
    /* no settings resource: no default */
  }
  return "";
}

// Every connection resource of every plugin that implements the chat interface (for the picker).
export async function connectionList(ctx) {
  const out = [];
  let impls = [];
  try {
    impls = (await ctx.host.interfaces.list(IFACE)) || [];
  } catch (e) {
    return out;
  }
  for (const i of impls) {
    try {
      const all = (await ctx.host.resources.list({ kind: `${i.plugin}:${i.kind}` })) || [];
      for (const r of Array.isArray(all) ? all : all.items || []) out.push(r);
    } catch (e) {
      /* a plugin whose resources cannot be listed has none to offer */
    }
  }
  return out;
}

// What is kept about a send (never the content): who, when, which connection and model, how long, how much.
export async function audit(ctx, rec) {
  try {
    const raw = await ctx.host.storage.get(AUDIT_KEY);
    const list = raw ? JSON.parse(raw) : [];
    list.push({ at: new Date().toISOString(), ...rec });
    await ctx.host.storage.set(AUDIT_KEY, JSON.stringify(list.slice(-AUDIT_MAX)));
  } catch (e) {
    /* an audit that cannot be written must not hide the answer */
  }
}

/* ---------------------------------------------------------------- K4 masking */

const SENSITIVE_WORDS = ["password", "passwd", "pwd", "passphrase", "token", "secret", "credential", "credentials", "email", "mail", "phone", "mobile", "ssn", "iban", "cvv", "salt", "apikey", "passport"];
const SENSITIVE_PARTS = ["api_key", "access_key", "private_key", "secret_key", "credit_card", "card_number", "phone_number", "id_card", "id_number", "bank_account"];
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const LONG_NUMBER = /\d(?:[ -]?\d){8,}/g;
export const MASK = "***";

export function wordsOf(label) {
  return String(label || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9\u0080-￿]+/)
    .filter(Boolean);
}

// `extra`: the user's own names (comma separated, from the settings): a word or a part of a name.
export function parseExtra(text) {
  return String(text || "")
    .split(/[,\n;]/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function isSensitiveColumn(label, extra) {
  const words = wordsOf(label);
  const joined = words.join("_");
  if (words.some((w) => SENSITIVE_WORDS.includes(w))) return true;
  if (SENSITIVE_PARTS.some((p) => joined.includes(p))) return true;
  return (extra || []).some((e) => words.includes(e) || (e.includes("_") && joined.includes(e)));
}

export function maskText(value, maxCell) {
  let s = value === null || value === undefined ? "" : String(value);
  s = s.replace(EMAIL, "[email]").replace(LONG_NUMBER, "[number]");
  if (maxCell > 0 && s.length > maxCell) s = `${s.slice(0, maxCell)}…`;
  return s;
}

// A table result → { columns, rows, masked: [labels], total, shown }. Whole columns with a sensitive name are
// masked; every cell loses emails and long digit strings and is cut; only the first `maxRows` rows go.
export function redactTable(output, opts) {
  const o = { maxRows: 20, maxCell: 200, extra: [], ...(opts || {}) };
  const columns = Array.isArray(output.columns) ? output.columns : [];
  const all = Array.isArray(output.rows) ? output.rows : [];
  const hidden = columns.map((c) => isSensitiveColumn(c.label || c.key, o.extra));
  const rows = all.slice(0, o.maxRows).map((r) => columns.map((_, i) => (hidden[i] ? MASK : maskText(r[i], o.maxCell))));
  return {
    columns: columns.map((c) => String(c.label || c.key)),
    rows,
    masked: columns.filter((_, i) => hidden[i]).map((c) => String(c.label || c.key)),
    total: typeof output.total === "number" ? output.total : all.length,
    shown: rows.length,
  };
}

const cell = (v) => String(v).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
export function markdownTable(t) {
  if (t.columns.length === 0) return "";
  const head = `| ${t.columns.map(cell).join(" | ")} |`;
  const sep = `| ${t.columns.map(() => "---").join(" | ")} |`;
  return [head, sep, ...t.rows.map((r) => `| ${r.map(cell).join(" | ")} |`)].join("\n");
}

/* ---------------------------------------------------------------- K2 reference documents */

const STOP = new Set(["select", "from", "where", "join", "left", "right", "inner", "outer", "group", "order", "limit", "with", "as", "on", "and", "or", "the"]);

// Table names after FROM/JOIN (schema prefix and quotes dropped). Not a parser: names are search terms.
export function tableNamesIn(sql) {
  const out = [];
  const re = /\b(?:from|join)\s+((?:[A-Za-z_"`][\w$"`]*\.)*[A-Za-z_"`][\w$"`]*)/gi;
  let m;
  while ((m = re.exec(String(sql || "")))) {
    const name = m[1].split(".").pop().replace(/["`]/g, "");
    if (name && !STOP.has(name.toLowerCase()) && !out.includes(name)) out.push(name);
  }
  return out;
}

export function searchTerms(tables, columns) {
  const out = [];
  for (const t of [...tables, ...columns]) {
    const s = String(t || "").trim();
    if (s.length >= 2 && !out.includes(s) && !/\s/.test(s)) out.push(s);
    if (out.length >= 20) break;
  }
  return out;
}

// Documents for these terms: any word counts, best first, only documents of the folder kind, and no more than
// `budget` tokens in all (the last one is cut to what is left when that is worth keeping).
export async function pickDocs(ctx, terms, budget) {
  if (terms.length === 0 || budget <= 0) return [];
  let hits = [];
  try {
    hits = (await ctx.host.resources.search({ query: terms.join(" "), mode: "any", rank: "relevance", kinds: [`${PLUGIN}:${KIND_DOC}`], limit: MAX_DOCS })) || [];
    if (!Array.isArray(hits)) hits = hits.items || [];
  } catch (e) {
    return [];
  }
  const docs = [];
  let left = budget;
  for (const h of hits) {
    if (docs.length >= MAX_DOCS || left < 50) break;
    let text = "";
    try {
      const r = await ctx.host.resources.get(h.id);
      text = r && r.body && typeof r.body.text === "string" ? r.body.text : String(h.snippet || "");
    } catch (e) {
      text = String(h.snippet || "");
    }
    let tokens = estimateTokens(text);
    if (tokens > left) {
      if (left < 200) continue;
      text = text.slice(0, left * 3);
      tokens = estimateTokens(text);
    }
    docs.push({ id: h.id, name: h.name || h.id, text, tokens, score: typeof h.score === "number" ? h.score : 0 });
    left -= tokens;
  }
  return docs;
}

/* ---------------------------------------------------------------- request text */

export function docsMarkdown(ctx, docs) {
  if (docs.length === 0) return "";
  return `\n\n## ${tr(ctx, "request.docs")}\n\n` + docs.map((d) => `### ${d.name}\n\n${d.text}`).join("\n\n");
}

export function composeRequest(ctx, request, docs) {
  return `${String(request || "").trimEnd()}${docsMarkdown(ctx, docs)}`;
}

function describeSource(ctx, meta) {
  const m = meta || {};
  return [m.plugin, m.kind].filter(Boolean).join(" / ") || tr(ctx, "request.unknownSource");
}

// The Markdown the user sees and edits: the task, the (masked) result, a note on what was left out.
export function buildRequest(ctx, read, opts) {
  const meta = read.meta || {};
  const out = read.output || {};
  const lines = [`# ${tr(ctx, "request.title")}`, "", `## ${tr(ctx, "request.task")}`, "", tr(ctx, "request.task.default"), "", `## ${tr(ctx, "request.result", { source: describeSource(ctx, meta) })}`, ""];
  const notes = [];
  if (out.type === "table") {
    const t = redactTable(out, opts);
    lines.push(markdownTable(t));
    if (t.shown < t.total) notes.push(tr(ctx, "note.rows", { shown: t.shown, total: t.total }));
    if (t.masked.length > 0) notes.push(tr(ctx, "note.masked", { columns: t.masked.join(", ") }));
    notes.push(tr(ctx, "note.cells", { max: (opts && opts.maxCell) || 200 }));
  } else if (out.type === "text") {
    const s = maskText(out.text, 0);
    lines.push(s.length > TEXT_MAX ? `${s.slice(0, TEXT_MAX)}…` : s);
    if (s.length > TEXT_MAX) notes.push(tr(ctx, "note.text", { max: TEXT_MAX }));
  }
  if (notes.length > 0) lines.push("", ...notes.map((n) => `> ${n}`));
  return lines.join("\n");
}

/* ---------------------------------------------------------------- K8 check of a proposed statement */

// Removes comments and the inside of strings and quoted names, so words inside them are not read as SQL.
export function skeleton(sql) {
  const s = String(sql || "");
  let out = "";
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    const next = s[i + 1];
    if (c === "-" && next === "-") {
      while (i < s.length && s[i] !== "\n") i++;
      out += " ";
    } else if (c === "/" && next === "*") {
      let depth = 1;
      i += 2;
      while (i < s.length && depth > 0) {
        if (s[i] === "/" && s[i + 1] === "*") (depth++, (i += 2));
        else if (s[i] === "*" && s[i + 1] === "/") (depth--, (i += 2));
        else i++;
      }
      out += " ";
    } else if (c === "'" || c === '"' || c === "`") {
      i++;
      while (i < s.length) {
        if (s[i] === c) {
          if (s[i + 1] === c) i += 2;
          else break;
        } else i++;
      }
      i++;
      out += `${c}${c}`;
    } else if (c === "$") {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(s.slice(i, i + 140));
      if (m) {
        const end = s.indexOf(m[0], i + m[0].length);
        i = end < 0 ? s.length : end + m[0].length;
        out += "''";
      } else {
        out += c;
        i++;
      }
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

const SQL_WRITES = ["insert", "update", "delete", "drop", "alter", "create", "truncate", "grant", "revoke", "merge", "call", "copy", "execute", "vacuum", "into", "comment", "reindex", "refresh"];

// Only one SELECT or WITH statement passes. `reason`: empty | multiple | notSelect | writes.
export function checkSql(sql) {
  const flat = skeleton(sql).trim().replace(/[;\s]+$/, "");
  if (!flat) return { ok: false, reason: "empty" };
  if (flat.includes(";")) return { ok: false, reason: "multiple" };
  const first = (/^\(*\s*([A-Za-z]+)/.exec(flat) || [])[1];
  if (!first || !["select", "with"].includes(first.toLowerCase())) return { ok: false, reason: "notSelect" };
  const words = flat.toLowerCase().match(/[a-z_]+/g) || [];
  if (words.some((w) => SQL_WRITES.includes(w))) return { ok: false, reason: "writes" };
  return { ok: true };
}

// The statement of an answer: the first fenced block, else the whole text.
export function extractSql(text) {
  const t = String(text || "");
  const m = /```[A-Za-z]*\s*\n([\s\S]*?)```/.exec(t);
  return (m ? m[1] : t).trim();
}

/* ---------------------------------------------------------------- the provider call */

// Calls the chat of the connection's plugin. Returns the answer, or throws the words for the user.
async function chat(ctx, connection, input) {
  let res;
  try {
    res = await ctx.host.interfaces.call(IFACE, "chat", input, { resource: connection.id });
  } catch (e) {
    if (e && e.code === "invalid" && e.params && (e.params.reason === "noImplementation" || e.params.reason === "wrongInterface")) throw new Error(tr(ctx, "error.noProvider", { connection: connection.name }));
    throw e;
  }
  res = res && res.data ? res.data : res; // D441: the structured answer is `data`; `output` is only words
  if (res && res.error) throw new Error(tr(ctx, `error.chat.${CHAT_ERRORS.includes(res.error.code) ? res.error.code : "other"}`, { message: res.error.message || "", seconds: res.error.retryAfter || "" }));
  if (!res || typeof res.text !== "string") throw new Error(tr(ctx, "error.chat.other", { message: "" }));
  if (res.stop === "refusal") throw new Error(tr(ctx, "error.chat.refusal"));
  return res;
}

const CHAT_ERRORS = ["auth", "rateLimit", "overloaded", "timeout", "tooLong", "refusal", "network", "other"];
const usageText = (u) => (u && typeof u === "object" ? `${u.input || 0} / ${u.output || 0}` : "");

/* ---------------------------------------------------------------- K6 saving */

// The analysis belongs to the run it analyzes (D442: deleted with it). No such host call → an error, never a
// silent copy somewhere else.
export async function saveArtifact(ctx, runId, artifact) {
  const runs = ctx.host.runs;
  if (!runs || typeof runs.saveArtifact !== "function") throw new Error(tr(ctx, "error.noArtifacts"));
  return runs.saveArtifact(runId, artifact);
}

/* ---------------------------------------------------------------- the analysis page */

const bodyOf = (ctx) => {
  const b = (ctx.resource && ctx.resource.body) || {};
  const pick = (key, dflt) => {
    if (ctx.run && ctx.run.input && typeof ctx.run.input[`body.${key}`] === "string") return ctx.run.input[`body.${key}`];
    if (ctx.draft && typeof ctx.draft[`body.${key}`] === "string") return ctx.draft[`body.${key}`];
    return typeof b[key] === "string" ? b[key] : dflt;
  };
  return pick;
};

function docsOf(pick) {
  try {
    const list = JSON.parse(pick("docs", "[]"));
    return Array.isArray(list) ? list.slice(0, MAX_DOCS) : [];
  } catch (e) {
    return [];
  }
}

export function chosenDocs(docs, pick) {
  return docs.filter((_, i) => pick(`use${i}`, "true") !== "false");
}

async function connectionLine(ctx, given) {
  try {
    const c = await pickConnection(ctx, given);
    return { text: tr(ctx, "info.connection", { connection: c.name, model: c.model || tr(ctx, "info.modelDefault") }), connection: c };
  } catch (e) {
    return { text: String(e.message || e), danger: true, connection: null };
  }
}

/* ---------------------------------------------------------------- K2 folder sync */

async function walkDocs(ctx, dir, found, depth) {
  if (depth > 6 || found.length >= DOC_MAX_FILES) return;
  let offset = 0;
  for (;;) {
    const page = await ctx.host.files.list(dir, { offset, limit: PAGE });
    for (const e of page.entries || []) {
      if (e.hidden || String(e.name).startsWith(".")) continue;
      if (e.dir) await walkDocs(ctx, e.path, found, depth + 1);
      else if (DOC_FILE.test(e.name) && found.length < DOC_MAX_FILES) found.push(e);
    }
    if (page.next === undefined || page.next === null) return;
    offset = page.next;
  }
}

function underRoot(path, roots) {
  const p = String(path).replace(/\/+$/, "");
  return (roots || []).some((r) => {
    const base = String(typeof r === "string" ? r : r.path || "").replace(/\/+$/, "");
    return base !== "" && (p === base || p.startsWith(`${base}/`));
  });
}

export async function syncDocs(ctx) {
  const folder = (await setting(ctx, "docFolder", "")).trim();
  if (!folder) throw new Error(tr(ctx, "error.noFolder"));
  if (!underRoot(folder, await ctx.host.files.roots())) throw new Error(tr(ctx, "error.folderNotAuthorized", { folder }));
  const found = [];
  await walkDocs(ctx, folder, found, 0);
  const batch = [];
  for (const e of found) {
    let text = "";
    try {
      text = String((await ctx.host.files.readText(e.path)).text || "").slice(0, DOC_MAX_CHARS);
    } catch (err) {
      continue;
    }
    batch.push({ key: e.path, name: e.name, body: { path: e.path, text } });
  }
  await ctx.host.resources.upsertByKey(KIND_DOC, batch, found.length >= DOC_MAX_FILES ? {} : { othersMissing: true });
  return batch.length;
}

/* ---------------------------------------------------------------- plugin */

export default {
  activate(host) {
    host.pages.handle("settings", {
      async render(ctx) {
        const pick = bodyOf(ctx);
        const chosen = pick("connection", "");
        const conns = await connectionList(ctx);
        const options = [{ value: "", label: ctx.t("connection.none") }, ...conns.map((r) => ({ value: r.id, label: r.name }))];
        if (chosen && !conns.some((r) => r.id === chosen)) options.push({ value: chosen, label: chosen });
        return {
          view: [
            { type: "form", id: "settings", layout: "stack", fields: [{ name: "connection", label: ctx.t("field.defaultConnection"), kind: "ref", kinds: ["@implements:onedesk.ai.chat/1"], bind: "body.connection", options, hint: tr(ctx, "field.defaultConnection.hint") }] },
            { type: "text", id: "note", text: tr(ctx, "settings.note"), tone: "muted" },
          ],
        };
      },
    });

    host.pages.handle("doc", {
      async render(ctx) {
        const b = (ctx.resource && ctx.resource.body) || {};
        return { view: [{ type: "text", id: "path", text: String(b.path || ""), tone: "muted" }, { type: "text", id: "text", text: String(b.text || ""), format: "markdown" }], readOnly: true };
      },
    });

    host.pages.handle("analysis", {
      async render(ctx) {
        const pick = bodyOf(ctx);
        const view = [];
        const info = await connectionLine(ctx, pick("connectionId", ""));
        const docs = docsOf(pick);
        const used = chosenDocs(docs, pick);
        const full = composeRequest(ctx, pick("request", ""), used);
        const policy = await policyOf(ctx);
        const ro = ctx.run ? { readOnly: true } : {};
        const lines = [info.text, tr(ctx, "info.tokens", { tokens: estimateTokens(full) }), tr(ctx, `info.policy.${policy}`)];
        view.push({ type: "text", id: "info", text: lines.join("\n"), tone: info.danger || policy === "off" ? "danger" : "muted" });
        const conns = await connectionList(ctx);
        const chosen = pick("connectionId", "");
        const options = [{ value: "", label: ctx.t("connection.default") }, ...conns.map((r) => ({ value: r.id, label: r.name }))];
        if (chosen && !conns.some((r) => r.id === chosen)) options.push({ value: chosen, label: chosen });
        view.push({ type: "form", id: "connection", layout: "strip", fields: [{ name: "connectionId", label: ctx.t("field.connection"), kind: "ref", kinds: ["@implements:onedesk.ai.chat/1"], bind: "body.connectionId", options, hint: tr(ctx, "field.connection.hint"), ...ro }] });
        view.push({ type: "form", id: "request", layout: "stack", fields: [{ name: "request", label: ctx.t("field.request"), kind: "longtext", bind: "body.request", fill: true, hint: tr(ctx, "field.request.hint"), ...ro }] });
        if (docs.length > 0) {
          view.push({
            type: "form",
            id: "docs",
            layout: "stack",
            label: ctx.t("field.docs"),
            fields: docs.map((d, i) => ({ name: `use${i}`, label: String(d.name), kind: "boolean", bind: `body.use${i}`, hint: tr(ctx, "field.doc.hint", { tokens: d.tokens }), ...ro })),
          });
        }
        view.push({ type: "text", id: "full", text: full, format: "markdown" });
        const answer = pick("answer", "");
        if (answer) {
          view.push({ type: "text", id: "answerInfo", text: tr(ctx, "info.answer", { model: pick("model", ""), usage: pick("usage", "") }), tone: "muted" });
          view.push({ type: "text", id: "answer", text: answer, format: "markdown" });
          if (!ctx.run) view.push({ type: "form", id: "keep", layout: "strip", fields: [{ name: "name", label: ctx.t("field.name"), kind: "text", param: true, placeholder: ctx.t("field.name.placeholder") }] });
        }
        return { view };
      },

      // K6: keep the analysis with the run it came from.
      async onEvent(ctx, event) {
        if (event !== "keep") throw new Error(`unknown event ${event}`);
        const b = (ctx.resource && ctx.resource.body) || {};
        if (!b.answer) return { message: tr(ctx, "message.nothingToKeep") };
        const name = String((ctx.params && ctx.params.name) || "").trim() || tr(ctx, "analysis.defaultName", { date: new Date().toISOString().slice(0, 10) });
        if (!b.runId) return { message: tr(ctx, "message.noRun") };
        await saveArtifact(ctx, b.runId, { name, kind: "analysis", data: { request: b.sent || b.request || "", answer: b.answer, connection: b.connection || "", model: b.model || "", usage: b.usage || "" } });
        return { message: tr(ctx, "message.kept", { name }) };
      },
    });

    // K1 (result action): the user clicked "Analyze" on a run's result → a draft to look at, nothing sent.
    host.actions.handle("analyze", async (ctx, input) => {
      await requireAllowed(ctx);
      const runId = String((input && input.runId) || (ctx.args && ctx.args.runId) || "");
      if (!runId) throw new Error(tr(ctx, "error.noRun"));
      const read = await ctx.host.runs.read(runId);
      if (!read || !read.output) throw new Error(tr(ctx, "error.noResult"));
      const maxRows = await settingNumber(ctx, "maxRows", 20);
      const maxCell = await settingNumber(ctx, "maxCell", 200);
      const extra = parseExtra(await setting(ctx, "sensitiveColumns", ""));
      const request = buildRequest(ctx, read, { maxRows, maxCell, extra });
      // documents: by the table names of the statement and the column names of the result
      let docs = [];
      if (read.output.type === "table") {
        let tables = [];
        const rid = read.meta && read.meta.resource;
        if (rid) {
          try {
            const r = await ctx.host.resources.get(rid);
            tables = tableNamesIn(r && r.body && r.body.sql);
          } catch (e) {
            tables = [];
          }
        }
        const cols = (read.output.columns || []).map((c) => String(c.label || c.key));
        docs = await pickDocs(ctx, searchTerms(tables, cols), await settingNumber(ctx, "docBudget", 3000));
      }
      const body = { request, docs: JSON.stringify(docs.slice(0, MAX_DOCS)), runId, answer: "", model: "", usage: "", connection: "", connectionId: "", sent: "" };
      for (let i = 0; i < MAX_DOCS; i++) body[`use${i}`] = "true";
      const created = await ctx.host.resources.create({ kind: KIND_ANALYSIS, name: tr(ctx, "analysis.defaultName", { date: new Date().toISOString().slice(0, 10) }), body });
      return { output: { type: "link", label: created.name || tr(ctx, "analysis.new"), target: `resource:${created.id}` }, summary: { message: tr(ctx, "summary.draft") } };
    });

    // K3: only now does anything leave. The text is the user's (edited) request plus the documents ticked.
    host.actions.handle("send", async (ctx, input) => {
      await requireAllowed(ctx);
      const res = ctx.resource;
      if (!res) throw new Error(tr(ctx, "error.noRun"));
      const i = input || {};
      const pickBody = (key, dflt) => (typeof i[`body.${key}`] === "string" ? i[`body.${key}`] : res.body && typeof res.body[key] === "string" ? res.body[key] : dflt);
      const docs = docsOf(pickBody);
      const text = composeRequest(ctx, pickBody("request", ""), chosenDocs(docs, pickBody));
      if (!text.trim()) throw new Error(tr(ctx, "error.empty"));
      const connection = await pickConnection(ctx, pickBody("connectionId", ""));
      ctx.progress(undefined, tr(ctx, "step.sending", { connection: connection.name }));
      const answer = await chat(ctx, connection, { system: tr(ctx, "system.analyze"), messages: [{ role: "user", text }] });
      await ctx.host.resources.update(res.id, { "body.answer": answer.text, "body.model": answer.model || "", "body.usage": usageText(answer.usage), "body.connection": connection.name, "body.sent": text });
      await audit(ctx, { kind: "analyze", connection: connection.id, model: answer.model || "", chars: text.length, usage: answer.usage || null });
      return { output: { type: "text", text: answer.text }, summary: { message: tr(ctx, "summary.answered", { model: answer.model || "", usage: usageText(answer.usage) }) } };
    });

    // K7–K9: exported for other plugins. A proposal made from the words and the names of tables and columns —
    // never from data. Returns { text, model, usage, check } (or { error } / { needsPreview }); nothing is changed.
    host.actions.handle("generate", async (ctx, input) => {
      const data = await generate(ctx, input);
      // D441: `output` is readable text, `data` the structured result the caller reads.
      const text = data.error ? data.error.message : data.needsPreview ? data.request : data.text;
      return { output: { type: "text", text: String(text || "") }, data };
    });

    async function generate(ctx, input) {
      const i = input || {};
      if (i.kind !== "sql") return { error: { code: "badKind", message: tr(ctx, "error.badKind") } };
      const instruction = String(i.instruction || "").trim();
      if (!instruction) return { error: { code: "empty", message: tr(ctx, "error.empty") } };
      const policy = await policyOf(ctx);
      if (policy === "off") return { error: { code: "policyOff", message: tr(ctx, "error.policyOff") } };
      let connection;
      try {
        connection = await pickConnection(ctx);
      } catch (e) {
        return { error: { code: "noConnection", message: String(e.message || e) } };
      }
      const tables = ((i.context && i.context.tables) || []).map((t) => (typeof t === "string" ? { name: t, columns: [] } : { name: String(t.name || ""), columns: Array.isArray(t.columns) ? t.columns.map(String) : [] })).filter((t) => t.name);
      const budget = await settingNumber(ctx, "docBudget", 3000);
      const docs = await pickDocs(ctx, searchTerms(tables.map((t) => t.name), tables.flatMap((t) => t.columns)), Math.floor(budget / 2));
      const lines = [`# ${tr(ctx, "generate.title")}`, "", instruction];
      if (tables.length > 0) lines.push("", `## ${tr(ctx, "generate.tables")}`, "", ...tables.map((t) => (t.columns.length > 0 ? `- ${t.name}(${t.columns.join(", ")})` : `- ${t.name}`)));
      const request = composeRequest(ctx, lines.join("\n"), docs);
      const system = tr(ctx, "system.sql");
      // preview: the first call only says what would be sent; the caller shows it and calls again with confirm.
      if (policy === "preview" && i.confirm !== true) {
        return { needsPreview: true, request, system, connection: connection.name, model: connection.model, tokens: estimateTokens(`${system}\n${request}`) };
      }
      let answer;
      try {
        answer = await chat(ctx, connection, { system, messages: [{ role: "user", text: request }], format: "text" });
      } catch (e) {
        return { error: { code: "chat", message: String(e.message || e) } };
      }
      await audit(ctx, { kind: "generate", connection: connection.id, model: answer.model || "", chars: request.length, usage: answer.usage || null });
      const text = extractSql(answer.text);
      return { text, model: answer.model || "", usage: answer.usage || null, check: checkSql(text) };
    }

    // K2: folder → document resources.
    host.actions.handle("syncDocs", async (ctx) => {
      const n = await syncDocs(ctx);
      const message = tr(ctx, "summary.synced", { count: n });
      return { output: { type: "text", text: message }, summary: { message } };
    });
  },
};
