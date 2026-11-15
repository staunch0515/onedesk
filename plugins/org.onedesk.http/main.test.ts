import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
// @ts-ignore plain JS module, no types
import plugin, { byteLength, fillParams, paramKind, paramNames, parseHeaders } from "./main.js";
import { RENDER_KEYS, checkActionResult, checkView, hostError, onlyKeys, registry } from "../_testing/view-check";

const load = (f: string) => JSON.parse(readFileSync(new URL(`./locales/${f}.json`, import.meta.url), "utf8")) as Record<string, string>;
const EN = load("en-US");
const ZH = load("zh-CN");
const t = (key: string) => ({ "en-US": EN[key], "zh-CN": ZH[key] });

type Host = Record<string, any>;
function fakeHost(over: Host = {}): Host {
  const store = new Map<string, string>();
  return {
    params: { get: vi.fn(async () => ({ found: false, value: "", sourceName: "" })) },
    storage: { get: vi.fn(async (k: string) => store.get(k) ?? null), set: vi.fn(async (k: string, v: string) => void store.set(k, v)) },
    network: { request: vi.fn(async () => ({ status: 200, headers: { "content-type": "text/plain" }, body: "hello", truncated: false })) },
    ...over,
  };
}
const ctxOf = (host: Host, extra: Record<string, unknown> = {}) => ({ target: "resource:r1", locale: "en-US", host, t, params: {}, progress: vi.fn(), cancelled: () => false, ...extra });
const resourceOf = (body: Record<string, string>) => ({ resource: { id: "r1", body } });

describe("http: helpers", () => {
  it("finds :name parameters in url, headers and body, but not the colons of URLs, ports, JSON or secrets", () => {
    expect(paramNames("https://example.com:8080/items/:item_id?q=:term", "Authorization: Bearer :token\nX-Key: {{secret:api_key}}", '{"a":true,"b": :b}')).toEqual(["item_id", "term", "token", "b"]);
    expect(paramNames("http://localhost/x")).toEqual([]);
    expect(paramNames("", undefined)).toEqual([]);
  });
  it("fills known parameters and leaves the rest and the secrets alone", () => {
    expect(fillParams("/a/:id/{{secret:k}}/:other", { id: "7" })).toBe("/a/7/{{secret:k}}/:other");
  });
  it("guesses parameter types by name", () => {
    expect([paramKind("item_id"), paramKind("limit"), paramKind("since_time"), paramKind("day_date"), paramKind("q")]).toEqual(["number", "number", "datetime", "date", "text"]);
  });
  it("parses headers one per line and keeps {{secret:…}} as written", () => {
    expect(parseHeaders("Accept: application/json\n\n# comment\nAuthorization: Bearer {{secret:token}}\nbad line\nX-Url: http://a:1")).toEqual({
      Accept: "application/json",
      Authorization: "Bearer {{secret:token}}",
      "X-Url": "http://a:1",
    });
  });
  it("counts UTF-8 bytes", () => {
    expect(byteLength("abc")).toBe(3);
    expect(byteLength("é")).toBe(2);
    expect(byteLength("周")).toBe(3);
    expect(byteLength("😀")).toBe(4);
  });
});

describe("http: page", () => {
  it("registers what the manifest declares", () => {
    const r = registry(plugin);
    expect(Object.keys(r.pages)).toEqual(["editor"]);
    expect(Object.keys(r.actions)).toEqual(["send"]);
  });

  it("render: method enum + address, headers, and a full-height body; no strip without parameters", async () => {
    const { pages } = registry(plugin);
    const out = await pages.editor.render(ctxOf(fakeHost(), resourceOf({ method: "POST", url: "https://example.com/x", headers: "", body: "" })));
    expect(checkView(out.view)).toEqual([]);
    expect(onlyKeys(out, RENDER_KEYS)).toEqual([]);
    expect(out.view.map((n: any) => n.id)).toEqual(["line", "auth", "headers", "payload"]);
    expect(out.view[1].fields[0]).toMatchObject({ kind: "secret", bind: "body.token" });
    const [method, url] = out.view[0].fields;
    expect(method).toMatchObject({ kind: "enum", bind: "body.method" });
    expect(method.options.map((o: any) => o.value)).toEqual(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
    expect(url).toMatchObject({ kind: "text", bind: "body.url" });
    expect(out.view[2].fields[0]).toMatchObject({ kind: "longtext", bind: "body.headers" });
    expect(out.view[3].fields[0]).toMatchObject({ kind: "longtext", bind: "body.body", fill: true });
  });

  it("render: parameter strip from all three fields (and the unsaved draft), with environment values", async () => {
    const { pages } = registry(plugin);
    const host = fakeHost({
      params: { get: vi.fn(async (n: string) => (n === "token" ? { found: true, value: "abc", sourceName: "Prod" } : { found: false, value: "", sourceName: "" })) },
    });
    const out = await pages.editor.render(
      ctxOf(host, { ...resourceOf({ method: "GET", url: "https://e.com/:item_id", headers: "", body: "" }), draft: { "body.headers": "Authorization: Bearer :token" } }),
    );
    expect(checkView(out.view)).toEqual([]);
    const strip = out.view.find((n: any) => n.id === "params");
    expect(strip.fields).toEqual([
      { name: "item_id", label: "item_id", kind: "number", param: true },
      { name: "token", label: "token", kind: "text", param: true, envValue: "abc", envSource: "Prod" },
    ]);
  });

  it("render: a run page is read only", async () => {
    const { pages } = registry(plugin);
    const run = { id: "x", resourceId: "r1", input: { "body.method": "GET", "body.url": "http://a/:id", "body.headers": "", "body.body": "" }, params: { id: "3" } };
    const out = await pages.editor.render(ctxOf(fakeHost(), { run }));
    expect(checkView(out.view)).toEqual([]);
    for (const n of out.view) for (const f of n.fields) expect(f.readOnly).toBe(true);
    expect(out.view.find((n: any) => n.id === "params").fields[0]).toMatchObject({ envValue: "3", readOnly: true });
  });

  it("renderResultTab headers: a table of the stored response headers, sorted; a muted note without any", async () => {
    const { pages } = registry(plugin);
    const host = fakeHost();
    await host.storage.set("lastHeaders:r1", JSON.stringify({ "x-b": "2", "content-type": "text/plain" }));
    const view = await pages.editor.renderResultTab(ctxOf(host, { run: { id: "r", resourceId: "r1" } }), "headers");
    expect(checkView(view)).toEqual([]);
    expect(view[0]).toMatchObject({ type: "table", rows: [["content-type", "text/plain"], ["x-b", "2"]] });
    const none = await pages.editor.renderResultTab(ctxOf(fakeHost(), { run: { id: "r", resourceId: "zzz" } }), "headers");
    expect(none).toEqual([{ type: "text", id: "none", text: "No response yet", tone: "muted" }]);
    await expect(pages.editor.renderResultTab(ctxOf(fakeHost(), {}), "nope")).rejects.toThrow();
  });
});

describe("http: send action", () => {
  const send = (host: Host, input: Record<string, string>, extra: Record<string, unknown> = {}) => registry(plugin).actions.send(ctxOf(host, { ...resourceOf({}), ...extra }), input);

  it("sends the request with parameters filled in; text output is the response body; summary has status, time and bytes", async () => {
    const host = fakeHost();
    const res = await send(
      host,
      { "body.method": "post", "body.url": "https://e.com/items/:item_id", "body.headers": "Accept: text/plain\nAuthorization: Bearer {{secret:tok}}", "body.body": '{"id": :item_id}' },
      { params: { item_id: "42" } },
    );
    expect(host.network.request).toHaveBeenCalledWith({
      method: "POST",
      url: "https://e.com/items/42",
      headers: { Accept: "text/plain", Authorization: "Bearer {{secret:tok}}" },
      body: '{"id": 42}',
    });
    expect(checkActionResult(res)).toEqual([]);
    expect(res.output).toEqual({ type: "text", text: "hello" });
    expect(res.summary.message).toMatch(/^200 · \d+ ms · 5 bytes$/);
    expect(JSON.parse(host.storage.set.mock.calls[0]![1])).toEqual({ "content-type": "text/plain" });
    expect(host.storage.set.mock.calls[0]![0]).toBe("lastHeaders:r1");
  });

  it("falls back to the environment value for a parameter that was not typed", async () => {
    const host = fakeHost({ params: { get: vi.fn(async () => ({ found: true, value: "env-9", sourceName: "Prod" })) } });
    await send(host, { "body.method": "GET", "body.url": "https://e.com/:k", "body.headers": "", "body.body": "" });
    expect(host.network.request.mock.calls[0]![0].url).toBe("https://e.com/env-9");
  });

  it("GET and HEAD send no body; empty headers are left out", async () => {
    const host = fakeHost();
    await send(host, { "body.method": "GET", "body.url": "https://e.com", "body.headers": "", "body.body": "ignored" });
    expect(host.network.request.mock.calls[0]![0]).toEqual({ method: "GET", url: "https://e.com" });
  });

  it("a non-2xx response is still a successful run, with the status in the summary", async () => {
    const host = fakeHost({ network: { request: vi.fn(async () => ({ status: 404, headers: {}, body: "nope", truncated: false })) } });
    const res = await send(host, { "body.method": "GET", "body.url": "https://e.com/missing", "body.headers": "", "body.body": "" });
    expect(res.output.text).toBe("nope");
    expect(res.summary.message).toMatch(/^404 /);
  });

  it("marks a truncated body in the summary", async () => {
    const host = fakeHost({ network: { request: vi.fn(async () => ({ status: 200, headers: {}, body: "x", truncated: true })) } });
    const res = await send(host, { "body.method": "GET", "body.url": "https://e.com", "body.headers": "", "body.body": "" });
    expect(res.summary.message).toMatch(/truncated$/);
  });

  it.each([
    ["denied", { reason: "hostNotAllowed" }, /denied\/hostNotAllowed/],
    ["internal", { reason: "connect" }, /internal\/connect/],
    ["invalid", {}, /invalid\)/],
  ])("a %s host error fails the run with its code and reason", async (code, params, re) => {
    const host = fakeHost({ network: { request: vi.fn(async () => { throw hostError(code, params as Record<string, string>); }) } });
    const p = send(host, { "body.method": "GET", "body.url": "https://e.com", "body.headers": "", "body.body": "" });
    await expect(p).rejects.toThrow(re);
    await expect(p).rejects.toMatchObject({ code });
    expect(host.storage.set).not.toHaveBeenCalled();
  });

  it("an empty address fails before any request", async () => {
    const host = fakeHost();
    await expect(send(host, { "body.method": "GET", "body.url": "  ", "body.headers": "", "body.body": "" })).rejects.toThrow("The address is empty.");
    expect(host.network.request).not.toHaveBeenCalled();
  });

  it("never reads or rewrites {{secret:…}}: the header text reaches the host exactly as written", async () => {
    const host = fakeHost();
    await send(host, { "body.method": "GET", "body.url": "https://e.com/?k={{secret:q}}", "body.headers": "X: {{secret:a_b}}", "body.body": "" });
    const req = host.network.request.mock.calls[0]![0];
    expect(req.url).toBe("https://e.com/?k={{secret:q}}");
    expect(req.headers).toEqual({ X: "{{secret:a_b}}" });
    expect(host.secrets).toBeUndefined();
  });
});

describe("http: the token field", () => {
  it("{{token}} becomes {{secret:<saved name>}} when the resource has a token reference; otherwise it is left alone", async () => {
    const host = fakeHost();
    await registry(plugin).actions.send(ctxOf(host, { resource: { id: "r1", body: { token: { secret: "r1.token" } } } }), { "body.method": "GET", "body.url": "https://e.com", "body.headers": "Authorization: Bearer {{token}}", "body.body": "" });
    expect(host.network.request.mock.calls[0]![0].headers).toEqual({ Authorization: "Bearer {{secret:r1.token}}" });
    const h2 = fakeHost();
    await registry(plugin).actions.send(ctxOf(h2, resourceOf({})), { "body.method": "GET", "body.url": "https://e.com", "body.headers": "A: {{token}}", "body.body": "" });
    expect(h2.network.request.mock.calls[0]![0].headers).toEqual({ A: "{{token}}" });
  });
});

describe("http: package", () => {
  it("every text key the code and manifest use exists in both locale files with the same key set", () => {
    const code = readFileSync(new URL("./main.js", import.meta.url), "utf8");
    const used = [...code.matchAll(/(?:ctx\.t|tr)\((?:ctx, )?"([^"]+)"/g)].map((m) => m[1]!);
    const manifest = readFileSync(new URL("./manifest.json", import.meta.url), "utf8");
    const mkeys = [...manifest.matchAll(/"((?:plugin|kind|action|tab)\.[A-Za-z.]+)"/g)].map((m) => m[1]!);
    for (const k of [...used, ...mkeys]) {
      expect(EN[k], `en-US ${k}`).toBeTypeOf("string");
      expect(ZH[k], `zh-CN ${k}`).toBeTypeOf("string");
    }
    expect(Object.keys(EN).sort()).toEqual(Object.keys(ZH).sort());
  });

  it("the manifest declares the address field as a network grant and requires network from resources", () => {
    const m = JSON.parse(readFileSync(new URL("./manifest.json", import.meta.url), "utf8"));
    expect(m.requires.network).toEqual({ fromResources: true });
    expect(m.contributes.kinds[0].fields.url).toEqual({ type: "text", grants: "network" });
    expect(m.contributes.kinds[0].fields.token).toEqual({ type: "secret" });
    expect(m.requires.secrets).toEqual({ names: ["api-token"], plaintext: false });
  });
});
