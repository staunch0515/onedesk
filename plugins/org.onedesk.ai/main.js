// AI workbench: AI chats (D479, chat.js) — the one place to talk with AI, opened by the shell's "AI chat" button
// (interface onedesk.assist/2) or by "Analyze" on a result (K1); masking before anything leaves (K4), reference
// documents from an authorized folder (K2), and an exported `generate` for other plugins (K7–K9, a proposal,
// never data; its preview is a chat page in "sql" mode).
// It never talks to a provider directly: the chat goes through the plugin interface `onedesk.ai.chat/1` to the
// connection resource the user picked (ctx.host.interfaces.call). Sandbox rules: no console, timers or fetch.
import { chatEvent, clearChat, dropOnChat, openChat, renderChat, sendChat } from "./chat.js";
import { filled, holeNames, holeStrip } from "./template.js";
export const PLUGIN = "org.onedesk.ai";
export const IFACE = "onedesk.ai.chat/1";
export const KIND_ANALYSIS = "analysis";
export const KIND_DOC = "doc";
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

// The connections of the plugins that implement the chat interface: { id, name, kind, fields } from the host
// (basic information only, no secrets). Returns [] when the host cannot say.
export async function connectionList(ctx) {
  try {
    const all = (await ctx.host.interfaces.resources(IFACE)) || [];
    return Array.isArray(all) ? all : all.items || [];
  } catch (e) {
    return [];
  }
}

// The connection: the one chosen on the page, else the environment's `ai.connection`, else the workspace config
// `ai.connection`, else the plugin setting `connection`. { id, name, model }.
export async function pickConnection(ctx, given) {
  let wanted = String(given || "").trim();
  let via = "Page";
  if (!wanted) {
    wanted = await envValue(ctx, "ai.connection");
    via = "Env";
  }
  if (!wanted) {
    try {
      const def = await ctx.host.params.config("ai.connection");
      wanted = def && def.found && String(def.value).trim() ? String(def.value).trim() : "";
    } catch (e) {
      wanted = "";
    }
    via = "Default";
  }
  if (!wanted) {
    wanted = (await setting(ctx, "connection", "")).trim();
    via = "Settings";
  }
  if (!wanted) throw new Error(tr(ctx, "error.noConnection"));
  const list = await connectionList(ctx);
  const r = list.find((x) => x.id === wanted) || list.find((x) => x.name === wanted);
  if (!r) throw new Error(tr(ctx, `error.connectionMissing${via}`, { connection: wanted }));
  const model = r.fields && typeof r.fields.model === "string" ? r.fields.model : "";
  return { id: r.id, name: r.name || r.id, model };
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

// A column is sensitive when its name (the label and the key, lower-cased, as one string) contains any of these
// — a substring, so passwordhash, accessToken and emailaddress are caught; over-masking is the safe side.
const SENSITIVE_PARTS = ["password", "passwd", "pwd", "passphrase", "token", "secret", "credential", "email", "mail", "phone", "mobile", "ssn", "iban", "cvv", "salt", "key", "passport", "密码", "口令", "令牌", "密钥", "邮箱", "手机", "电话", "身份证", "银行卡", "パスワード", "トークン", "秘密", "メール", "電話"];
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
// digits with the usual separators between them: card numbers, phone numbers (+81 (90) 1234-5678, 138 0013 8000)
const NUMBERISH = /\+?\(?\d[\d\s().-]{6,}\d/g;
export const MASK = "***";

// The user's own names: lower-cased substrings.
export function parseExtra(text) {
  return String(text || "")
    .split(/[,\n;]/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function isSensitiveColumn(name, extra) {
  const all = (Array.isArray(name) ? name : [name]).map((n) => String(n || "").toLowerCase()).join(" ");
  return SENSITIVE_PARTS.some((p) => all.includes(p)) || (extra || []).some((e) => all.includes(e));
}

export function maskText(value, maxCell) {
  let s = value === null || value === undefined ? "" : String(value);
  s = s.replace(EMAIL, "[email]").replace(NUMBERISH, (m) => (m.replace(/\D/g, "").length < 8 || /^\d{4}-\d{2}-\d{2}\b/.test(m) ? m : "[number]"));
  if (maxCell > 0 && s.length > maxCell) s = `${s.slice(0, maxCell)}…`;
  return s;
}

// A table result → { columns, rows, masked: [labels], total, shown }. Whole columns with a sensitive name are
// masked; every cell loses emails and long digit strings and is cut; only the first `maxRows` rows go.
export function redactTable(output, opts) {
  const o = { maxRows: 20, maxCell: 200, extra: [], ...(opts || {}) };
  const columns = Array.isArray(output.columns) ? output.columns : [];
  const all = Array.isArray(output.rows) ? output.rows : [];
  const hidden = columns.map((c) => isSensitiveColumn([c.label, c.key], o.extra));
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

// Functions with side effects (sequences, sessions, files, large objects, other databases, locks, settings).
// PostgreSQL semantics only: other databases are not checked and not supported.
const SQL_EFFECT_NAMES = ["pg_terminate_backend", "pg_cancel_backend", "nextval", "setval", "pg_sleep", "pg_sleep_for", "pg_sleep_until", "set_config", "pg_notify", "pg_reload_conf", "pg_rotate_logfile", "pg_logical_emit_message", "txid_current", "pg_read_file", "pg_read_binary_file", "pg_ls_dir", "pg_stat_file", "pg_import_system_collations"];
const SQL_EFFECT_PREFIXES = ["lo_", "dblink", "pg_advisory", "pg_create_", "pg_drop_", "pg_replication_", "pg_switch_", "pg_file_", "pg_promote", "pg_wal_replay_"];

// Only one SELECT or WITH statement passes. `reason`: empty | multiple | notSelect | writes | sideEffects.
export function checkSql(sql) {
  const flat = skeleton(sql).trim().replace(/[;\s]+$/, "");
  if (!flat) return { ok: false, reason: "empty" };
  if (flat.includes(";")) return { ok: false, reason: "multiple" };
  const first = (/^\(*\s*([A-Za-z]+)/.exec(flat) || [])[1];
  if (!first || !["select", "with"].includes(first.toLowerCase())) return { ok: false, reason: "notSelect" };
  const words = flat.toLowerCase().match(/[a-z_]+/g) || [];
  if (words.some((w) => SQL_WRITES.includes(w))) return { ok: false, reason: "writes" };
  if (words.some((w) => SQL_EFFECT_NAMES.includes(w) || SQL_EFFECT_PREFIXES.some((p) => w.startsWith(p)))) return { ok: false, reason: "sideEffects" };
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

export async function connectionLine(ctx, given) {
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

/* ---------------------------------------------------------------- generate (K7–K9) */

const IDENT = /^[\w$.\u0080-\uffff"-]{1,100}$/;
const INSTRUCTION_MAX = 1000;

// Only names go out: tables and columns that look like names, and the user's sentence with emails and long digit
// strings masked and cut. A caller cannot carry rows through here.
export function cleanContext(input) {
  const instruction = maskText(String(input.instruction || "").trim(), INSTRUCTION_MAX);
  const raw = (input.context && Array.isArray(input.context.tables) ? input.context.tables : []).slice(0, 50);
  const tables = raw
    .map((t) => (typeof t === "string" ? { name: t, columns: [] } : { name: String(t.name || ""), columns: Array.isArray(t.columns) ? t.columns.map(String).slice(0, 100) : [] }))
    .filter((t) => IDENT.test(t.name))
    .map((t) => ({ name: t.name, columns: t.columns.filter((c) => IDENT.test(c)) }));
  return { instruction, tables };
}

// The statement is checked here, once, for whoever asks.
function proposalOf(answer) {
  const text = extractSql(answer.text);
  return { text, model: answer.model || "", usage: answer.usage || null, check: checkSql(text) };
}

async function generate(ctx, input) {
  const i = input || {};
  // the answer to an earlier preview: only what the workbench itself sent and stored
  if (typeof i.fetch === "string" && i.fetch) {
    const raw = await ctx.host.storage.get(`proposal:${i.fetch}`);
    if (!raw) return { pending: true };
    await ctx.host.storage.remove(`proposal:${i.fetch}`);
    try {
      await ctx.host.resources.remove(i.fetch);
    } catch (e) {
      /* the draft may be gone already */
    }
    return JSON.parse(raw);
  }
  if (i.kind !== "sql") return { error: { code: "badKind", message: tr(ctx, "error.badKind") } };
  const { instruction, tables } = cleanContext(i);
  if (!instruction) return { error: { code: "empty", message: tr(ctx, "error.empty") } };
  const policy = await policyOf(ctx);
  if (policy === "off") return { error: { code: "policyOff", message: tr(ctx, "error.policyOff") } };
  let connection;
  try {
    connection = await pickConnection(ctx);
  } catch (e) {
    return { error: { code: "noConnection", message: String(e.message || e) } };
  }
  const budget = await settingNumber(ctx, "docBudget", 3000);
  const docs = await pickDocs(ctx, searchTerms(tables.map((t) => t.name), tables.flatMap((t) => t.columns)), Math.floor(budget / 2));
  const lines = [`# ${tr(ctx, "generate.title")}`, "", instruction];
  if (tables.length > 0) lines.push("", `## ${tr(ctx, "generate.tables")}`, "", ...tables.map((t) => (t.columns.length > 0 ? `- ${t.name}(${t.columns.join(", ")})` : `- ${t.name}`)));
  const request = composeRequest(ctx, lines.join("\n"), docs);
  const system = tr(ctx, "system.sql");
  if (policy === "preview") {
    // The preview is the workbench's own page: the user reads it there and presses Send there. The caller gets
    // the same text to show, and asks for the answer later with `fetch`; it cannot send for the user.
    const created = await ctx.host.resources.create({ kind: KIND_ANALYSIS, name: tr(ctx, "generate.title"), body: { mode: "sql", request, system, docs: "[]", runId: "", connectionId: "" } });
    return { needsPreview: true, draft: created.id, request, system, connection: connection.name, model: connection.model, tokens: estimateTokens(`${system}\n${request}`) };
  }
  let answer;
  try {
    answer = await chat(ctx, connection, { system, messages: [{ role: "user", text: request }], format: "text" });
  } catch (e) {
    return { error: { code: "chat", message: String(e.message || e) } };
  }
  await audit(ctx, { kind: "generate", connection: connection.id, model: answer.model || "", chars: request.length, usage: answer.usage || null });
  return proposalOf(answer);
}

/* ---------------------------------------------------------------- plugin */

// What chat.js uses of this plugin's helpers.
const deps = { KIND: KIND_ANALYSIS, tr, policyOf, pickConnection, connectionLine, chat, audit, maskText, isSensitiveColumn, redactTable, markdownTable, estimateTokens, MASK, filled, setting, settingNumber, parseExtra, usageText };

export default {
  activate(host) {
    host.pages.handle("doc", {
      async render(ctx) {
        const b = (ctx.resource && ctx.resource.body) || {};
        // A document is a template too (D466): {{name}} shows the tab's environment's value.
        const text = String(b.text || "");
        const strip = await holeStrip(ctx, holeNames(text));
        return { view: [{ type: "text", id: "path", text: String(b.path || ""), tone: "muted" }, ...(strip ? [strip] : []), { type: "text", id: "text", text: await filled(ctx, text), format: "markdown" }], readOnly: true };
      },
    });

    host.pages.handle("analysis", {
      async render(ctx) {
        const pick = bodyOf(ctx);
        if (pick("mode", "") !== "sql") return renderChat(ctx, deps);
        // A request another plugin asked for (generate's preview): read only, sent as it is.
        const view = [];
        const info = await connectionLine(ctx, pick("connectionId", ""));
        const request = pick("request", "");
        const system = pick("system", "");
        const policy = await policyOf(ctx);
        const lines = [info.text, tr(ctx, "info.tokens", { tokens: estimateTokens(`${system}\n${request}`) }), tr(ctx, `info.policy.${policy}`)];
        view.push({ type: "text", id: "info", text: lines.join("\n"), tone: info.danger || policy === "off" ? "danger" : "muted" });
        view.push({ type: "text", id: "system", text: `**${tr(ctx, "field.system")}**\n\n${system}`, format: "markdown" });
        view.push({ type: "text", id: "full", text: request, format: "markdown" });
        return { view };
      },
      onEvent(ctx, event) {
        return chatEvent(ctx, event, deps);
      },
    });

    host.kinds.handle(KIND_ANALYSIS, {
      drop(ctx, ev) {
        return dropOnChat(ctx, ev, deps);
      },
    });

    // D479: the shell's "AI chat" button (interface onedesk.assist/2).
    host.commands.handle("openChat", (ctx, context) => openChat(ctx, context, deps));

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
      // D479: a chat about this result: the (masked) result goes along as material, the description is the request.
      const runText = buildRequest(ctx, read, { maxRows, maxCell, extra });
      const rid = read.meta && typeof read.meta.resource === "string" ? read.meta.resource : "";
      const created = await ctx.host.resources.create({
        kind: KIND_ANALYSIS,
        name: tr(ctx, "analysis.defaultName", { date: new Date().toISOString().slice(0, 10) }),
        description: tr(ctx, "request.task.default"),
        body: { mode: "", system: "", request: "", docs: "[]", runId, runText, connectionId: "", target: "", targetTab: "", targetName: "", refs: rid ? [rid] : [], turns: [] },
      });
      return { output: { type: "link", label: created.name || tr(ctx, "analysis.new"), target: `resource:${created.id}` }, summary: { message: tr(ctx, "summary.draft") } };
    });

    // K3: only now does anything leave. A chat sends its turn (chat.js); a request another plugin asked for (generate's
    // preview, "sql" mode) is sent exactly as stored with the draft.
    host.actions.handle("send", async (ctx, input) => {
      await requireAllowed(ctx);
      const res = ctx.resource;
      if (!res) throw new Error(tr(ctx, "error.noRun"));
      if (!(res.body && res.body.mode === "sql")) return sendChat(ctx, input, deps);
      const text = String(res.body.request || "");
      if (!text.trim()) throw new Error(tr(ctx, "error.empty"));
      const system = String(res.body.system || "");
      const connection = await pickConnection(ctx, String(res.body.connectionId || ""));
      ctx.progress(undefined, tr(ctx, "step.sending", { connection: connection.name }));
      const answer = await chat(ctx, connection, { system, messages: [{ role: "user", text }], format: "text" });
      await audit(ctx, { kind: "generate", connection: connection.id, model: answer.model || "", chars: text.length, usage: answer.usage || null });
      // the proposal waits in the plugin's storage for the plugin that asked (generate with `fetch`)
      const p = proposalOf(answer);
      await ctx.host.storage.set(`proposal:${res.id}`, JSON.stringify(p));
      return { output: { type: "text", text: p.text, format: "markdown" }, summary: { message: tr(ctx, p.check.ok ? "summary.proposed" : "summary.proposedBad") } };
    });

    // D479: empties the conversation (its description, material and target stay).
    host.actions.handle("clear", (ctx) => clearChat(ctx, deps));

    // K7–K9: exported for other plugins. A proposal made from the words and the names of tables and columns —
    // never from data. `data`: { text, model, usage, check } | { error } | { needsPreview, draft, request, system … }
    // | { pending } (D441: `output` is readable text, `data` what the caller reads).
    host.actions.handle("generate", async (ctx, input) => {
      const data = await generate(ctx, input);
      const text = data.error ? data.error.message : data.needsPreview ? data.request : data.pending ? "" : data.text;
      return { output: { type: "text", text: String(text || ""), format: "markdown" }, data };
    });

    // K2: folder → document resources.
    host.actions.handle("syncDocs", async (ctx) => {
      const n = await syncDocs(ctx);
      const message = tr(ctx, "summary.synced", { count: n });
      return { output: { type: "text", text: message }, summary: { message } };
    });
  },
};
