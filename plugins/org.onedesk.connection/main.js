// API connection plugin: one kind ("connection") = an address (the only host the connection may reach), an
// authentication method and a secret that lives in the keychain. Other plugins call the exported action `request`
// on one connection. Sandbox rules: no console, timers or fetch; the network is ctx.host.network.
// The secret is only ever written as {{secret:name}}; the host fills it in, so it never reaches this code.

export const AUTH = ["none", "bearer", "basic", "header", "query"];
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
const NO_BODY = ["GET", "HEAD"];
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
const PARAM = /(^|[\s=,(&?/])(:[A-Za-z_][A-Za-z0-9_]*)/g;

export function tr(ctx, key, vars) {
  const label = ctx.t(key);
  let text = typeof label === "string" ? label : label[ctx.locale] || label["en-US"] || key;
  for (const k of Object.keys(vars || {})) text = text.split(`{${k}}`).join(String(vars[k]));
  return text;
}

function fail(ctx, key, vars) {
  return new Error(tr(ctx, key, vars));
}

// `:name` in the address is an environment parameter (e.g. https://:env_host/v1); same rule as the request plugin.
export function paramNames(text) {
  const out = [];
  for (const m of String(text || "").matchAll(PARAM)) {
    const name = m[2].slice(1);
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

export function fillParams(text, values) {
  return String(text || "").replace(PARAM, (all, lead, token) => {
    const v = values[token.slice(1)];
    return v === undefined || v === "" ? all : lead + v;
  });
}

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

// Percent-encodes everything except {{secret:…}} which the host fills in.
export function encodePart(text) {
  return String(text)
    .split(/(\{\{[^{}]*\}\})/)
    .map((p, i) => (i % 2 === 1 ? p : encodeURIComponent(p)))
    .join("");
}

export function withQuery(url, pairs) {
  if (pairs.length === 0) return url;
  const qs = pairs.map(([k, v]) => `${encodePart(k)}=${encodePart(v)}`).join("&");
  const sep = url.includes("?") ? (url.endsWith("?") || url.endsWith("&") ? "" : "&") : "?";
  return url + sep + qs;
}

// The base address and a path always give an address on the base's own host: the path is glued after a "/", so
// "//other.example", "https://other.example" or "@other" cannot change who is called.
export function joinUrl(base, path) {
  const b = String(base || "").trim().replace(/\/+$/, "");
  let p = String(path || "").trim();
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(p) && !p.startsWith("/")) return null;
  if (p.includes("\\") || /[\r\n]/.test(p)) return null;
  p = p.replace(/^\/+/, "");
  return p ? `${b}/${p}` : b;
}

export function secretRef(body) {
  const ref = body && body.secret;
  return ref && typeof ref.secret === "string" && ref.secret ? ref.secret : "";
}

// What the connection adds to a call: a header or a query pair, using {{secret:name}}. Nothing for `none`.
export function authParts(body) {
  const mode = AUTH.includes(body.auth) ? body.auth : "none";
  const ref = secretRef(body);
  if (mode === "none" || !ref) return { header: null, query: null, mode, missingSecret: mode !== "none" };
  const value = `{{secret:${ref}}}`;
  const name = String(body.authName || "").trim();
  if (mode === "bearer") return { header: ["Authorization", `Bearer ${value}`], query: null, mode };
  // Basic: the host puts base64("user:secret") in place of the reference (the user name never holds a colon).
  if (mode === "basic") {
    const user = String(body.username || "").trim();
    return { header: user && !user.includes(":") ? ["Authorization", `Basic {{secret:${ref}|basic:${user}}}`] : null, query: null, mode, badUser: user === "" ? "noUsername" : user.includes(":") ? "badUsername" : "" };
  }
  if (mode === "header") return { header: name ? [name, value] : null, query: null, mode, badName: !HEADER_NAME.test(name) };
  return { header: null, query: name ? [name, value] : null, mode, badName: !name };
}

// Builds the request for the network host interface. Throws (with the user's language) on a bad input.
export function buildRequest(ctx, body, input, values) {
  const i = input || {};
  const method = String(i.method || "GET").toUpperCase();
  if (!METHODS.includes(method)) throw fail(ctx, "error.method");
  const base = fillParams(body.url, values || {}).trim();
  if (!base) throw fail(ctx, "error.noUrl");
  if (!/^https?:\/\//i.test(base)) throw fail(ctx, "error.badUrl");
  const joined = joinUrl(base, i.path);
  if (joined === null) throw fail(ctx, "error.badPath");
  const auth = authParts(body);
  if (auth.missingSecret) throw fail(ctx, "error.noSecret");
  if (auth.badUser) throw fail(ctx, `error.${auth.badUser}`);
  if (auth.badName || (auth.mode === "header" && !auth.header) || (auth.mode === "query" && !auth.query)) throw fail(ctx, "error.noAuthName");

  const pairs = [];
  const q = i.query;
  if (q && typeof q === "object") for (const k of Object.keys(q)) pairs.push([k, String(q[k])]);
  if (auth.query) pairs.push(auth.query);

  const headers = { ...parseHeaders(body.headers) };
  const extra = i.headers && typeof i.headers === "object" ? i.headers : {};
  for (const k of Object.keys(extra)) {
    if (!HEADER_NAME.test(k)) throw fail(ctx, "error.headerName", { name: k });
    headers[k] = String(extra[k]);
  }
  if (auth.header) {
    for (const k of Object.keys(headers)) if (k.toLowerCase() === auth.header[0].toLowerCase()) delete headers[k];
    headers[auth.header[0]] = auth.header[1];
  }

  const request = { method, url: withQuery(joined, pairs) };
  if (Object.keys(headers).length > 0) request.headers = headers;
  if (!NO_BODY.includes(method) && i.body !== undefined && i.body !== null && i.body !== "") {
    request.body = typeof i.body === "string" ? i.body : JSON.stringify(i.body);
  }
  return request;
}

function bodyOf(ctx, input) {
  const b = { ...((ctx.resource && ctx.resource.body) || {}) };
  const src = input || {};
  for (const k of Object.keys(src)) if (k.startsWith("body.")) b[k.slice(5)] = src[k];
  const draft = ctx.draft || {};
  for (const k of Object.keys(draft)) if (k.startsWith("body.") && typeof draft[k] === "string") b[k.slice(5)] = draft[k];
  return b;
}

async function paramValues(ctx, text) {
  const values = {};
  for (const name of paramNames(text)) {
    const typed = ctx.params && ctx.params[name];
    if (typed !== undefined && typed !== "") {
      values[name] = typed;
      continue;
    }
    const found = await ctx.host.params.get(name);
    values[name] = found && found.found ? found.value : "";
  }
  return values;
}

async function send(ctx, body, input) {
  const values = await paramValues(ctx, body.url);
  const request = buildRequest(ctx, body, input, values);
  try {
    return await ctx.host.network.request(request);
  } catch (err) {
    const reason = err && err.params && err.params.reason ? `/${err.params.reason}` : "";
    throw Object.assign(new Error(`${tr(ctx, "error.network")} (${(err && err.code) || "error"}${reason})`), { code: err && err.code, params: err && err.params });
  }
}

export default {
  activate(host) {
    host.pages.handle("editor", {
      async render(ctx) {
        const b = bodyOf(ctx, null);
        const auth = AUTH.includes(b.auth) ? b.auth : "none";
        const ro = ctx.run ? { readOnly: true } : {};
        const f = (name, kind, extra) => ({ name, label: ctx.t(`field.${name}`), kind, bind: `body.${name}`, ...ro, ...(extra || {}) });
        const view = [
          {
            type: "form",
            id: "address",
            layout: "strip",
            fields: [f("url", "text", { placeholder: ctx.t("field.url.placeholder"), fill: true, ...(ctx.run ? {} : { required: true }) }), f("testPath", "text", { placeholder: ctx.t("field.testPath.placeholder") })],
          },
        ];
        const names = paramNames(b.url);
        if (names.length > 0) {
          const fields = [];
          for (const name of names) {
            const field = { name, label: name, kind: "text", param: true };
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
        const authFields = [
          f("auth", "enum", { options: AUTH.map((a) => ({ value: a, label: ctx.t(`auth.${a}`) })) }),
        ];
        if (auth === "basic") authFields.push(f("username", "text", { placeholder: ctx.t("field.username.placeholder") }));
        if (auth === "header" || auth === "query") authFields.push(f("authName", "text", { placeholder: ctx.t(auth === "header" ? "field.authName.header" : "field.authName.query") }));
        if (auth !== "none") authFields.push(f("secret", "secret", { hint: ctx.t(auth === "basic" ? "field.secret.hintBasic" : "field.secret.hint") }));
        view.push({ type: "form", id: "auth", layout: "strip", fields: authFields });
        view.push({ type: "form", id: "headers", layout: "stack", fields: [f("headers", "longtext", { placeholder: ctx.t("field.headers.placeholder") })] });
        view.push({ type: "text", id: "note", text: tr(ctx, "note.host"), tone: "muted" });
        return { view };
      },
    });

    host.actions.handle("test", async (ctx, input) => {
      const body = bodyOf(ctx, input);
      const started = Date.now();
      const res = await send(ctx, body, { method: "GET", path: body.testPath || "" });
      const ms = Date.now() - started;
      if (res.status >= 400) throw fail(ctx, "test.failed", { status: res.status });
      return { output: { type: "text", text: tr(ctx, "test.ok", { status: res.status, ms }) }, summary: { message: tr(ctx, "summary.test", { status: res.status, ms }) } };
    });

    // Called by other plugins on one connection (`ctx.resource`, chosen by the caller):
    // { method?, path?, query?: {name: value}, headers?: {name: value}, body?: string|object, inline?: boolean }
    // → the response body as text; with `inline: true` a JSON text { status, statusText, headers, body }.
    host.actions.handle("request", async (ctx, input) => {
      if (!ctx.resource) throw fail(ctx, "error.noConnection");
      const body = bodyOf(ctx, null);
      const res = await send(ctx, body, input);
      const text = String(res.body || "");
      if (input && input.inline === true) {
        const data = { status: res.status, statusText: res.statusText || "", headers: res.headers || {}, body: text, truncated: res.truncated === true };
        return { output: { type: "text", text: JSON.stringify(data) }, summary: { message: tr(ctx, "summary.request", { status: res.status }) } };
      }
      return { output: { type: "text", text }, summary: { message: tr(ctx, "summary.request", { status: res.status }) } };
    });
  },
};
