import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
// @ts-ignore plain JS module, no types
import plugin, { checkBase, buildChat, mapHttpError, mapStop, sseParser, supportsFallback } from "./main.js";
import { checkActionResult, checkView, registry } from "../_testing/view-check";
import { startFakeAi, type FakeAi } from "../_testing/fake-ai/server";

const load = (f: string) => JSON.parse(readFileSync(new URL(`./locales/${f}.json`, import.meta.url), "utf8")) as Record<string, string>;
const EN = load("en-US");
const t = (key: string) => ({ "en-US": EN[key] });
const SECRET = "keychain-name-1";

/** A fake host whose network.request really talks to the fake server (and fills the secret like the host does: it just drops it). */
function hostFor(_fake: FakeAi, cancelAt?: number) {
  const partials: any[] = [];
  const calls: any[] = [];
  const host = {
    runs: { partial: vi.fn(async (o: unknown) => void partials.push(o)) },
    network: {
      request: vi.fn(async (opts: any) => {
        calls.push(opts);
        const ac = new AbortController();
        const res = await fetch(opts.url, { method: opts.method, headers: Object.fromEntries(Object.entries(opts.headers || {}).map(([k, v]) => [k, String(v).replace(/\{\{secret:[^}]*\}\}/g, "REDACTED")])), body: opts.body, signal: ac.signal });
        const headers = Object.fromEntries(res.headers.entries());
        if (!opts.stream) return { status: res.status, headers, text: await res.text() };
        const dec = new TextDecoder();
        let n = 0;
        let head = "";
        try {
          for await (const c of res.body as any) {
            const s = dec.decode(c, { stream: true });
            if (head.length < 8192) head += s;
            opts.onChunk(s);
            if (cancelAt !== undefined && ++n >= cancelAt) {
              ac.abort();
              throw Object.assign(new Error("denied"), { code: "denied", params: { reason: "cancelled" } });
            }
          }
        } catch (e: any) {
          if (e && e.code) throw e;
          throw Object.assign(new Error("invalid"), { code: "invalid", params: { reason: "network" } });
        }
        return { status: res.status, headers, text: res.status >= 300 ? head : "", bytes: head.length, streamed: true };
      }),
    },
  };
  return { host, partials, calls };
}
const conn = (fake: FakeAi, body: Record<string, unknown> = {}) => ({ id: "c1", body: { baseUrl: fake.url, model: "claude-haiku-5-5", effort: "medium", maxTokens: "16000", fallback: "true", secret: { secret: SECRET }, ...body } });
const ctxOf = (host: unknown, resource: unknown) => ({ target: "resource:c1", locale: "en-US", host, t, params: {}, resource });
const result = (r: any) => r.data;
// the shell's validator knows no `data` yet (D441): check the rest of the result
const plain = (r: any) => ({ output: (({ format: _f, ...o }) => o)(r.output), ...(r.summary ? { summary: r.summary } : {}) });

let fake: FakeAi;
beforeAll(async () => void (fake = await startFakeAi()));
afterAll(() => fake.close());
const reset = () => (fake.requests.length = 0, fake.set({ kind: "ok" }));
const actions = () => registry(plugin as any).actions;

describe("anthropic: request building", () => {
  it("Haiku: stream, effort in output_config, no thinking, no sampling, no fallback", () => {
    const { request, fallback } = buildChat(conn(fake).body, { system: "s", messages: [{ role: "user", text: "hi" }] });
    expect(request).toEqual({ model: "claude-haiku-5-5", max_tokens: 16000, stream: true, messages: [{ role: "user", content: "hi" }], system: "s", output_config: { effort: "medium" } });
    expect(fallback).toBe(false);
    for (const k of ["thinking", "temperature", "top_p", "top_k", "fallbacks"]) expect(request).not.toHaveProperty(k);
  });
  it("Sonnet/Opus get fallbacks:'default' unless switched off", () => {
    expect(supportsFallback("claude-sonnet-5-5")).toBe(true);
    expect(supportsFallback("claude-opus-5-5")).toBe(true);
    expect(supportsFallback("claude-haiku-5-5")).toBe(false);
    expect(buildChat(conn(fake, { model: "claude-opus-5-5" }).body, {}).request.fallbacks).toBe("default");
    expect(buildChat(conn(fake, { model: "claude-opus-5-5", fallback: "false" }).body, {}).fallback).toBe(false);
  });
  it("maxTokens: input over the connection over the default; capped at 32000; effort from input", () => {
    expect(buildChat(conn(fake, { maxTokens: "" }).body, {}).request.max_tokens).toBe(16000);
    expect(buildChat(conn(fake).body, { maxTokens: 999999, effort: "high" }).request).toMatchObject({ max_tokens: 32000, output_config: { effort: "high" } });
  });
  it("format json adds an instruction to the system text", () => {
    expect(buildChat(conn(fake).body, { format: "json" }).request.system).toMatch(/JSON/);
  });
});

describe("anthropic: SSE parsing", () => {
  it("handles events split anywhere, CRLF, comments and multi-line data", () => {
    const got: any[] = [];
    const p = sseParser((e: any) => got.push(e));
    const raw = ": ping\r\n\r\nevent: a\r\ndata: 1\r\n\r\nevent: b\ndata: x\ndata: y\n\n";
    for (const ch of raw) p.feed(ch);
    expect(got).toEqual([{ event: "a", data: "1" }, { event: "b", data: "x\ny" }]);
  });
});

describe("anthropic: errors and stops", () => {
  it("maps statuses", () => {
    expect(mapHttpError(401, "{}", {}).code).toBe("auth");
    expect(mapHttpError(429, "{}", { "Retry-After": "7" })).toMatchObject({ code: "rateLimit", retryAfter: 7 });
    expect(mapHttpError(529, "{}", {}).code).toBe("overloaded");
    expect(mapHttpError(400, JSON.stringify({ error: { type: "invalid_request_error", message: "prompt is too long: 300000 tokens" } }), {}).code).toBe("tooLong");
    expect(mapHttpError(400, JSON.stringify({ error: { message: "bad field" } }), {}).code).toBe("other");
  });
  it("maps stop reasons", () => {
    expect([mapStop("end_turn"), mapStop("max_tokens"), mapStop("refusal"), mapStop("tool_use")]).toEqual(["end", "maxTokens", "refusal", "other"]);
  });
});

describe("anthropic: chat against the fake server", () => {
  it("streams: partial is the full text so far; the result has text, model, usage, stop; headers carry the placeholder only", async () => {
    reset();
    fake.set({ kind: "ok", pieces: ["A", "B", "C"], inputTokens: 21, outputTokens: 3 });
    const { host, partials, calls } = hostFor(fake);
    const res = await actions().chat(ctxOf(host, conn(fake)), { messages: [{ role: "user", text: "hi" }] });
    expect(checkActionResult(plain(res))).toEqual([]);
    expect(result(res)).toEqual({ text: "ABC", model: "claude-haiku-5-5", usage: { input: 21, output: 3 }, stop: "end" });
    const texts = partials.map((p) => p.text);
    expect(texts.at(-1)).toBe("ABC");
    for (let i = 1; i < texts.length; i++) expect(texts[i].startsWith(texts[i - 1])).toBe(true);
    expect(partials.every((p) => p.type === "text" && p.format === "markdown")).toBe(true);
    expect(calls[0]).toMatchObject({ method: "POST", stream: true, timeoutMs: 600000, url: `${fake.url}/v1/messages` });
    expect(calls[0].headers).toMatchObject({ "x-api-key": `{{secret:${SECRET}}}`, "anthropic-version": "2026-10-21" });
    expect(calls[0].headers).not.toHaveProperty("anthropic-beta");
    expect(JSON.stringify(calls[0])).not.toMatch(/sk-/);
    expect(fake.requests[0]!.body.stream).toBe(true);
  });
  it("Sonnet sends the fallback beta header and fallbacks", async () => {
    reset();
    const { host } = hostFor(fake);
    await actions().chat(ctxOf(host, conn(fake, { model: "claude-sonnet-5-5" })), { messages: [{ role: "user", text: "hi" }] });
    expect(fake.requests[0]!.headers["anthropic-beta"]).toBe("server-side-fallback-2026-07-01");
    expect(fake.requests[0]!.body.fallbacks).toBe("default");
  });
  it("refusal → stop:refusal", async () => {
    reset();
    fake.set({ kind: "refusal", pieces: ["no"] });
    const res = await actions().chat(ctxOf(hostFor(fake).host, conn(fake)), { messages: [] });
    expect(result(res).stop).toBe("refusal");
  });
  it.each([
    [401, {}, "auth", undefined],
    [429, { "retry-after": "9" }, "rateLimit", 9],
    [529, {}, "overloaded", undefined],
  ])("HTTP %i → %s", async (status, headers, code, retryAfter) => {
    reset();
    fake.set({ kind: "error", status, headers: headers as Record<string, string> });
    const r = result(await actions().chat(ctxOf(hostFor(fake).host, conn(fake)), { messages: [] }));
    expect(r.error.code).toBe(code);
    expect(r.error.retryAfter).toBe(retryAfter);
  });
  it("400 prompt too long → tooLong", async () => {
    reset();
    fake.set({ kind: "error", status: 400, body: { type: "error", error: { type: "invalid_request_error", message: "prompt is too long: 250000 tokens > 200000 maximum" } } });
    expect(result(await actions().chat(ctxOf(hostFor(fake).host, conn(fake)), { messages: [] })).error.code).toBe("tooLong");
  });
  it("an error event in a 200 stream is an error", async () => {
    reset();
    fake.set({ kind: "streamError", pieces: ["x"], type: "overloaded_error", message: "Overloaded" });
    expect(result(await actions().chat(ctxOf(hostFor(fake).host, conn(fake)), { messages: [] })).error.code).toBe("overloaded");
  });
  it("a dropped connection is a network error; a cancelled run rethrows", async () => {
    reset();
    fake.set({ kind: "drop", pieces: ["a", "b", "c", "d"] });
    expect(result(await actions().chat(ctxOf(hostFor(fake).host, conn(fake)), { messages: [] })).error.code).toBe("network");
    reset();
    fake.set({ kind: "slow", pieces: ["a", "b", "c"], delayMs: 20 });
    await expect(actions().chat(ctxOf(hostFor(fake, 1).host, conn(fake)), { messages: [] })).rejects.toMatchObject({ code: "denied", params: { reason: "cancelled" } });
  });
  it("no key / bad address are refused before any request", async () => {
    reset();
    const { host } = hostFor(fake);
    expect(result(await actions().chat(ctxOf(host, conn(fake, { secret: undefined })), { messages: [] })).error.code).toBe("auth");
    expect(result(await actions().chat(ctxOf(host, conn(fake, { baseUrl: "ftp://x" })), { messages: [] })).error.code).toBe("other");
    expect(host.network.request).not.toHaveBeenCalled();
  });
});

describe("anthropic: models and test", () => {
  it("models lists the ids; test says how many", async () => {
    reset();
    fake.setModels(["claude-haiku-5-5", "claude-opus-5-5"]);
    const { host } = hostFor(fake);
    expect(result(await actions().models(ctxOf(host, conn(fake)), {})).models.map((m: any) => m.id)).toEqual(["claude-haiku-5-5", "claude-opus-5-5"]);
    const res = await actions().test(ctxOf(host, conn(fake)), {});
    expect(checkActionResult(plain(res))).toEqual([]);
    expect(res.output.text).toBe("Connected: 2 models available");
    expect(fake.requests.at(-1)!.path).toBe("/v1/models");
  });
  it("test with a rejected key throws a readable error", async () => {
    reset();
    fake.set({ kind: "error", status: 401 });
    await expect(actions().test(ctxOf(hostFor(fake).host, conn(fake)), {})).rejects.toThrow(/API key was not accepted/);
  });
});


describe("anthropic: return shape (D441)", () => {
  it("readable text in output, the structured result in data; an error is readable too", async () => {
    reset();
    fake.set({ kind: "ok", pieces: ["Hi", "!"] });
    const res = await actions().chat(ctxOf(hostFor(fake).host, conn(fake)), { messages: [] });
    expect(res.output).toEqual({ type: "text", text: "Hi!", format: "markdown" });
    expect(res.data).toMatchObject({ text: "Hi!", stop: "end" });
    fake.set({ kind: "error", status: 401 });
    const bad = await actions().chat(ctxOf(hostFor(fake).host, conn(fake)), { messages: [] });
    expect(bad.data.error.code).toBe("auth");
    expect(bad.output.text).toMatch(/not accepted/);
    const list = await actions().models(ctxOf(hostFor(fake).host, conn(fake)), {});
    expect(list.output.type).toBe("text");
    expect(list.output).not.toHaveProperty("format");
    expect(bad.output).not.toHaveProperty("format");
    expect(Array.isArray(list.data.models) || list.data.error).toBeTruthy();
  });
});

describe("anthropic: address rules", () => {
  it("remote http, user info and odd hosts are refused; https and this machine are fine", () => {
    expect(checkBase("https://api.example.com/", "x")).toEqual({ base: "https://api.example.com", host: "api.example.com" });
    expect(checkBase("http://127.0.0.1:11434", "x")).toEqual({ base: "http://127.0.0.1:11434", host: "127.0.0.1:11434" });
    expect(checkBase("http://localhost:8080", "x").error).toBeUndefined();
    expect(checkBase("http://[::1]:9", "x").host).toBe("[::1]:9");
    expect(checkBase("", "https://d.example").host).toBe("d.example");
    expect(checkBase("http://api.example.com", "x").error).toBe("insecure");
    expect(checkBase("http://127.0.0.1.evil.example", "x").error).toBe("insecure");
    expect(checkBase("https://api.anthropic.com@evil.com", "x").error).toBe("userInfo");
    expect(checkBase("http://user:pw@127.0.0.1", "x").error).toBe("userInfo");
    expect(checkBase("https://evil.com\\@api.anthropic.com", "x").error).toBe("badUrl");
    expect(checkBase("ftp://x", "x").error).toBe("badUrl");
    expect(checkBase("https://a b.example", "x").error).toBe("badUrl");
    expect(checkBase("https://", "x").error).toBe("badUrl");
  });
  it("chat and test refuse such an address before any request; the page note shows the real host or the reason", async () => {
    const host = hostFor(fake).host;
    for (const u of ["http://api.example.com", "https://api.example.com@evil.example"]) {
      expect(result(await actions().chat(ctxOf(host, conn(fake, { baseUrl: u })), { messages: [], })).error.code).toBe("other");
      await expect(actions().test(ctxOf(host, conn(fake, { baseUrl: u })), {})).rejects.toThrow();
    }
    expect(host.network.request).not.toHaveBeenCalled();
    const page = registry(plugin as any).pages.editor;
    const note = (u: string) => page.render(ctxOf({}, { id: "c1", body: { baseUrl: u, model: "m", secret: undefined } })).then((r: any) => r.view.find((n: any) => n.id === "note"));
    expect(await note("https://api.example.com:8443/v1")).toMatchObject({ text: expect.stringContaining("api.example.com:8443"), tone: "muted" });
    expect(await note("https://api.example.com@evil.example")).toMatchObject({ tone: "danger" });
    expect(await note("http://api.example.com")).toMatchObject({ tone: "danger" });
  });
});

describe("anthropic: page and manifest", () => {
  it("the editor page is a valid view", async () => {
    const res = await registry(plugin as any).pages.editor.render({ ...ctxOf({}, conn(fake)) });
    expect(checkView(res.view)).toEqual([]);
  });
  it("the manifest implements the chat interface with exported actions", () => {
    const m = JSON.parse(readFileSync(new URL("./manifest.json", import.meta.url), "utf8"));
    expect(m.implements["onedesk.ai.chat/1"]).toEqual({ actions: ["chat", "models", "test"], kind: "connection" });
    for (const a of m.implements["onedesk.ai.chat/1"].actions) expect(m.exports.actions).toContain(a);
    expect(m.requires.network).toEqual({ fromResources: true });
    expect(m.contributes.kinds[0].defaults).toMatchObject({ baseUrl: "https://api.anthropic.com", model: "claude-haiku-5-5", effort: "medium", maxTokens: "16000" });
  });
});

describe("connection settings are a template (D466)", () => {
  it("text settings take {{name}} from the environment; the address and the secret stay as written", async () => {
    // @ts-ignore plain JS module, no types
    const { liveBody } = await import("./main.js");
    const params = { get: async (n: string) => (n === "m" ? { found: true, value: "big-model", sourceName: "Prod" } : n === "h" ? { found: true, value: "evil.example", sourceName: "Prod" } : { found: false }) };
    const ctx = { host: { params }, params: {}, resource: { id: "c1", body: { baseUrl: "https://{{h}}", model: "{{m}}", secret: { secret: "k" } } } };
    const b = await liveBody(ctx);
    expect(b.model).toBe("big-model");
    expect(b.baseUrl).toBe("https://{{h}}");
    expect(b.secret).toEqual({ secret: "k" });
  });
});
