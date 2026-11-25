// Anthropic connection: one kind ("connection") = an address (default https://api.anthropic.com), the API key (a
// secret field: it only lives in the keychain and is written here as {{secret:name}}, so it never reaches this
// code), a model and a few knobs. Implements the AI chat interface onedesk.ai.chat/1: chat, models, test.
// Sandbox rules: no console, timers or fetch; the network is ctx.host.network. Only the connection's own host is
// reachable (the address field grants it).

import { fillHoles, holeNames, holeStrip, holeValues } from "./template.js";

export const VERSION = "2026-10-21";
export const FALLBACK_BETA = "server-side-fallback-2026-07-01";
export const DEFAULT_BASE = "https://api.anthropic.com";
export const DEFAULT_MODEL = "claude-haiku-5-5";
export const EFFORTS = ["low", "medium", "high"];
const DEFAULT_MAX = 16000;
const MAX_TOKENS_CAP = 32000;

export function tr(ctx, key, vars) {
  const label = ctx.t(key);
  let text = typeof label === "string" ? label : label[ctx.locale] || label["en-US"] || key;
  for (const k of Object.keys(vars || {})) text = text.split(`{${k}}`).join(String(vars[k]));
  return text;
}

// The connection's settings as used now (D466): text settings may hold {{name}}, filled from the environment of the
// run or tab (a typed tab value first), so one connection uses another model (and so on) per environment.
// Not the address: it is what grants the network (the kernel reads it as written), so it stays literal. The secret
// is never a placeholder either: it stays a keychain reference.
const LITERAL = ["baseUrl", "secret"];
const templated = (b) => Object.keys(b).filter((k) => !LITERAL.includes(k) && typeof b[k] === "string");

export async function liveBody(ctx) {
  const b = bodyOf(ctx);
  const keys = templated(b);
  const { values } = await holeValues(ctx, holeNames(...keys.map((k) => b[k])));
  for (const k of keys) b[k] = fillHoles(b[k], values);
  return b;
}

export function bodyOf(ctx) {
  const b = { ...((ctx.resource && ctx.resource.body) || {}) };
  const draft = ctx.draft || {};
  for (const k of Object.keys(draft)) if (k.startsWith("body.") && typeof draft[k] === "string") b[k.slice(5)] = draft[k];
  return b;
}

// Parses the connection address by hand (the sandbox has no URL class). Returns { base, host } or { error }:
//   "badUrl"   not http(s), or characters that make the host ambiguous
//   "userInfo" the address holds user info (https://api.example.com@evil.example): always refused
//   "insecure" plain http to a host that is not this machine (127.0.0.1, localhost, [::1]): the secret would travel in clear
export function checkBase(text, fallback) {
  const raw = String(text === undefined || text === null || String(text).trim() === "" ? fallback : text).trim().replace(/\/+$/, "");
  const m = /^(https?):\/\/([^/?#]*)([/?#].*)?$/i.exec(raw);
  if (!m || /[\s\\\u0000-\u001f]/.test(raw)) return { error: "badUrl" };
  const authority = m[2];
  if (authority.includes("@")) return { error: "userInfo" };
  const hm = /^(\[[0-9a-fA-F:.]+\]|[^:\[\]]+)(?::(\d{1,5}))?$/.exec(authority);
  if (!hm) return { error: "badUrl" };
  const host = hm[1].toLowerCase();
  const local = host === "127.0.0.1" || host === "localhost" || host === "[::1]";
  if (m[1].toLowerCase() === "http" && !local) return { error: "insecure" };
  return { base: raw, host: hm[2] ? `${host}:${hm[2]}` : host };
}

const BASE_ERRORS = { badUrl: "error.badUrl", userInfo: "error.userInfo", insecure: "error.insecure" };

export function baseUrl(body) {
  return checkBase(body.baseUrl, DEFAULT_BASE).base || null;
}

export function secretName(body) {
  const ref = body && body.secret;
  return ref && typeof ref.secret === "string" && ref.secret ? ref.secret : "";
}

// Only Sonnet and Opus have a server-side fallback; Haiku does not.
export function supportsFallback(model) {
  return /sonnet|opus/i.test(String(model || ""));
}

export function headersFor(body, withJson) {
  const h = { "x-api-key": `{{secret:${secretName(body)}}}`, "anthropic-version": VERSION };
  if (withJson) h["content-type"] = "application/json";
  return h;
}

// The request body for POST /v1/messages. No `thinking`, no temperature or other sampling fields.
export function buildChat(body, input) {
  const i = input || {};
  const model = String(body.model || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  const wanted = Number(i.maxTokens) || Number(body.maxTokens) || DEFAULT_MAX;
  const maxTokens = Math.max(1, Math.min(MAX_TOKENS_CAP, Math.floor(wanted)));
  const effort = EFFORTS.includes(i.effort) ? i.effort : EFFORTS.includes(body.effort) ? body.effort : "medium";
  const messages = toMessages(i.messages);
  let system = typeof i.system === "string" ? i.system : "";
  if (i.format === "json") system = `${system ? `${system}\n\n` : ""}Respond with a single valid JSON value and nothing else.`;
  const req = { model, max_tokens: maxTokens, stream: true, messages, output_config: { effort } };
  if (system) req.system = system;
  const tools = toTools(i.tools);
  if (tools.length > 0) req.tools = tools;
  const fallback = body.fallback !== "false" && body.fallback !== false && supportsFallback(model);
  if (fallback) req.fallbacks = "default";
  return { request: req, fallback };
}

// D479: the interface's turns → Messages API turns. An assistant turn may carry `toolCalls` ({ id, name, arguments });
// `tool` turns ({ toolCallId, text, failed? }) answer them and go back as one user turn of tool_result blocks.
export function toMessages(list) {
  const out = [];
  for (const m of Array.isArray(list) ? list : []) {
    if (!m || typeof m.text !== "string") continue;
    if (m.role === "user") out.push({ role: "user", content: m.text });
    else if (m.role === "assistant") {
      const calls = Array.isArray(m.toolCalls) ? m.toolCalls.filter((c) => c && typeof c.id === "string" && typeof c.name === "string") : [];
      if (calls.length === 0) out.push({ role: "assistant", content: m.text });
      else {
        const blocks = m.text ? [{ type: "text", text: m.text }] : [];
        for (const c of calls) blocks.push({ type: "tool_use", id: c.id, name: c.name, input: c.arguments && typeof c.arguments === "object" ? c.arguments : {} });
        out.push({ role: "assistant", content: blocks });
      }
    } else if (m.role === "tool" && typeof m.toolCallId === "string") {
      const block = { type: "tool_result", tool_use_id: m.toolCallId, content: m.text, ...(m.failed ? { is_error: true } : {}) };
      const last = out[out.length - 1];
      if (last && last.role === "user" && Array.isArray(last.content) && last.content.every((b) => b.type === "tool_result")) last.content.push(block);
      else out.push({ role: "user", content: [block] });
    }
  }
  return out;
}

// D479: the tools the caller offers ({ name, description, inputSchema }) → the Messages API's.
export function toTools(list) {
  return (Array.isArray(list) ? list : [])
    .filter((t) => t && typeof t.name === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(t.name))
    .map((t) => ({ name: t.name, description: String(t.description || ""), input_schema: t.inputSchema && typeof t.inputSchema === "object" ? t.inputSchema : { type: "object" } }));
}

// Incremental SSE reader: feed() takes decoded text in any split; calls onEvent({event, data}) per complete event.
export function sseParser(onEvent) {
  let buf = "";
  const flush = (block) => {
    let event = "message";
    const data = [];
    for (const line of block.split("\n")) {
      if (line === "" || line.startsWith(":")) continue;
      const i = line.indexOf(":");
      const field = i < 0 ? line : line.slice(0, i);
      let value = i < 0 ? "" : line.slice(i + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
    }
    if (data.length > 0) onEvent({ event, data: data.join("\n") });
  };
  return {
    feed(text) {
      // a "\r" at the end of a chunk may be half of "\r\n": keep it until the next chunk shows
      buf += text;
      const keep = buf.endsWith("\r") ? "\r" : "";
      if (keep) buf = buf.slice(0, -1);
      buf = buf.replace(/\r\n?/g, "\n") + keep;
      let at;
      while ((at = buf.indexOf("\n\n")) >= 0) {
        flush(buf.slice(0, at));
        buf = buf.slice(at + 2);
      }
    },
    end() {
      buf = buf.replace(/\r\n?/g, "\n");
      if (buf.trim()) flush(buf);
      buf = "";
    },
  };
}

export function headerOf(headers, name) {
  const h = headers || {};
  for (const k of Object.keys(h)) if (k.toLowerCase() === name) return Array.isArray(h[k]) ? h[k][0] : h[k];
  return undefined;
}

function errMessage(text) {
  try {
    const j = JSON.parse(text);
    return (j && j.error && (j.error.message || j.error.type)) || "";
  } catch {
    return "";
  }
}

const TOO_LONG = /too long|too large|context|maximum.*tokens|exceed/i;

// HTTP status (+ body text, + headers) → the interface's error object. Never includes the request or the key.
export function mapHttpError(status, text, headers) {
  const message = errMessage(text);
  if (status === 401 || status === 403) return { code: "auth", message };
  if (status === 429) {
    const secs = Number(headerOf(headers, "retry-after"));
    return { code: "rateLimit", message, ...(Number.isFinite(secs) && secs >= 0 ? { retryAfter: secs } : {}) };
  }
  if (status === 529 || status === 503) return { code: "overloaded", message };
  if (status === 413 || (status === 400 && TOO_LONG.test(message))) return { code: "tooLong", message };
  if (status === 408 || status === 504) return { code: "timeout", message };
  return { code: "other", message: message || `HTTP ${status}` };
}

export function mapStreamError(type, message) {
  const t = String(type || "");
  if (t === "overloaded_error") return { code: "overloaded", message };
  if (t === "rate_limit_error") return { code: "rateLimit", message };
  if (t === "authentication_error" || t === "permission_error") return { code: "auth", message };
  if (t === "request_too_large" || (t === "invalid_request_error" && TOO_LONG.test(message || ""))) return { code: "tooLong", message };
  return { code: "other", message: message || t };
}

export function mapStop(reason) {
  if (reason === "end_turn" || reason === "stop_sequence") return "end";
  if (reason === "tool_use") return "toolUse";
  if (reason === "max_tokens") return "maxTokens";
  if (reason === "refusal") return "refusal";
  return "other";
}

// The action's return value (D441): readable text for the run, the structured interface result in `data`.
function finish(ctx, result) {
  let text;
  if (result.error) text = errorText(ctx, result.error);
  else if (Array.isArray(result.models)) text = result.models.map((m) => m.id).join("\n");
  else text = result.text;
  // an answer is Markdown (D446); an error text or a model list is plain
  const markdown = !result.error && !Array.isArray(result.models);
  return { output: { type: "text", text, ...(markdown ? { format: "markdown" } : {}) }, data: result };
}
const failure = (ctx, error) => finish(ctx, { error });

function netError(ctx, err) {
  if (err && err.code === "denied" && err.params && err.params.reason === "cancelled") throw err;
  const reason = err && err.params && err.params.reason;
  if (reason === "timeout") return { code: "timeout", message: tr(ctx, "error.timeout") };
  return { code: "network", message: `${tr(ctx, "error.network")} (${(err && err.code) || "error"}${reason ? `/${reason}` : ""})` };
}

function preflight(ctx, body) {
  const checked = checkBase(body.baseUrl, DEFAULT_BASE);
  if (checked.error) return { error: { code: "other", message: tr(ctx, BASE_ERRORS[checked.error]) } };
  const base = checked.base;
  if (!secretName(body)) return { error: { code: "auth", message: tr(ctx, "error.noKey") } };
  return { base };
}

async function runChat(ctx, input) {
  const body = await liveBody(ctx);
  const pre = preflight(ctx, body);
  if (pre.error) return failure(ctx, pre.error);
  const { request, fallback } = buildChat(body, input);
  const headers = headersFor(body, true);
  if (fallback) headers["anthropic-beta"] = FALLBACK_BETA;

  let text = "";
  let model = request.model;
  let inputTokens;
  let outputTokens;
  let stop = "";
  let streamError = null;
  const calls = []; // tool_use blocks, by content index: { id, name, json }
  let raw = ""; // body of a non-2xx answer
  const partial = ctx.host.runs && typeof ctx.host.runs.partial === "function" ? ctx.host.runs.partial : null;

  const parser = sseParser(({ event, data }) => {
    let d;
    try {
      d = JSON.parse(data);
    } catch {
      return;
    }
    const type = (d && d.type) || event;
    if (type === "message_start" && d.message) {
      if (d.message.model) model = d.message.model;
      if (d.message.usage && d.message.usage.input_tokens !== undefined) inputTokens = d.message.usage.input_tokens;
    } else if (type === "content_block_delta" && d.delta && d.delta.type === "text_delta" && typeof d.delta.text === "string") {
      text += d.delta.text;
    } else if (type === "content_block_start" && d.content_block && d.content_block.type === "tool_use") {
      calls[d.index] = { id: String(d.content_block.id || ""), name: String(d.content_block.name || ""), json: "" };
    } else if (type === "content_block_delta" && d.delta && d.delta.type === "input_json_delta" && calls[d.index]) {
      calls[d.index].json += String(d.delta.partial_json || "");
    } else if (type === "message_delta") {
      if (d.delta && d.delta.stop_reason) stop = d.delta.stop_reason;
      if (d.usage) {
        if (d.usage.output_tokens !== undefined) outputTokens = d.usage.output_tokens;
        if (d.usage.input_tokens !== undefined) inputTokens = d.usage.input_tokens;
      }
    } else if (type === "error") {
      streamError = mapStreamError(d.error && d.error.type, (d.error && d.error.message) || "");
    }
  });

  let res;
  try {
    res = await ctx.host.network.request({
      method: "POST",
      url: `${pre.base}/v1/messages`,
      headers,
      body: JSON.stringify(request),
      stream: true,
      timeoutMs: 600000,
      idleTimeoutMs: 120000,
      onChunk: (chunk) => {
        // the status is not known yet: keep the start of the body (an error answer is JSON) and read it as SSE too
        if (raw.length < 8192) raw += chunk;
        const before = text.length;
        parser.feed(chunk);
        if (partial && text.length !== before) Promise.resolve(partial({ type: "text", text, format: "markdown" })).catch(() => {});
      },
    });
  } catch (err) {
    return failure(ctx, netError(ctx, err));
  }
  if (res.status < 200 || res.status >= 300) return failure(ctx, mapHttpError(res.status, raw || res.text || "", res.headers));
  parser.end();
  if (streamError) return failure(ctx, streamError);
  if (!stop && text === "") return failure(ctx, { code: "network", message: tr(ctx, "error.cutOff") });
  const usage = inputTokens !== undefined || outputTokens !== undefined ? { input: inputTokens || 0, output: outputTokens || 0 } : undefined;
  const toolCalls = calls.filter(Boolean).map((c) => {
    let args = {};
    try {
      args = c.json ? JSON.parse(c.json) : {};
    } catch {
      args = {};
    }
    return { id: c.id, name: c.name, arguments: args && typeof args === "object" && !Array.isArray(args) ? args : {} };
  });
  return finish(ctx, { text, model, ...(usage ? { usage } : {}), ...(toolCalls.length > 0 ? { toolCalls } : {}), stop: stop ? mapStop(stop) : "other" });
}

async function getJson(ctx, body, path) {
  const pre = preflight(ctx, body);
  if (pre.error) return { error: pre.error };
  let res;
  try {
    res = await ctx.host.network.request({ method: "GET", url: `${pre.base}${path}`, headers: headersFor(body, false), timeoutMs: 30000 });
  } catch (err) {
    return { error: netError(ctx, err) };
  }
  const text = String(res.text !== undefined ? res.text : res.body || "");
  if (res.status < 200 || res.status >= 300) return { error: mapHttpError(res.status, text, res.headers) };
  try {
    return { json: JSON.parse(text) };
  } catch {
    return { error: { code: "other", message: tr(ctx, "error.badAnswer") } };
  }
}

export function modelList(json) {
  const data = json && Array.isArray(json.data) ? json.data : [];
  return data.filter((m) => m && typeof m.id === "string").map((m) => ({ id: m.id, label: m.display_name || m.id }));
}

async function runModels(ctx) {
  const got = await getJson(ctx, await liveBody(ctx), "/v1/models");
  if (got.error) return failure(ctx, got.error);
  return finish(ctx, { models: modelList(got.json) });
}

export function errorText(ctx, e) {
  const key = { auth: "error.auth", rateLimit: "error.rateLimit", overloaded: "error.overloaded", timeout: "error.timeout", tooLong: "error.tooLong", refusal: "error.refusal", network: "error.network" }[e.code];
  const base = key ? tr(ctx, key) : tr(ctx, "error.other");
  return e.message && key !== "error.network" ? `${base}: ${e.message}` : e.message ? e.message : base;
}

async function runTest(ctx) {
  const got = await getJson(ctx, await liveBody(ctx), "/v1/models");
  if (got.error) throw new Error(errorText(ctx, got.error));
  const count = modelList(got.json).length;
  return { output: { type: "text", text: tr(ctx, "test.ok", { count }) }, data: { ok: true, models: count }, summary: { message: tr(ctx, "summary.test", { count }) } };
}

// The line under the form: the host that is really reached, or why the address is refused.
function baseNote(ctx, body) {
  const checked = checkBase(body.baseUrl, DEFAULT_BASE);
  if (checked.error) return { text: tr(ctx, BASE_ERRORS[checked.error]), tone: "danger" };
  return { text: tr(ctx, "note.host", { host: checked.host }), tone: "muted" };
}

export default {
  activate(host) {
    host.pages.handle("editor", {
      async render(ctx) {
        const raw = bodyOf(ctx);
        const b = await liveBody(ctx);
        const strip = await holeStrip(ctx, holeNames(...templated(raw).map((k) => raw[k])));
        const ro = ctx.run ? { readOnly: true } : {};
        const f = (name, kind, extra) => ({ name, label: ctx.t(`field.${name}`), kind, bind: `body.${name}`, ...ro, ...(extra || {}) });
        const view = [
          { type: "form", id: "address", layout: "strip", fields: [f("baseUrl", "text", { placeholder: DEFAULT_BASE, fill: true }), f("secret", "secret", { hint: ctx.t("field.secret.hint"), ...(ctx.run ? {} : { required: true }) })] },
          {
            type: "form",
            id: "model",
            layout: "strip",
            fields: [
              f("model", "text", { placeholder: DEFAULT_MODEL, hint: ctx.t("field.model.hint") }),
              f("effort", "enum", { options: EFFORTS.map((e) => ({ value: e, label: ctx.t(`effort.${e}`) })) }),
              f("maxTokens", "number", { hint: ctx.t("field.maxTokens.hint") }),
            ],
          },
          { type: "form", id: "fallback", layout: "stack", fields: [f("fallback", "boolean", { hint: ctx.t("field.fallback.hint") })] },
          { type: "text", id: "note", ...baseNote(ctx, b) },
        ];
        if (strip) view.unshift(strip);
        return { view };
      },
    });

    host.actions.handle("chat", (ctx, input) => runChat(ctx, input));
    host.actions.handle("models", (ctx) => runModels(ctx));
    host.actions.handle("test", (ctx) => runTest(ctx));
  },
};
