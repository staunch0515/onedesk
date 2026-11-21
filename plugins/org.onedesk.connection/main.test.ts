import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
// @ts-ignore plain JS module, no types
import plugin, { authParts, buildRequest, joinUrl, paramNames, fillParams } from "./main.js";
import { RENDER_KEYS, checkActionResult, checkView, onlyKeys, registry } from "../_testing/view-check";

const load = (f: string) => JSON.parse(readFileSync(new URL(`./locales/${f}.json`, import.meta.url), "utf8")) as Record<string, string>;
const EN = load("en-US");
const ZH = load("zh-CN");
const JA = load("ja-JP");
const t = (key: string) => ({ "en-US": EN[key], "zh-CN": ZH[key], "ja-JP": JA[key] });

type Host = Record<string, any>;
function fakeHost(over: Host = {}): Host {
  return {
    params: { get: vi.fn(async () => ({ found: false, value: "", sourceName: "" })) },
    network: { request: vi.fn(async () => ({ status: 200, statusText: "OK", headers: { "content-type": "text/plain" }, body: "hello", truncated: false })) },
    ...over,
  };
}
const SECRET = "keychain-name-1";
const conn = (body: Record<string, unknown>) => ({ id: "c1", body: { url: "https://api.example.com/v1", auth: "none", authName: "", headers: "", testPath: "", ...body } });
const ctxOf = (host: Host, resource: unknown, extra: Record<string, unknown> = {}) => ({ target: "resource:c1", locale: "en-US", host, t, params: {}, resource, ...extra });

describe("connection: request building", () => {
  it("none: no auth added", () => {
    const r = buildRequest(ctxOf({}, null), conn({}).body, { path: "/items" });
    expect(r).toEqual({ method: "GET", url: "https://api.example.com/v1/items" });
  });
  it("bearer: Authorization header with a secret reference, never a value", () => {
    const r = buildRequest(ctxOf({}, null), conn({ auth: "bearer", secret: { secret: SECRET } }).body, { path: "items" });
    expect(r.headers).toEqual({ Authorization: `Bearer {{secret:${SECRET}}}` });
  });
  it("basic: the host builds base64(user:secret); only the reference and the user name are in the request", () => {
    const body = conn({ auth: "basic", username: "aladdin", secret: { secret: SECRET } }).body;
    expect(authParts(body).header).toEqual(["Authorization", `Basic {{secret:${SECRET}|basic:aladdin}}`]);
    expect(buildRequest(ctxOf({}, null), body, {}).headers).toEqual({ Authorization: `Basic {{secret:${SECRET}|basic:aladdin}}` });
  });
  it("basic: a user name is required and cannot hold a colon", () => {
    const base = { auth: "basic", secret: { secret: SECRET } };
    expect(() => buildRequest(ctxOf({}, null), conn({ ...base }).body, {})).toThrow(EN["error.noUsername"]);
    expect(() => buildRequest(ctxOf({}, null), conn({ ...base, username: "a:b" }).body, {})).toThrow(EN["error.badUsername"]);
  });
  it("custom header: uses the given name and replaces a caller's header of the same name", () => {
    const body = conn({ auth: "header", authName: "X-Api-Key", secret: { secret: SECRET }, headers: "x-api-key: old\nAccept: a/b" }).body;
    const r = buildRequest(ctxOf({}, null), body, { path: "/x", headers: { "X-API-KEY": "evil", "X-Other": "1" } });
    expect(r.headers).toEqual({ Accept: "a/b", "X-Other": "1", "X-Api-Key": `{{secret:${SECRET}}}` });
  });
  it("query: appends name={{secret}} after the caller's own pairs, encoded", () => {
    const body = conn({ auth: "query", authName: "api_key", secret: { secret: SECRET } }).body;
    const r = buildRequest(ctxOf({}, null), body, { path: "/x", query: { q: "a b&c" } });
    expect(r.url).toBe(`https://api.example.com/v1/x?q=a%20b%26c&api_key={{secret:${SECRET}}}`);
  });
  it("an auth method that needs a secret refuses to run without one; a bad header name is refused", () => {
    expect(() => buildRequest(ctxOf({}, null), conn({ auth: "bearer" }).body, {})).toThrow(EN["error.noSecret"]);
    expect(() => buildRequest(ctxOf({}, null), conn({ auth: "header", authName: "bad name", secret: { secret: SECRET } }).body, {})).toThrow(EN["error.noAuthName"]);
    expect(() => buildRequest(ctxOf({}, null), conn({}).body, { headers: { "a b": "1" } })).toThrow();
  });
  it("body: strings as given, objects as JSON, not for GET", () => {
    const b = conn({}).body;
    expect(buildRequest(ctxOf({}, null), b, { method: "post", body: { a: 1 } }).body).toBe('{"a":1}');
    expect(buildRequest(ctxOf({}, null), b, { method: "POST", body: "raw" }).body).toBe("raw");
    expect(buildRequest(ctxOf({}, null), b, { method: "GET", body: "raw" }).body).toBeUndefined();
    expect(() => buildRequest(ctxOf({}, null), b, { method: "TRACE" })).toThrow(EN["error.method"]);
  });
  it("a path cannot leave the connection's host", () => {
    expect(joinUrl("https://a.example/v1/", "https://evil.example/x")).toBeNull();
    expect(joinUrl("https://a.example/v1", "//evil.example/x")).toBe("https://a.example/v1/evil.example/x");
    expect(joinUrl("https://a.example", "/@evil.example")).toBe("https://a.example/@evil.example");
    expect(joinUrl("https://a.example", "\\evil")).toBeNull();
    expect(joinUrl("https://a.example/v1", "")).toBe("https://a.example/v1");
    expect(() => buildRequest(ctxOf({}, null), conn({}).body, { path: "http://evil.example" })).toThrow(EN["error.badPath"]);
    expect(() => buildRequest(ctxOf({}, null), conn({ url: "ftp://x" }).body, {})).toThrow(EN["error.badUrl"]);
  });
  it("environment: :name in the address is filled from the values", () => {
    expect(paramNames("https://:env_host/v1")).toEqual(["env_host"]);
    expect(fillParams("https://:env_host/v1", { env_host: "test.example.com" })).toBe("https://test.example.com/v1");
  });
});

describe("connection: plugin", () => {
  it("registers what the manifest declares", () => {
    const r = registry(plugin);
    expect(Object.keys(r.pages)).toEqual(["editor"]);
    expect(Object.keys(r.actions).sort()).toEqual(["request", "test"]);
  });

  it("render: the secret field is a secret field and the saved resource never holds a value", async () => {
    const { pages } = registry(plugin);
    const out = await pages.editor.render(ctxOf(fakeHost(), conn({ auth: "bearer", secret: { secret: SECRET } })));
    expect(checkView(out.view)).toEqual([]);
    expect(onlyKeys(out, RENDER_KEYS)).toEqual([]);
    const auth = out.view.find((n: any) => n.id === "auth");
    expect(auth.fields.map((f: any) => f.name)).toEqual(["auth", "secret"]);
    expect(auth.fields[1]).toMatchObject({ kind: "secret", bind: "body.secret" });
    expect(JSON.stringify(out)).not.toContain("hunter2");
  });

  it("render: header/query show a name field; none shows only the method", async () => {
    const { pages } = registry(plugin);
    const names = async (auth: string) => (await pages.editor.render(ctxOf(fakeHost(), conn({ auth })))).view.find((n: any) => n.id === "auth").fields.map((f: any) => f.name);
    expect(await names("none")).toEqual(["auth"]);
    expect(await names("header")).toEqual(["auth", "authName", "secret"]);
    expect(await names("query")).toEqual(["auth", "authName", "secret"]);
    expect(await names("basic")).toEqual(["auth", "username", "secret"]);
  });

  it("render: an environment parameter in the address gets a strip with the environment value", async () => {
    const { pages } = registry(plugin);
    const host = fakeHost({ params: { get: vi.fn(async () => ({ found: true, value: "test.example.com", sourceName: "Test" })) } });
    const out = await pages.editor.render(ctxOf(host, conn({ url: "https://:env_host/v1" })));
    const strip = out.view.find((n: any) => n.id === "params");
    expect(strip.fields[0]).toMatchObject({ name: "env_host", param: true, envValue: "test.example.com", envSource: "Test" });
  });

  it("request: sends through the network host interface and returns the body", async () => {
    const { actions } = registry(plugin);
    const host = fakeHost();
    const res = await actions.request(ctxOf(host, conn({ auth: "bearer", secret: { secret: SECRET } })), { path: "/items", query: { a: "1" } });
    expect(checkActionResult(res)).toEqual([]);
    expect(res.output).toEqual({ type: "text", text: "hello" });
    expect(host.network.request).toHaveBeenCalledWith({ method: "GET", url: "https://api.example.com/v1/items?a=1", headers: { Authorization: `Bearer {{secret:${SECRET}}}` } });
  });

  it("request: inline gives status, headers and body as JSON; the secret value is not in the result", async () => {
    const { actions } = registry(plugin);
    const res = await actions.request(ctxOf(fakeHost(), conn({ auth: "bearer", secret: { secret: SECRET } })), { inline: true });
    expect(JSON.parse(res.output.text)).toMatchObject({ status: 200, body: "hello" });
    expect(res.output.text).not.toContain("{{secret");
  });

  it("request: without a connection fails; a network error carries its code", async () => {
    const { actions } = registry(plugin);
    await expect(actions.request(ctxOf(fakeHost(), undefined), {})).rejects.toThrow(EN["error.noConnection"]);
    const host = fakeHost({ network: { request: async () => { throw Object.assign(new Error("x"), { code: "denied", params: { reason: "notAllowed" } }); } } });
    await expect(actions.request(ctxOf(host, conn({})), {})).rejects.toMatchObject({ code: "denied", message: expect.stringContaining("denied/notAllowed") });
  });

  it("test: success shows the status; an error status fails in the result area", async () => {
    const { actions } = registry(plugin);
    const host = fakeHost();
    const ok = await actions.test(ctxOf(host, conn({ testPath: "/health" })), {});
    expect(checkActionResult(ok)).toEqual([]);
    expect(ok.output.text).toContain("200");
    expect(host.network.request.mock.calls[0][0].url).toBe("https://api.example.com/v1/health");
    const bad = fakeHost({ network: { request: async () => ({ status: 401, headers: {}, body: "" }) } });
    await expect(actions.test(ctxOf(bad, conn({})), {})).rejects.toThrow("401");
  });

  it("test: uses unsaved values from the page input", async () => {
    const { actions } = registry(plugin);
    const host = fakeHost();
    await actions.test(ctxOf(host, conn({})), { "body.url": "https://other.example.com" });
    expect(host.network.request.mock.calls[0][0].url).toBe("https://other.example.com");
  });
});

describe("connection: locales and manifest", () => {
  const manifest = JSON.parse(readFileSync(new URL("./manifest.json", import.meta.url), "utf8"));
  it("en, zh and ja have the same keys, and every key the code uses exists", () => {
    expect(Object.keys(ZH).sort()).toEqual(Object.keys(EN).sort());
    expect(Object.keys(JA).sort()).toEqual(Object.keys(EN).sort());
    const src = readFileSync(new URL("./main.js", import.meta.url), "utf8");
    for (const m of src.matchAll(/(?:tr\(ctx, |ctx\.t\(|fail\(ctx, )"([a-zA-Z.]+)"/g)) expect(EN[m[1]!], m[1]).toBeDefined();
  });
  it("the address grants the network, the secret is a secret field, the plaintext flag is off", () => {
    const k = manifest.contributes.kinds[0];
    expect(k.fields.url).toEqual({ type: "text", grants: "network" });
    expect(k.fields.secret.type).toBe("secret");
    expect(k.defaults.secret).toBeUndefined();
    expect(manifest.requires.secrets.plaintext).toBe(false);
    expect(manifest.exports.actions).toContain("request");
  });
});
