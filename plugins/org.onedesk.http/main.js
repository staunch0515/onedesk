// HTTP request plugin: one kind ("request"), a page with a parameter strip, an action "send" and a result tab
// with the response headers. Secrets ({{secret:name}}) are left exactly as written; the host fills them in.
// Sandbox rules: no console, timers or fetch; the network is ctx.host.network.

const HEADERS_KEY = "lastHeaders";
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
const NO_BODY = ["GET", "HEAD"];

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

async function valueOf(ctx, name) {
  const typed = ctx.params && ctx.params[name];
  if (typed !== undefined && typed !== "") return typed;
  const found = await ctx.host.params.get(name);
  return found.found ? found.value : "";
}

function bodyOf(ctx) {
  const pick = (key, dflt) => {
    if (ctx.run && ctx.run.input && typeof ctx.run.input[`body.${key}`] === "string") return ctx.run.input[`body.${key}`];
    if (ctx.draft && typeof ctx.draft[`body.${key}`] === "string") return ctx.draft[`body.${key}`];
    const b = ctx.resource && ctx.resource.body;
    return b && typeof b[key] === "string" ? b[key] : dflt;
  };
  return { method: pick("method", "GET"), url: pick("url", ""), headers: pick("headers", ""), body: pick("body", "") };
}

/* ---------------------------------------------------------------- plugin */

export default {
  activate(host) {
    host.pages.handle("editor", {
      async render(ctx) {
        const req = bodyOf(ctx);
        const readOnly = ctx.run ? true : undefined;
        const withRO = (f) => (readOnly ? { ...f, readOnly: true } : f);
        const view = [
          {
            type: "form",
            id: "line",
            layout: "strip",
            fields: [
              withRO({ name: "method", label: ctx.t("field.method"), kind: "enum", bind: "body.method", options: METHODS.map((m) => ({ value: m, label: m })) }),
              withRO({ name: "url", label: ctx.t("field.url"), kind: "text", bind: "body.url", placeholder: ctx.t("field.url.placeholder"), fill: true }),
            ],
          },
        ];

        const names = paramNames(req.url, req.headers, req.body);
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
        if (tabId !== "headers") throw new Error(`unknown result tab ${tabId}`);
        const key = `${HEADERS_KEY}:${(ctx.run && ctx.run.resourceId) || "-"}`;
        const raw = await ctx.host.storage.get(key);
        let headers = null;
        try {
          headers = raw ? JSON.parse(raw) : null;
        } catch (e) {
          headers = null;
        }
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

    host.actions.handle("send", async (ctx, input) => {
      const raw = {
        method: String((input && input["body.method"]) || "GET").toUpperCase(),
        url: String((input && input["body.url"]) || ""),
        headers: String((input && input["body.headers"]) || ""),
        body: String((input && input["body.body"]) || ""),
      };
      if (!raw.url.trim()) throw new Error(tr(ctx, "error.noUrl"));

      // {{token}} stands for the secret saved in this request's token field (its name is in the resource body).
      const ref = ctx.resource && ctx.resource.body && ctx.resource.body.token;
      const alias = (text) => (ref && typeof ref.secret === "string" ? text.split("{{token}}").join(`{{secret:${ref.secret}}}`) : text);
      raw.url = alias(raw.url);
      raw.headers = alias(raw.headers);
      raw.body = alias(raw.body);

      const values = {};
      for (const name of paramNames(raw.url, raw.headers, raw.body)) values[name] = await valueOf(ctx, name);

      const request = { method: raw.method, url: fillParams(raw.url, values).trim() };
      const headers = parseHeaders(fillParams(raw.headers, values));
      if (Object.keys(headers).length > 0) request.headers = headers;
      if (!NO_BODY.includes(raw.method) && raw.body !== "") request.body = fillParams(raw.body, values);

      const started = Date.now();
      let res;
      try {
        res = await ctx.host.network.request(request);
      } catch (err) {
        const reason = err && err.params && err.params.reason ? `/${err.params.reason}` : "";
        throw Object.assign(new Error(`${tr(ctx, "error.network")} (${(err && err.code) || "error"}${reason})`), { code: err && err.code, params: err && err.params });
      }
      const ms = Date.now() - started;

      const key = `${HEADERS_KEY}:${(ctx.resource && ctx.resource.id) || "-"}`;
      await ctx.host.storage.set(key, JSON.stringify(res.headers || {}));

      const text = String(res.body || "");
      return {
        output: { type: "text", text },
        summary: { message: tr(ctx, "summary.sent", { status: res.status, ms, bytes: byteLength(text) }) + (res.truncated ? tr(ctx, "summary.truncated") : "") },
      };
    });
  },
};
