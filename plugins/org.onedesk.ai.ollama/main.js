// Ollama connection: one kind ("connection") = an address (the only host the connection may reach; a local address
// is allowed because it is written here, D308), a model, num_ctx, keep_alive and an optional authentication header
// whose value is a secret field (keychain only, written here as {{secret:name}}). Implements onedesk.ai.chat/1.
// Sandbox rules: no console, timers or fetch; the network is ctx.host.network.

import { fillHoles, holeNames, holeStrip, holeValues } from "./template.js";

export const DEFAULT_BASE = "http://127.0.0.1:11434";
export const DEFAULT_KEEP = "5m";
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

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

// The optional authentication header (for an Ollama behind a reverse proxy). The secret is the whole header value.
export function authHeaders(body) {
  const ref = secretName(body);
  if (!ref) return {};
  const name = String(body.authHeader || "Authorization").trim();
  if (!HEADER_NAME.test(name)) return null;
  return { [name]: `{{secret:${ref}}}` };
}

export function buildChat(body, input) {
  const i = input || {};
  const messages = [];
  let system = typeof i.system === "string" ? i.system : "";
  if (i.format === "json") system = `${system ? `${system}\n\n` : ""}Respond with a single valid JSON value and nothing else.`;
  if (system) messages.push({ role: "system", content: system });
  for (const m of Array.isArray(i.messages) ? i.messages : []) {
    if (m && (m.role === "user" || m.role === "assistant") && typeof m.text === "string") messages.push({ role: m.role, content: m.text });
  }
  const options = {};
  const ctxLen = Math.floor(Number(body.numCtx));
  if (Number.isFinite(ctxLen) && ctxLen > 0) options.num_ctx = ctxLen;
  const maxTokens = Math.floor(Number(i.maxTokens));
  if (Number.isFinite(maxTokens) && maxTokens > 0) options.num_predict = maxTokens;
  const req = { model: String(body.model || "").trim(), messages, stream: true, keep_alive: String(body.keepAlive || DEFAULT_KEEP).trim() || DEFAULT_KEEP };
  if (Object.keys(options).length > 0) req.options = options;
  if (i.format === "json") req.format = "json";
  return req;
}

// Incremental NDJSON reader: feed() takes decoded text in any split; calls onLine(object) per complete JSON line.
export function ndjsonParser(onLine) {
  let buf = "";
  const one = (line) => {
    const s = line.trim();
    if (!s) return;
    try {
      onLine(JSON.parse(s));
    } catch {
      /* a broken line is skipped */
    }
  };
  return {
    feed(text) {
      buf += text;
      let at;
      while ((at = buf.indexOf("\n")) >= 0) {
        one(buf.slice(0, at));
        buf = buf.slice(at + 1);
      }
    },
    end() {
      one(buf);
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
    return typeof j.error === "string" ? j.error : (j && j.error && j.error.message) || "";
  } catch {
    return "";
  }
}

export function mapHttpError(status, text, headers) {
  const message = errMessage(text);
  if (status === 401 || status === 403) return { code: "auth", message };
  if (status === 429) {
    const secs = Number(headerOf(headers, "retry-after"));
    return { code: "rateLimit", message, ...(Number.isFinite(secs) && secs >= 0 ? { retryAfter: secs } : {}) };
  }
  if (status === 503) return { code: "overloaded", message };
  if (status === 408 || status === 504) return { code: "timeout", message };
  if (status === 404 && /not found/i.test(message)) return { code: "other", message, notFound: true };
  return { code: "other", message: message || `HTTP ${status}` };
}

export function mapStop(reason) {
  if (reason === "stop") return "end";
  if (reason === "length") return "maxTokens";
  return reason ? "other" : "end";
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
  const auth = authHeaders(body);
  if (auth === null) return { error: { code: "other", message: tr(ctx, "error.headerName") } };
  return { base, auth };
}

async function runChat(ctx, input) {
  const body = await liveBody(ctx);
  const pre = preflight(ctx, body);
  if (pre.error) return failure(ctx, pre.error);
  const request = buildChat(body, input);
  if (!request.model) return failure(ctx, { code: "other", message: tr(ctx, "error.noModel") });
  const progress = typeof ctx.progress === "function" ? ctx.progress : null;
  const partial = ctx.host.runs && typeof ctx.host.runs.partial === "function" ? ctx.host.runs.partial : null;

  let text = "";
  let raw = "";
  let model = request.model;
  let doneLine = null;
  let lineError = null;
  let started = false;
  const parser = ndjsonParser((o) => {
    if (typeof o.error === "string") lineError = { code: "other", message: o.error };
    if (o.model) model = o.model;
    if (o.message && typeof o.message.content === "string") text += o.message.content;
    if (o.done === true) doneLine = o;
  });

  // The model may have to be loaded into memory first (seconds to minutes): say so until the first answer line.
  if (progress) progress(undefined, tr(ctx, "step.loading"));
  let res;
  try {
    res = await ctx.host.network.request({
      method: "POST",
      url: `${pre.base}/api/chat`,
      headers: { ...pre.auth, "content-type": "application/json" },
      body: JSON.stringify(request),
      stream: true,
      timeoutMs: 600000,
      idleTimeoutMs: 120000,
      onChunk: (chunk) => {
        if (raw.length < 8192) raw += chunk;
        const before = text.length;
        parser.feed(chunk);
        if (text.length === before) return;
        if (!started) {
          started = true;
          if (progress) progress(undefined, tr(ctx, "step.generating"));
        }
        if (partial) Promise.resolve(partial({ type: "text", text, format: "markdown" })).catch(() => {});
      },
    });
  } catch (err) {
    return failure(ctx, netError(ctx, err));
  }
  if (res.status < 200 || res.status >= 300) {
    const e = mapHttpError(res.status, raw || res.text || "", res.headers);
    if (e.notFound) return failure(ctx, { code: e.code, message: tr(ctx, "error.pull", { model: request.model }) });
    return failure(ctx, e);
  }
  parser.end();
  if (lineError) return failure(ctx, lineError);
  if (!doneLine) return failure(ctx, { code: "network", message: tr(ctx, "error.cutOff") });
  const hasUsage = typeof doneLine.prompt_eval_count === "number" || typeof doneLine.eval_count === "number";
  const usage = hasUsage ? { input: doneLine.prompt_eval_count || 0, output: doneLine.eval_count || 0 } : undefined;
  return finish(ctx, { text, model, ...(usage ? { usage } : {}), stop: mapStop(doneLine.done_reason) });
}

async function getJson(ctx, body, path) {
  const pre = preflight(ctx, body);
  if (pre.error) return { error: pre.error };
  let res;
  try {
    res = await ctx.host.network.request({ method: "GET", url: `${pre.base}${path}`, headers: pre.auth, timeoutMs: 30000 });
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
  const list = json && Array.isArray(json.models) ? json.models : [];
  return list.filter((m) => m && typeof (m.name || m.model) === "string").map((m) => ({ id: m.name || m.model, label: m.name || m.model }));
}

async function runModels(ctx) {
  const got = await getJson(ctx, await liveBody(ctx), "/api/tags");
  if (got.error) return failure(ctx, got.error);
  return finish(ctx, { models: modelList(got.json) });
}

export function errorText(ctx, e) {
  const key = { auth: "error.auth", rateLimit: "error.rateLimit", overloaded: "error.overloaded", timeout: "error.timeout", network: "error.network" }[e.code];
  const base = key ? tr(ctx, key) : tr(ctx, "error.other");
  return e.message && key !== "error.network" ? `${base}: ${e.message}` : e.message ? e.message : base;
}

async function runTest(ctx) {
  const body = await liveBody(ctx);
  const ver = await getJson(ctx, body, "/api/version");
  if (ver.error) throw new Error(errorText(ctx, ver.error));
  const tags = await getJson(ctx, body, "/api/tags");
  if (tags.error) throw new Error(errorText(ctx, tags.error));
  const version = String((ver.json && ver.json.version) || "?");
  const names = modelList(tags.json).map((m) => m.id);
  if (names.length === 0) {
    const model = String(body.model || "").trim() || "<model>";
    const message = tr(ctx, "test.noModels", { version, model });
    return { output: { type: "text", text: message }, data: { ok: true, version, models: 0 }, summary: { message: tr(ctx, "summary.test", { version, count: 0 }) } };
  }
  const message = tr(ctx, "test.ok", { version, count: names.length, models: names.join(", ") });
  return { output: { type: "text", text: message }, data: { ok: true, version, models: names.length }, summary: { message: tr(ctx, "summary.test", { version, count: names.length }) } };
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
          { type: "form", id: "address", layout: "strip", fields: [f("baseUrl", "text", { placeholder: DEFAULT_BASE, fill: true })] },
          {
            type: "form",
            id: "model",
            layout: "strip",
            fields: [f("model", "text", { placeholder: "llama3.1", hint: ctx.t("field.model.hint"), ...(ctx.run ? {} : { required: true }) }), f("numCtx", "number", { hint: ctx.t("field.numCtx.hint") }), f("keepAlive", "text", { placeholder: DEFAULT_KEEP, hint: ctx.t("field.keepAlive.hint") })],
          },
          { type: "form", id: "auth", layout: "strip", fields: [f("authHeader", "text", { placeholder: "Authorization", hint: ctx.t("field.authHeader.hint") }), f("secret", "secret", { hint: ctx.t("field.secret.hint") })] },
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
