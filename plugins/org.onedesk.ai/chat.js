// AI chat (D479, docs/redesign/ai-chat.md): a conversation is a resource. Its description (info panel) is the
// lasting background, the input box is what is wanted this time, its material (`refs`) is other resources — their
// content and the result of their last run — and its target is the resource an answer may be applied to.
// Everything is masked and cut before it leaves; with `ai.policy = preview` the first Send only shows the full text.
// The shell's "AI chat" button runs the command `openChat` (interface onedesk.assist/2).

export const MAX_REFS = 20;
export const MAX_TURNS = 200;
export const TURN_MAX = 20000; // characters of one turn kept
export const FIELD_MAX = 4000; // characters of the target's field sent
export const REF_FIELD_MAX = 2000; // characters of a material's field sent
export const RESULT_TEXT_MAX = 4000;
export const HISTORY_TOKENS = 12000;
export const APPLY_LANG = "onedesk-apply";
export const MAX_STEPS = 8; // look-ups (tool calls) before one answer
export const TOOL_RESULT_MAX = 8000; // characters of one tool result sent back
export const STEP_DETAIL_MAX = 2000; // characters of one step kept for the page

const str = (v) => (v === null || v === undefined ? "" : String(v));
const isId = (v) => typeof v === "string" && /^[0-9a-f]{32}$/.test(v);

/* ---------------------------------------------------------------- body */

export function chatBody(ctx) {
  const b = (ctx.resource && ctx.resource.body) || {};
  return {
    target: str(b.target),
    targetTab: str(b.targetTab),
    targetName: str(b.targetName),
    refs: Array.isArray(b.refs) ? b.refs.filter(isId).slice(0, MAX_REFS) : [],
    turns: Array.isArray(b.turns) ? b.turns.filter((t) => t && (t.role === "user" || t.role === "assistant") && typeof t.text === "string") : [],
    connectionId: str(b.connectionId),
    runText: str(b.runText),
  };
}

const labelText = (ctx, label) => (label && typeof label === "object" ? label[ctx.locale] || label["en-US"] || Object.values(label)[0] || "" : str(label));

/* ---------------------------------------------------------------- reading the target and the material */

// The target page (pages.fields), with what is typed on its open tab (`target.draft`) over the saved values.
export async function readTarget(ctx, b, input) {
  if (!b.target) return null;
  let info;
  try {
    info = await ctx.host.pages.fields(b.target, ctx.envId || null);
  } catch (e) {
    return { error: e && e.params && e.params.reason ? e.params.reason : "unreadable", name: b.targetName };
  }
  const draft = input && input["target.draft"] && typeof input["target.draft"] === "object" ? input["target.draft"] : {};
  const fields = (info.fields || []).map((f) => ({ ...f, label: labelText(ctx, f.label) || f.name, hint: labelText(ctx, f.hint), value: f.name in draft && typeof draft[f.name] !== "object" ? str(draft[f.name]) : f.value === null || f.value === undefined ? "" : typeof f.value === "string" ? f.value : JSON.stringify(f.value) }));
  const typed = input && typeof input["target.description"] === "string" ? input["target.description"] : null;
  return {
    name: str(info.name) || str(info.title) || b.targetName,
    kind: labelText(ctx, info.kindLabel),
    description: typed !== null ? typed : str(info.description),
    fields,
  };
}

// The material: name, kind, description, fields, last result in this environment. Only what the user let AI see.
export async function readRefs(ctx, ids) {
  if (ids.length === 0) return [];
  let found = [];
  try {
    const r = await ctx.host.resources.search({ ids, limit: MAX_REFS });
    found = Array.isArray(r) ? r : (r && r.items) || [];
  } catch (e) {
    found = [];
  }
  const out = [];
  for (const id of ids) {
    const hit = found.find((x) => x.id === id);
    if (!hit || hit.deleted) {
      out.push({ id, missing: true });
      continue;
    }
    const ref = { id, name: str(hit.name), kind: labelText(ctx, hit.kindLabel), icon: hit.icon, visible: hit.aiVisible === true };
    out.push(ref);
  }
  return out;
}

async function refContent(ctx, ref) {
  let info = null;
  let latest = null;
  try {
    info = await ctx.host.pages.fields(`resource:${ref.id}`, ctx.envId || null);
  } catch (e) {
    info = null;
  }
  try {
    latest = await ctx.host.runs.latest(ref.id, ctx.envId || null);
  } catch (e) {
    latest = null;
  }
  return { ...ref, description: info ? str(info.description) : "", fields: info ? (info.fields || []).map((f) => ({ ...f, label: labelText(ctx, f.label) || f.name })) : [], latest };
}

/* ---------------------------------------------------------------- the request */

function formatOf(f) {
  if (f.format) return str(f.format);
  if (f.kind === "code") return f.language ? `code:${f.language}` : "code";
  if (f.kind === "longtext") return "markdown";
  return "text";
}
const fence = (format, text) => ["```" + (format.startsWith("code:") ? format.slice(5) : ""), text, "```"].join("\n");

function fieldValue(f, max, deps) {
  const sensitive = deps.isSensitiveColumn([f.name, f.label], []);
  return sensitive ? deps.MASK : deps.maskText(str(f.value), max);
}

function resultMarkdown(ctx, latest, deps, opts) {
  const out = latest && latest.output;
  if (!out) return "";
  const at = latest.meta && latest.meta.at ? new Date(latest.meta.at).toISOString().slice(0, 16).replace("T", " ") : "";
  const head = deps.tr(ctx, "chat.request.lastRun", { env: (latest.meta && latest.meta.env) || "—", at });
  if (out.type === "table") {
    const t = deps.redactTable(out, opts);
    const notes = [];
    if (t.shown < t.total) notes.push(deps.tr(ctx, "note.rows", { shown: t.shown, total: t.total }));
    if (t.masked.length > 0) notes.push(deps.tr(ctx, "note.masked", { columns: t.masked.join(", ") }));
    return [`**${head}**`, "", deps.markdownTable(t), ...notes.map((n) => `> ${n}`)].join("\n");
  }
  if (out.type === "text") {
    const s = deps.maskText(out.text, 0);
    return [`**${head}**`, "", "```", s.length > RESULT_TEXT_MAX ? `${s.slice(0, RESULT_TEXT_MAX)}…` : s, "```"].join("\n");
  }
  return "";
}

// The system text: who the model is, the background, the target with its fields, the material.
export function composeSystem(ctx, parts, deps) {
  const { background, target, refs, runText } = parts;
  const lines = [deps.tr(ctx, "chat.system")];
  if (background.trim()) lines.push("", `## ${deps.tr(ctx, "chat.request.background")}`, "", background.trim());
  if (target && !target.error) {
    lines.push("", `## ${deps.tr(ctx, "chat.request.target", { name: target.name, kind: target.kind })}`);
    if (target.description.trim()) lines.push("", target.description.trim());
    for (const f of target.fields) {
      lines.push("", `### \`${f.name}\` — ${f.label} (${formatOf(f)})${f.editable ? "" : ` ${deps.tr(ctx, "chat.request.readOnly")}`}`);
      if (f.hint) lines.push(f.hint);
      const v = fieldValue(f, FIELD_MAX, deps);
      lines.push(v ? fence(formatOf(f), v) : deps.tr(ctx, "assist.request.empty"));
    }
    if (target.fields.some((f) => f.editable)) lines.push("", deps.tr(ctx, "chat.system.apply", { lang: APPLY_LANG }));
  }
  if (runText) lines.push("", `## ${deps.tr(ctx, "chat.request.run")}`, "", runText);
  const usable = refs.filter((r) => !r.missing && r.visible);
  if (usable.length > 0) {
    lines.push("", `## ${deps.tr(ctx, "chat.request.refs")}`);
    for (const r of usable) {
      lines.push("", `### ${r.name} (${r.kind})`);
      if (r.description && r.description.trim()) lines.push("", r.description.trim());
      for (const f of r.fields || []) {
        const v = fieldValue(f, REF_FIELD_MAX, deps);
        if (v) lines.push("", `**${f.label}**`, "", fence(formatOf(f), v));
      }
      const res = resultMarkdown(ctx, r.latest, deps, parts.opts);
      if (res) lines.push("", res);
    }
  }
  return lines.join("\n");
}

// The turns that go along: newest first until the budget is used, then in order.
export function history(turns, budget, estimate) {
  const out = [];
  let left = budget;
  for (let i = turns.length - 1; i >= 0; i--) {
    const cost = estimate(turns[i].text);
    if (cost > left && out.length > 0) break;
    out.unshift({ role: turns[i].role, text: turns[i].text });
    left -= cost;
  }
  return out;
}

// A short, stable fingerprint of what would be sent (the preview is for exactly this text).
export function fingerprint(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return `${text.length}:${h.toString(16)}`;
}

/* ---------------------------------------------------------------- looking things up (step 2) */

// Masks a tool result like everything else that leaves, but keeps resource and run ids whole: the model needs them
// for its next look-up (an id may hold a long run of digits that would read as a number to mask).
export function maskKeepingIds(text, max, deps) {
  const ids = [];
  const held = str(text).replace(/\b[0-9a-f]{32}\b/g, (m) => `\u0000${ids.push(m) - 1}\u0000`);
  return deps.maskText(held, max).replace(/\u0000(\d+)\u0000/g, (_, i) => ids[Number(i)]);
}

// The tools the kernel offers the chat (the same as an MCP client's: search, describe, run, get_run, plugin tools).
export async function offeredTools(ctx) {
  try {
    const list = ctx.host.tools && typeof ctx.host.tools.list === "function" ? await ctx.host.tools.list() : [];
    return (Array.isArray(list) ? list : []).filter((t) => t && typeof t.name === "string").map((t) => ({ name: t.name, description: str(t.description), inputSchema: t.inputSchema || { type: "object" } }));
  } catch (e) {
    return [];
  }
}

async function nameOf(ctx, id) {
  if (!isId(id)) return str(id);
  try {
    const r = await ctx.host.resources.search({ ids: [id], limit: 1 });
    const hit = (Array.isArray(r) ? r : (r && r.items) || [])[0];
    return hit && hit.name ? str(hit.name) : id;
  } catch (e) {
    return id;
  }
}

// What the page shows for one look-up.
export async function stepLabel(ctx, call, deps) {
  const a = (call && call.arguments) || {};
  if (call.name === "search") return deps.tr(ctx, "chat.step.search", { query: str(a.query) });
  if (call.name === "describe") return deps.tr(ctx, "chat.step.describe", { name: await nameOf(ctx, a.id) });
  if (call.name === "run") return deps.tr(ctx, "chat.step.run", { name: await nameOf(ctx, a.id) });
  if (call.name === "get_run") return deps.tr(ctx, "chat.step.getRun");
  return deps.tr(ctx, "chat.step.tool", { name: str(call.name) });
}

// Asks, lets the model look things up (read only, what the user let AI see) and asks again, until it answers or
// MAX_STEPS look-ups are used up (then it must answer without tools). Returns the last answer and the steps.
export async function askWithTools(ctx, connection, system, messages, tools, deps) {
  const convo = [...messages];
  const steps = [];
  for (;;) {
    const offer = tools.length > 0 && steps.length < MAX_STEPS;
    const answer = await deps.chat(ctx, connection, { system, messages: [...convo], ...(offer ? { tools } : {}) });
    const calls = offer && Array.isArray(answer.toolCalls) ? answer.toolCalls.filter((c) => c && typeof c.name === "string").slice(0, MAX_STEPS - steps.length) : [];
    if (calls.length === 0) return { answer, steps };
    convo.push({ role: "assistant", text: str(answer.text), toolCalls: calls });
    for (const c of calls) {
      const label = await stepLabel(ctx, c, deps);
      ctx.progress(undefined, deps.tr(ctx, "chat.step.doing", { label }));
      let text;
      let failed = false;
      try {
        const r = await ctx.host.tools.call(c.name, c.arguments || {});
        text = JSON.stringify(r && r.content !== undefined ? r.content : r);
      } catch (e) {
        failed = true;
        text = JSON.stringify({ error: (e && e.code) || "error", reason: (e && e.params && e.params.reason) || str(e && e.message) });
      }
      text = maskKeepingIds(text, TOOL_RESULT_MAX, deps);
      convo.push({ role: "tool", toolCallId: str(c.id), name: c.name, text, ...(failed ? { failed: true } : {}) });
      const asked = JSON.stringify(c.arguments || {});
      steps.push({ label, detail: `${asked}\n→ ${text}`.slice(0, STEP_DETAIL_MAX), ...(failed ? { failed: true } : {}) });
    }
  }
}

/* ---------------------------------------------------------------- the answer */

// Changes to the target the answer proposes: a ```onedesk-apply block with a JSON object (field → full new
// content); else, when the target has one editable code field, a single block in that field's language; else a
// JSON block whose keys are all editable fields. Only editable fields, as text. The block is taken out of the text.
// The JSON objects of the fenced blocks marked `lang`, found by the JSON's own structure (braces and strings), not by the
// next ``` — the content of a field may hold code blocks of its own. Each: { obj, start, end } (end: after the closing
// fence when there is one). Blocks that do not hold one whole JSON object are left out.
export function fencedJson(text, lang) {
  const t = str(text);
  const out = [];
  const open = new RegExp("```[ \\t]*" + lang.replace(/[-]/g, "\\$&") + "[ \\t]*\\r?\\n", "gi");
  let m;
  while ((m = open.exec(t)) !== null) {
    let i = m.index + m[0].length;
    while (i < t.length && /\s/.test(t[i])) i++;
    if (t[i] !== "{") continue;
    const from = i;
    let depth = 0;
    let inString = false;
    for (; i < t.length; i++) {
      const c = t[i];
      if (inString) {
        if (c === "\\") i++;
        else if (c === '"') inString = false;
      } else if (c === '"') inString = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) break;
    }
    if (depth !== 0 || i >= t.length) continue;
    let obj;
    try {
      obj = JSON.parse(t.slice(from, i + 1));
    } catch (e) {
      continue;
    }
    let end = i + 1;
    const close = /^\s*```/.exec(t.slice(end));
    if (close) end += close[0].length;
    out.push({ obj, start: m.index, end });
    open.lastIndex = end;
  }
  return out;
}

// Changes to the target the answer proposes: a ```onedesk-apply block with a JSON object (field → full new
// content); else a JSON block whose keys are all editable fields; else, when the target has one editable code field, a
// single block in that field's language. Only editable fields, as text. The onedesk-apply block is taken out of the
// shown text only when it was read.
export function parseApply(text, fields) {
  const editable = (fields || []).filter((f) => f.editable);
  const t = str(text);
  if (editable.length === 0) return { text: t, values: null };
  const pick = (obj) => {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
    const values = {};
    for (const f of editable) if (f.name in obj && obj[f.name] !== null && obj[f.name] !== undefined) values[f.name] = typeof obj[f.name] === "string" ? obj[f.name] : JSON.stringify(obj[f.name], null, 2);
    return Object.keys(values).length > 0 ? values : null;
  };
  for (const b of fencedJson(t, APPLY_LANG)) {
    const values = pick(b.obj);
    if (values) return { text: (t.slice(0, b.start) + t.slice(b.end)).replace(/\n{3,}/g, "\n\n").trim(), values };
  }
  const json = fencedJson(t, "json").find((b) => !Array.isArray(b.obj) && Object.keys(b.obj).length > 0 && Object.keys(b.obj).every((k) => editable.some((f) => f.name === k)));
  if (json) return { text: t, values: pick(json.obj) };
  const code = editable.filter((f) => f.kind === "code");
  if (editable.length === 1 && code.length === 1) {
    const lang = str(code[0].language).toLowerCase();
    const blocks = [...t.matchAll(/```([^\n`]*)\n([\s\S]*?)```/g)].map((x) => ({ lang: x[1].trim().toLowerCase(), body: x[2] }));
    const same = blocks.filter((b) => b.lang === lang);
    if (lang && same.length === 1) return { text: t, values: { [code[0].name]: same[0].body.replace(/\n$/, "") } };
  }
  return { text: t, values: null };
}

/* ---------------------------------------------------------------- the page */

export async function renderChat(ctx, deps) {
  const b = chatBody(ctx);
  const view = [];
  const policy = await deps.policyOf(ctx);
  const info = await deps.connectionLine(ctx, b.connectionId);
  view.push({ type: "text", id: "info", text: [info.text, deps.tr(ctx, `info.policy.${policy}`)].join(" · "), tone: info.danger || policy === "off" ? "danger" : "muted" });
  const ro = ctx.run ? { readOnly: true } : {};
  view.push({ type: "form", id: "connection", layout: "strip", fields: [{ name: "connectionId", label: ctx.t("field.connection"), kind: "ref", kinds: ["@implements:onedesk.ai.chat/1"], bind: "body.connectionId", hint: deps.tr(ctx, "field.connection.hint"), ...ro }] });
  if (b.target.startsWith("resource:")) view.push({ type: "link", id: "target", label: deps.tr(ctx, "chat.target", { name: b.targetName || b.target }), target: b.target });
  else if (b.target) view.push({ type: "text", id: "target", text: deps.tr(ctx, "chat.target", { name: b.targetName || deps.tr(ctx, "chat.target.new") }), tone: "muted" });
  const refs = await readRefs(ctx, b.refs);
  if (refs.length === 0) {
    view.push({ type: "text", id: "refsEmpty", text: deps.tr(ctx, "chat.refs.empty"), tone: "muted" });
  } else {
    view.push({
      type: "table",
      id: "refs",
      columns: [
        { key: "name", label: deps.tr(ctx, "chat.refs.name") },
        { key: "kind", label: deps.tr(ctx, "chat.refs.kind") },
        { key: "ai", label: deps.tr(ctx, "chat.refs.ai") },
      ],
      rows: refs.map((r) => (r.missing ? [deps.tr(ctx, "chat.refs.missing"), "", ""] : [r.name, r.kind, deps.tr(ctx, r.visible ? "chat.refs.visible" : "chat.refs.hidden")])),
      rowTargets: refs.map((r) => (r.missing ? null : `resource:${r.id}`)),
      rowKeys: refs.map((r) => r.id),
      rowActions: [{ id: "removeRef", label: deps.tr(ctx, "chat.refs.remove"), icon: "x" }],
    });
  }
  const applyTo = b.targetName || deps.tr(ctx, "chat.target.new");
  const turns = b.turns.map((t) => {
    const turn = { role: t.role, text: t.text };
    const note = [t.model, t.usage].filter(Boolean).join(" · ");
    if (t.role === "assistant" && note) turn.caption = note;
    if (t.role === "assistant" && Array.isArray(t.steps) && t.steps.length > 0) {
      turn.steps = t.steps.slice(0, 20).map((x) => ({ label: str(x.label), ...(x.detail ? { detail: str(x.detail) } : {}), ...(x.failed ? { failed: true } : {}) }));
    }
    if (t.role === "assistant" && b.target && t.apply && t.apply.values && Object.keys(t.apply.values).length > 0 && !ctx.run) {
      turn.actions = [{ id: "apply", label: deps.tr(ctx, "chat.apply", { name: applyTo }), icon: "check" }];
    }
    return turn;
  });
  const node = { type: "conversation", id: "chat", turns };
  if (!ctx.run) node.input = { name: "message", send: "send", placeholder: deps.tr(ctx, turns.length === 0 ? "chat.input.first" : "chat.input.next") };
  if (b.targetTab) node.targetTab = b.targetTab;
  view.push(node);
  return { view };
}

/* ---------------------------------------------------------------- Send */

export async function sendChat(ctx, input, deps) {
  const res = ctx.resource;
  if (!res) throw new Error(deps.tr(ctx, "error.noRun"));
  const policy = await deps.policyOf(ctx);
  if (policy === "off") throw new Error(deps.tr(ctx, "error.policyOff"));
  const b = chatBody(ctx);
  const i = input || {};
  if (typeof i["body.connectionId"] === "string") b.connectionId = i["body.connectionId"];
  if (b.turns.length + 2 > MAX_TURNS) throw new Error(deps.tr(ctx, "chat.error.full", { max: MAX_TURNS }));
  const target = await readTarget(ctx, b, i);
  const background = str(res.description);
  let typed = str(ctx.params && ctx.params.message).trim();
  if (!typed) {
    // Nothing typed and nothing said yet: the description is the request (D470, now the first turn).
    if (b.turns.length > 0) throw new Error(deps.tr(ctx, "chat.error.noMessage"));
    typed = background.trim() || (target && !target.error ? target.description.trim() : "");
    if (!typed) throw new Error(deps.tr(ctx, "chat.error.noInstruction"));
  }
  const message = await deps.filled(ctx, deps.maskText(typed, TURN_MAX));
  const opts = { maxRows: await deps.settingNumber(ctx, "maxRows", 20), maxCell: await deps.settingNumber(ctx, "maxCell", 200), extra: deps.parseExtra(await deps.setting(ctx, "sensitiveColumns", "")) };
  const refs = [];
  // The target is sent once, as the target, with what its tab shows.
  const targetId = b.target.startsWith("resource:") && target && !target.error ? b.target.slice(9) : "";
  for (const r of await readRefs(ctx, b.refs.filter((id) => id !== targetId))) refs.push(r.missing || !r.visible ? r : await refContent(ctx, r));
  const system = composeSystem(ctx, { background: await deps.filled(ctx, background), target, refs, runText: b.runText, opts }, deps);
  const messages = [...history(b.turns, HISTORY_TOKENS, deps.estimateTokens), { role: "user", text: message }];
  const connection = await deps.pickConnection(ctx, b.connectionId);
  const tools = await offeredTools(ctx);
  if (policy === "preview") {
    const full = JSON.stringify({ system, messages, connection: connection.id });
    const key = `pending:${res.id}`;
    const seen = await ctx.host.storage.get(key);
    if (seen !== fingerprint(full)) {
      await ctx.host.storage.set(key, fingerprint(full));
      const left = refs.filter((r) => r.missing || !r.visible).map((r) => r.name || r.id);
      const lines = [`# ${deps.tr(ctx, "chat.preview.title", { connection: connection.name, model: connection.model || deps.tr(ctx, "info.modelDefault") })}`, "", deps.tr(ctx, "info.tokens", { tokens: deps.estimateTokens(`${system}\n${messages.map((m) => m.text).join("\n")}`) })];
      if (left.length > 0) lines.push("", `> ${deps.tr(ctx, "chat.preview.left", { names: left.join(", ") })}`);
      if (messages.length - 1 < b.turns.length) lines.push("", `> ${deps.tr(ctx, "chat.preview.turns", { shown: messages.length - 1, total: b.turns.length })}`);
      if (tools.length > 0) lines.push("", `> ${deps.tr(ctx, "chat.preview.tools", { n: tools.length, max: MAX_STEPS })}`);
      lines.push("", `## ${deps.tr(ctx, "field.system")}`, "", system, "", `## ${deps.tr(ctx, "chat.preview.messages")}`);
      for (const m of messages) lines.push("", `**${deps.tr(ctx, m.role === "user" ? "chat.role.user" : "chat.role.assistant")}**`, "", m.text);
      return { output: { type: "text", text: lines.join("\n"), format: "markdown" }, summary: { message: deps.tr(ctx, "chat.preview.again") } };
    }
    await ctx.host.storage.remove(key);
  }
  ctx.progress(undefined, deps.tr(ctx, "step.sending", { connection: connection.name }));
  const { answer, steps } = await askWithTools(ctx, connection, system, messages, tools, deps);
  await deps.audit(ctx, { kind: "chat", connection: connection.id, model: answer.model || "", chars: system.length + messages.reduce((n, m) => n + m.text.length, 0), steps: steps.length, usage: answer.usage || null });
  const parsed = parseApply(answer.text, target && !target.error ? target.fields : []);
  const now = new Date().toISOString();
  const said = { role: "assistant", text: parsed.text.slice(0, TURN_MAX), model: answer.model || connection.model || "", usage: deps.usageText(answer.usage), at: now };
  if (parsed.values) said.apply = { values: parsed.values };
  if (steps.length > 0) said.steps = steps;
  const turns = [...b.turns, { role: "user", text: typed.slice(0, TURN_MAX), at: now }, said];
  await ctx.host.resources.update(res.id, { "body.turns": turns });
  const summary = parsed.values ? deps.tr(ctx, "chat.answered.apply", { name: (target && target.name) || "" }) : deps.tr(ctx, "summary.answered", { model: said.model, usage: said.usage });
  return { output: { type: "text", text: answer.text, format: "markdown" }, summary: { message: summary } };
}

export async function clearChat(ctx, deps) {
  if (!ctx.resource) throw new Error(deps.tr(ctx, "error.noRun"));
  await ctx.host.resources.update(ctx.resource.id, { "body.turns": [] });
  const message = deps.tr(ctx, "chat.cleared");
  return { output: { type: "text", text: message }, summary: { message } };
}

/* ---------------------------------------------------------------- page events */

export async function chatEvent(ctx, event, deps) {
  const b = chatBody(ctx);
  if (event === "removeRef") {
    const refs = b.refs.filter((id) => id !== ctx.row);
    await ctx.host.resources.update(ctx.resource.id, { "body.refs": refs });
    return { message: deps.tr(ctx, "chat.refs.removed") };
  }
  if (event === "apply") {
    const turn = b.turns[Number(ctx.row)];
    if (!b.target || !turn || !turn.apply || !turn.apply.values) return { message: deps.tr(ctx, "chat.apply.nothing") };
    const apply = { target: b.target, label: b.targetName || deps.tr(ctx, "chat.target.new"), values: turn.apply.values };
    if (b.targetTab) apply.tabId = b.targetTab;
    return { apply };
  }
  throw new Error(`unknown event ${event}`);
}

// Resources dropped on the conversation in a tree become its material.
export async function dropOnChat(ctx, ev, deps) {
  const b = chatBody(ctx);
  const refs = [...b.refs];
  let added = 0;
  for (const s of (ev && ev.sources) || []) {
    if (!s || !isId(s.id) || s.id === ctx.resource.id || refs.includes(s.id)) continue;
    if (refs.length >= MAX_REFS) break;
    refs.push(s.id);
    added++;
  }
  if (added > 0) await ctx.host.resources.update(ctx.resource.id, { "body.refs": refs });
  return { handled: true, message: deps.tr(ctx, "chat.refs.added", { n: added }) };
}

/* ---------------------------------------------------------------- the "AI chat" button */

// A saved page has one conversation; a new, unsaved one has its own per tab.
const chatKey = (target, tabId) => (target.startsWith("new:") ? `chat:new:${tabId}` : `chat:${target}`);

// context: { target, tabId, args: { envId } } from the shell's button. Opens the conversation about this page;
// makes one (next to the page in the tree) the first time.
export async function openChat(ctx, context, deps) {
  const c = context || {};
  const target = str(c.target);
  const tabId = str(c.tabId);
  const envId = c.args && typeof c.args.envId === "string" && c.args.envId ? c.args.envId : undefined;
  if (!target.startsWith("resource:") && !target.startsWith("new:")) return [{ type: "toast", message: deps.tr(ctx, "chat.error.noPage"), tone: "warning" }];
  const open = (id) => [{ type: "open", target: `resource:${id}`, ...(envId ? { envId } : {}) }];
  const known = await ctx.host.storage.get(chatKey(target, tabId));
  if (known) {
    const r = await ctx.host.resources.get(known).catch(() => null);
    if (r && !r.deleted) {
      if (tabId && r.body && r.body.targetTab !== tabId) await ctx.host.resources.update(known, { "body.targetTab": tabId });
      return open(known);
    }
  }
  // A saved page by its name; a new one by the name typed in its info panel, else its title.
  let name = target.startsWith("new:") && c.args && typeof c.args.name === "string" ? c.args.name.trim() : "";
  if (!name) {
    try {
      const info = await ctx.host.pages.fields(target, envId || null);
      name = str(info.name) || str(info.title);
    } catch (e) {
      name = "";
    }
  }
  const own = target.startsWith("resource:") ? target.slice(9) : "";
  const created = await ctx.host.resources.create({
    kind: deps.KIND,
    name: deps.tr(ctx, "chat.name", { name: name || deps.tr(ctx, "chat.target.new") }),
    body: { mode: "", system: "", request: "", docs: "[]", runId: "", runText: "", connectionId: "", target, targetTab: tabId, targetName: name, refs: isId(own) ? [own] : [], turns: [] },
  });
  if (isId(own)) {
    try {
      await ctx.host.resources.move(created.id, { before: own });
    } catch (e) {
      /* another tree: it stays where new resources go */
    }
  }
  await ctx.host.storage.set(chatKey(target, tabId), created.id);
  return open(created.id);
}
