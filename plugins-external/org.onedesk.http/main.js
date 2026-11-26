// HTTP request plugin: one kind ("request"), a page with a parameter strip, an action "send" and a result tab
// with the response headers. Secrets ({{secret:name}}) are left exactly as written; the host fills them in.
// Sandbox rules: no console, timers or fetch; the network is ctx.host.network.

const HEADERS_KEY = "lastHeaders";
const INFO_KEY = "lastInfo";
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
const STATUS_TEXT = {
  200: "OK", 201: "Created", 202: "Accepted", 204: "No Content", 301: "Moved Permanently", 302: "Found", 304: "Not Modified",
  400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed", 409: "Conflict",
  422: "Unprocessable Entity", 429: "Too Many Requests", 500: "Internal Server Error", 502: "Bad Gateway", 503: "Service Unavailable", 504: "Gateway Timeout",
};
const NO_BODY = ["GET", "HEAD"];
const CONNECTION = "org.onedesk.connection";
const CONNECTION_KIND = `${CONNECTION}:connection`;

/* ---------------------------------------------------------------- helpers */

export function tr(ctx, key, vars) {
  const label = ctx.t(key);
  let text = typeof label === "string" ? label : label[ctx.locale] || label["en-US"] || key;
  for (const k of Object.keys(vars || {})) text = text.split(`{${k}}`).join(String(vars[k]));
  return text;
}

// ':name' is a parameter when it starts the text or follows a space, '=', ',', '(', '&', '?' or '/'.
// So the colon of "http://", "host:8080", `"key":value` and "{{secret:name}}" is not one.
const PARAM = /(^|[\s=,(&?/])(:[A-Za-z_][A-Za-z0-9_]*)/g;

export function paramNames(...texts) {
  const out = [];
  for (const text of texts) {
    for (const m of String(text || "").matchAll(PARAM)) {
      const name = m[2].slice(1);
      if (!out.includes(name)) out.push(name);
    }
  }
  return out;
}

export function fillParams(text, values) {
  return String(text || "").replace(PARAM, (all, lead, token) => {
    const v = values[token.slice(1)];
    return v === undefined || v === "" ? all : lead + v;
  });
}

export function paramKind(name) {
  if (name === "limit" || name === "page" || name.endsWith("_id")) return "number";
  if (name.endsWith("_time")) return "datetime";
  if (name.endsWith("_date")) return "date";
  return "text";
}

// "Name: value" per line; blank lines and lines starting with '#' are skipped. Values are kept as written.
export function parseHeaders(text) {
  const out = {};
  for (const raw of String(text || "").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf(":");
    if (i <= 0) continue;
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

export function statusText(status, given) {
  if (typeof given === "string" && given) return given;
  return STATUS_TEXT[status] || "";
}

// "name=value" per line; blank lines and '#' lines are skipped. Names and values are percent-encoded,
// except {{secret:…}} which is left exactly as written for the host to fill in.
export function encodePart(text) {
  return String(text)
    .split(/(\{\{[^{}]*\}\})/)
    .map((p, i) => (i % 2 === 1 ? p : encodeURIComponent(p)))
    .join("");
}

export function parseQuery(text) {
  const out = [];
  for (const raw of String(text || "").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    const name = (i < 0 ? line : line.slice(0, i)).trim();
    if (!name) continue;
    out.push([name, i < 0 ? "" : line.slice(i + 1).trim()]);
  }
  return out;
}

export function withQuery(url, pairs) {
  if (pairs.length === 0) return url;
  const hash = url.indexOf("#");
  const base = hash < 0 ? url : url.slice(0, hash);
  const tail = hash < 0 ? "" : url.slice(hash);
  const qs = pairs.map(([k, v]) => `${encodePart(k)}=${encodePart(v)}`).join("&");
  const sep = base.includes("?") ? (base.endsWith("?") || base.endsWith("&") ? "" : "&") : "?";
  return base + sep + qs + tail;
}

// Pretty-prints a JSON body when the Content-Type says JSON and the text parses; anything else is returned as it came.
export function formatBody(text, headers) {
  const type = Object.keys(headers || {}).filter((k) => k.toLowerCase() === "content-type").map((k) => String(headers[k]).toLowerCase())[0] || "";
  if (!/json/.test(type)) return text;
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch (e) {
    return text;
  }
}

export function byteLength(text) {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

async function connectionList(ctx) {
  try {
    const all = (await ctx.host.resources.list({ kind: CONNECTION_KIND })) || [];
    return Array.isArray(all) ? all : all.items || [];
  } catch (e) {
    return [];
  }
}

async function valueOf(ctx, name) {
  const typed = ctx.params && ctx.params[name];
  if (typed !== undefined && typed !== "") return typed;
  const found = await ctx.host.params.get(name);
  return found.found ? found.value : "";
}

// The connection chosen on the request: a resource id (a name is accepted too). Returns the id, or "" for none.
export async function pickConnection(ctx, given) {
  const wanted = String(given || "").trim();
  if (!wanted) return "";
  let list = [];
  try {
    const all = (await ctx.host.resources.list({ kind: CONNECTION_KIND })) || [];
    list = Array.isArray(all) ? all : all.items || [];
  } catch (e) {
    list = [];
  }
  const hit = list.find((r) => r.id === wanted) || list.find((r) => r.name === wanted);
  if (!hit) throw new Error(tr(ctx, "error.connectionMissing", { connection: wanted }));
  return hit.id;
}

// With a connection the address is a path below the connection's base address and the connection adds the
// authentication; the answer comes back inline as { status, statusText, headers, body, truncated }.
async function viaConnection(ctx, connectionId, request) {
  const input = { method: request.method, path: request.url, inline: true };
  if (request.headers) input.headers = request.headers;
  if (request.body !== undefined) input.body = request.body;
  let res;
  try {
    res = await ctx.host.actions.call(`${CONNECTION}:request`, input, { resource: connectionId });
  } catch (err) {
    throw new Error(`${tr(ctx, "error.network")}: ${(err && err.message) || "error"}`);
  }
  try {
    return JSON.parse(res.output.text);
  } catch (e) {
    throw new Error(tr(ctx, "error.connectionAnswer"));
  }
}

function bodyOf(ctx) {
  const pick = (key, dflt) => {
    if (ctx.run && ctx.run.input && typeof ctx.run.input[`body.${key}`] === "string") return ctx.run.input[`body.${key}`];
    if (ctx.draft && typeof ctx.draft[`body.${key}`] === "string") return ctx.draft[`body.${key}`];
    const b = ctx.resource && ctx.resource.body;
    return b && typeof b[key] === "string" ? b[key] : dflt;
  };
  return { connection: pick("connection", ""), method: pick("method", "GET"), url: pick("url", ""), query: pick("query", ""), headers: pick("headers", ""), body: pick("body", "") };
}

/* ---------------------------------------------------------------- plugin */

export default {
  activate(host) {
    host.pages.handle("editor", {
      async render(ctx) {
        const req = bodyOf(ctx);
        const readOnly = ctx.run ? true : undefined;
        const withRO = (f) => (readOnly ? { ...f, readOnly: true } : f);
        const view = [];
        const connections = await connectionList(ctx);
        if (connections.length > 0 || req.connection) {
          const options = [{ value: "", label: ctx.t("connection.none") }, ...connections.map((r) => ({ value: r.id, label: r.name }))];
          if (req.connection && !connections.some((r) => r.id === req.connection)) options.push({ value: req.connection, label: req.connection });
          view.push({
            type: "form",
            id: "connection",
            layout: "strip",
            fields: [withRO({ name: "connection", label: ctx.t("field.connection"), kind: "ref", kinds: [CONNECTION_KIND], bind: "body.connection", options, hint: ctx.t("field.connection.hint") })],
          });
        }
        view.push(
          {
            type: "form",
            id: "line",
            layout: "strip",
            fields: [
              withRO({ name: "method", label: ctx.t("field.method"), kind: "enum", bind: "body.method", options: METHODS.map((m) => ({ value: m, label: m })) }),
              withRO({ name: "url", label: ctx.t("field.url"), kind: "text", bind: "body.url", placeholder: ctx.t(req.connection ? "field.url.placeholderPath" : "field.url.placeholder"), fill: true }),
            ],
          },
        );

        const names = paramNames(req.url, req.query, req.headers, req.body);
        if (names.length > 0) {
          const fields = [];
          for (const name of names) {
            const field = { name, label: name, kind: paramKind(name), param: true };
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
          id: "query",
          layout: "stack",
          fields: [withRO({ name: "query", label: ctx.t("field.query"), kind: "longtext", bind: "body.query", placeholder: ctx.t("field.query.placeholder") })],
        });
        view.push({
          type: "form",
          id: "auth",
          layout: "strip",
          fields: [withRO({ name: "token", label: ctx.t("field.token"), kind: "secret", bind: "body.token", hint: ctx.t("field.token.hint") })],
        });
        view.push({
          type: "form",
          id: "headers",
          layout: "stack",
          fields: [withRO({ name: "headers", label: ctx.t("field.headers"), kind: "longtext", bind: "body.headers", placeholder: ctx.t("field.headers.placeholder") })],
        });
        view.push({
          type: "form",
          id: "payload",
          layout: "stack",
          fields: [withRO({ name: "body", label: ctx.t("field.body"), kind: "longtext", bind: "body.body", fill: true, placeholder: ctx.t("field.body.placeholder") })],
        });
        return { view };
      },

      async renderResultTab(ctx, tabId) {
        const id = (ctx.run && ctx.run.resourceId) || "-";
        const read = async (prefix) => {
          const raw = await ctx.host.storage.get(`${prefix}:${id}`);
          try {
            return raw ? JSON.parse(raw) : null;
          } catch (e) {
            return null;
          }
        };
        if (tabId === "info") {
          const info = await read(INFO_KEY);
          if (!info) return [{ type: "text", id: "none", text: tr(ctx, "headers.none"), tone: "muted" }];
          const status = `${info.status}${info.statusText ? ` ${info.statusText}` : ""}`;
          return [
            {
              type: "table",
              id: "info",
              columns: [
                { key: "name", label: tr(ctx, "info.name") },
                { key: "value", label: tr(ctx, "info.value") },
              ],
              rows: [
                [tr(ctx, "info.status"), status],
                [tr(ctx, "info.time"), `${info.ms} ms`],
                [tr(ctx, "info.size"), `${info.bytes} bytes`],
              ],
            },
          ];
        }
        if (tabId !== "headers") throw new Error(`unknown result tab ${tabId}`);
        const headers = await read(HEADERS_KEY);
        const names = headers ? Object.keys(headers).sort() : [];
        if (names.length === 0) return [{ type: "text", id: "none", text: tr(ctx, "headers.none"), tone: "muted" }];
        return [
          {
            type: "table",
            id: "headers",
            columns: [
              { key: "name", label: tr(ctx, "headers.name") },
              { key: "value", label: tr(ctx, "headers.value") },
            ],
            rows: names.map((n) => [n, String(headers[n])]),
          },
        ];
      },
    });

    // On a connection resource (this plugin's `fetch` is what lets it list connections): GET its base address.
    host.actions.handle("fetch", async (ctx) => {
      if (!ctx.resource) throw new Error(tr(ctx, "error.noUrl"));
      const res = await viaConnection(ctx, ctx.resource.id, { method: "GET", url: "" });
      const text = String(res.body || "");
      return { output: { type: "text", text: formatBody(text, res.headers) }, summary: { message: `${res.status}` } };
    });

    host.actions.handle("send", async (ctx, input) => {
      const raw = {
        method: String((input && input["body.method"]) || "GET").toUpperCase(),
        url: String((input && input["body.url"]) || ""),
        query: String((input && input["body.query"]) || ""),
        headers: String((input && input["body.headers"]) || ""),
        body: String((input && input["body.body"]) || ""),
      };
      if (!raw.url.trim()) throw new Error(tr(ctx, "error.noUrl"));
      if (!METHODS.includes(raw.method)) throw new Error(tr(ctx, "error.method"));

      // {{token}} stands for the secret saved in this request's token field (its name is in the resource body).
      const ref = ctx.resource && ctx.resource.body && ctx.resource.body.token;
      const alias = (text) => (ref && typeof ref.secret === "string" ? text.split("{{token}}").join(`{{secret:${ref.secret}}}`) : text);
      raw.url = alias(raw.url);
      raw.query = alias(raw.query);
      raw.headers = alias(raw.headers);
      raw.body = alias(raw.body);

      const values = {};
      for (const name of paramNames(raw.url, raw.query, raw.headers, raw.body)) values[name] = await valueOf(ctx, name);

      const pairs = parseQuery(fillParams(raw.query, values));
      const request = { method: raw.method, url: withQuery(fillParams(raw.url, values).trim(), pairs) };
      const headers = parseHeaders(fillParams(raw.headers, values));
      if (Object.keys(headers).length > 0) request.headers = headers;
      if (!NO_BODY.includes(raw.method) && raw.body !== "") request.body = fillParams(raw.body, values);

      const connectionId = await pickConnection(ctx, input && input["body.connection"] !== undefined ? input["body.connection"] : bodyOf(ctx).connection);
      const started = Date.now();
      let res;
      try {
        res = connectionId ? await viaConnection(ctx, connectionId, request) : await ctx.host.network.request(request);
      } catch (err) {
        if (connectionId) throw err;
        const reason = err && err.params && err.params.reason ? `/${err.params.reason}` : "";
        throw Object.assign(new Error(`${tr(ctx, "error.network")} (${(err && err.code) || "error"}${reason})`), { code: err && err.code, params: err && err.params });
      }
      const ms = Date.now() - started;

      const id = (ctx.resource && ctx.resource.id) || "-";
      await ctx.host.storage.set(`${HEADERS_KEY}:${id}`, JSON.stringify(res.headers || {}));

      const text = String(res.body || "");
      const bytes = byteLength(text);
      const status = statusText(res.status, res.statusText);
      await ctx.host.storage.set(`${INFO_KEY}:${id}`, JSON.stringify({ status: res.status, statusText: status, ms, bytes }));
      let json;
      try {
        json = /json/i.test(String((res.headers || {})["content-type"] || "")) ? JSON.parse(text) : undefined;
      } catch {
        json = undefined;
      }
      return {
        // D487 §25: for a step in a book.
        data: named(ctx, { status: res.status, ms, body: text.length > 65536 ? text.slice(0, 65536) : text, headers: res.headers || {}, ...(json !== undefined ? { json } : {}) }),
        output: { type: "text", text: raw.method === "HEAD" ? "" : formatBody(text, res.headers) },
        summary: { message: tr(ctx, "summary.sent", { status: `${res.status}${status ? ` ${status}` : ""}`, ms, bytes }) + (res.truncated ? tr(ctx, "summary.truncated") : "") },
      };
    });
  },
};

// D487 §25: what a run gives another run (a step in a book) besides its output: values by name, each also under its
// name in every language of this plugin (`data.<name>`), so a step can write `@检查.退出码` or `@check.exitCode`.
export function named(ctx, values) {
  const out = {};
  for (const [k, v] of Object.entries(values)) {
    out[k] = v;
    const l = ctx.t(`data.${k}`);
    for (const w of typeof l === "string" ? [l] : Object.values(l || {})) if (w && w !== `data.${k}` && !(w in out)) out[w] = v;
  }
  return out;
}
