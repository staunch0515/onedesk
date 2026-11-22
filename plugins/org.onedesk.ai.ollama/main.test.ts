import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
// @ts-ignore plain JS module, no types
import plugin, { checkBase, buildChat, mapHttpError, mapStop, ndjsonParser } from "./main.js";
import { checkActionResult, checkView, registry } from "../_testing/view-check";
import { startFakeAi, type FakeAi } from "../_testing/fake-ai/server";

const load = (f: string) => JSON.parse(readFileSync(new URL(`./locales/${f}.json`, import.meta.url), "utf8")) as Record<string, string>;
const EN = load("en-US");
const t = (key: string) => ({ "en-US": EN[key] });
const SECRET = "keychain-name-1";

/** network.request really talks to the fake server; the secret placeholder is dropped like the host's fill-in would. */
function hostFor(cancelAt?: number) {
  const partials: any[] = [];
  const calls: any[] = [];
  const progress: string[] = [];
  const host = {
    runs: { partial: vi.fn(async (o: unknown) => void partials.push(o)) },
    network: {
      request: vi.fn(async (opts: any) => {
        calls.push(opts);
        const ac = new AbortController();
        const headers = Object.fromEntries(Object.entries(opts.headers || {}).map(([k, v]) => [k, String(v).replace(/\{\{secret:[^}]*\}\}/g, "REDACTED")]));
        const res = await fetch(opts.url, { method: opts.method, headers, body: opts.body, signal: ac.signal });
        const rh = Object.fromEntries(res.headers.entries());
        if (!opts.stream) return { status: res.status, headers: rh, text: await res.text() };
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
        return { status: res.status, headers: rh, text: res.status >= 300 ? head : "", bytes: head.length, streamed: true };
      }),
    },
  };
  return { host, partials, calls, progress };
}
let fake: FakeAi;
const conn = (body: Record<string, unknown> = {}) => ({ id: "c1", body: { baseUrl: fake.url, model: "llama3.1", numCtx: "", keepAlive: "5m", authHeader: "Authorization", ...body } });
const ctxOf = (host: unknown, resource: unknown, progress?: string[]) => ({ target: "resource:c1", locale: "en-US", host, t, params: {}, resource, progress: (_f: unknown, m: string) => progress?.push(m) });
const result = (r: any) => r.data;
// the shell's validator knows no `data` yet (D441): check the rest of the result
const plain = (r: any) => ({ output: r.output, ...(r.summary ? { summary: r.summary } : {}) });
const actions = () => registry(plugin as any).actions;
const reset = () => (fake.requests.length = 0, fake.set({ kind: "ok" }), fake.setModels(["llama3.1"]));

beforeAll(async () => void (fake = await startFakeAi()));
afterAll(() => fake.close());

describe("ollama: request building", () => {
  it("messages, stream, keep_alive; options only when set", () => {
    expect(buildChat(conn().body, { system: "s", messages: [{ role: "user", text: "hi" }] })).toEqual({ model: "llama3.1", messages: [{ role: "system", content: "s" }, { role: "user", content: "hi" }], stream: true, keep_alive: "5m" });
    expect(buildChat(conn({ numCtx: "8192", keepAlive: "" }).body, { maxTokens: 500, format: "json" })).toMatchObject({ keep_alive: "5m", options: { num_ctx: 8192, num_predict: 500 }, format: "json" });
  });
  it("effort is ignored", () => {
    expect(JSON.stringify(buildChat(conn().body, { effort: "high" }))).not.toMatch(/effort/);
  });
});

describe("ollama: NDJSON parsing", () => {
  it("lines split anywhere; a broken line is skipped", () => {
    const got: any[] = [];
    const p = ndjsonParser((o: any) => got.push(o));
    for (const ch of '{"a":1}\n{bad\n{"b":"é"}') p.feed(ch);
    p.end();
    expect(got).toEqual([{ a: 1 }, { b: "é" }]);
  });
});

describe("ollama: errors and stops", () => {
  it("maps statuses and stops", () => {
    expect(mapHttpError(401, "{}", {}).code).toBe("auth");
    expect(mapHttpError(429, "{}", { "Retry-After": "3" })).toMatchObject({ code: "rateLimit", retryAfter: 3 });
    expect(mapHttpError(404, '{"error":"model \'x\' not found"}', {})).toMatchObject({ code: "other", notFound: true });
    expect([mapStop("stop"), mapStop("length"), mapStop("load"), mapStop(undefined)]).toEqual(["end", "maxTokens", "other", "end"]);
  });
});

describe("ollama: chat against the fake server", () => {
  it("streams lines; partial is the full text so far; usage from the done line; progress says loading then generating", async () => {
    reset();
    fake.set({ kind: "ok", pieces: ["Hel", "lo", "!"], inputTokens: 7, outputTokens: 3 });
    const { host, partials, calls } = hostFor();
    const progress: string[] = [];
    const res = await actions().chat(ctxOf(host, conn(), progress), { messages: [{ role: "user", text: "hi" }] });
    expect(checkActionResult(plain(res))).toEqual([]);
    expect(result(res)).toEqual({ text: "Hello!", model: "llama3.1", usage: { input: 7, output: 3 }, stop: "end" });
    const texts = partials.map((p) => p.text);
    expect(texts.at(-1)).toBe("Hello!");
    for (let i = 1; i < texts.length; i++) expect(texts[i].startsWith(texts[i - 1])).toBe(true);
    expect(progress).toEqual(["Loading the model…", "Generating…"]);
    expect(calls[0]).toMatchObject({ method: "POST", stream: true, timeoutMs: 600000, url: `${fake.url}/api/chat` });
    expect(fake.requests[0]!.body).toMatchObject({ model: "llama3.1", stream: true, keep_alive: "5m" });
  });
  it("the loading line (empty content) before the text does not break anything", async () => {
    reset();
    fake.setLoading(true);
    expect(result(await actions().chat(ctxOf(hostFor().host, conn()), { messages: [] })).text).toBe("Hello, world.");
  });
  it("the auth header goes out as a secret placeholder; no secret = no header", async () => {
    reset();
    const a = hostFor();
    await actions().chat(ctxOf(a.host, conn({ secret: { secret: SECRET }, authHeader: "X-Proxy-Auth" })), { messages: [] });
    expect(a.calls[0].headers).toMatchObject({ "X-Proxy-Auth": `{{secret:${SECRET}}}` });
    const b = hostFor();
    await actions().chat(ctxOf(b.host, conn()), { messages: [] });
    expect(Object.keys(b.calls[0].headers)).toEqual(["content-type"]);
    const c = hostFor();
    expect(result(await actions().chat(ctxOf(c.host, conn({ secret: { secret: SECRET }, authHeader: "bad name" })), { messages: [] })).error.code).toBe("other");
    expect(c.host.network.request).not.toHaveBeenCalled();
  });
  it("model not downloaded (404) → a message with ollama pull", async () => {
    reset();
    fake.set({ kind: "error", status: 404, body: { error: "model 'llama3.1' not found" } });
    const e = result(await actions().chat(ctxOf(hostFor().host, conn()), { messages: [] })).error;
    expect(e.message).toBe("Model “llama3.1” is not downloaded. Run: ollama pull llama3.1");
  });
  it("401, 429 with retry-after, an error line in the stream, a dropped connection", async () => {
    reset();
    fake.set({ kind: "error", status: 401 });
    expect(result(await actions().chat(ctxOf(hostFor().host, conn()), { messages: [] })).error.code).toBe("auth");
    fake.set({ kind: "error", status: 429, headers: { "retry-after": "4" } });
    expect(result(await actions().chat(ctxOf(hostFor().host, conn()), { messages: [] })).error).toMatchObject({ code: "rateLimit", retryAfter: 4 });
    fake.set({ kind: "streamError", pieces: ["x"], message: "model runner crashed" });
    expect(result(await actions().chat(ctxOf(hostFor().host, conn()), { messages: [] })).error).toMatchObject({ code: "other", message: "model runner crashed" });
    fake.set({ kind: "drop", pieces: ["a", "b", "c", "d"] });
    expect(result(await actions().chat(ctxOf(hostFor().host, conn()), { messages: [] })).error.code).toBe("network");
  });
  it("a cancelled run rethrows; no model / bad address are refused before any request", async () => {
    reset();
    fake.set({ kind: "slow", pieces: ["a", "b", "c"], delayMs: 20 });
    await expect(actions().chat(ctxOf(hostFor(1).host, conn()), { messages: [] })).rejects.toMatchObject({ params: { reason: "cancelled" } });
    const { host } = hostFor();
    expect(result(await actions().chat(ctxOf(host, conn({ model: "" })), { messages: [] })).error.code).toBe("other");
    expect(result(await actions().chat(ctxOf(host, conn({ baseUrl: "ftp://x" })), { messages: [] })).error.code).toBe("other");
    expect(host.network.request).not.toHaveBeenCalled();
  });
});

describe("ollama: models and test", () => {
  it("models lists the downloaded names", async () => {
    reset();
    fake.setModels(["a:1", "b:2"]);
    expect(result(await actions().models(ctxOf(hostFor().host, conn()), {})).models.map((m: any) => m.id)).toEqual(["a:1", "b:2"]);
  });
  it("test shows the version and the models; with none it says ollama pull <model>", async () => {
    reset();
    fake.setModels(["a:1"]);
    const ok = await actions().test(ctxOf(hostFor().host, conn()), {});
    expect(checkActionResult(plain(ok))).toEqual([]);
    expect(ok.output.text).toBe("Connected: Ollama 0.99.0-fake, 1 models downloaded (a:1)");
    expect(fake.requests.map((r) => r.path)).toEqual(["/api/version", "/api/tags"]);
    fake.setModels([]);
    expect((await actions().test(ctxOf(hostFor().host, conn()), {})).output.text).toMatch(/ollama pull llama3\.1$/);
  });
  it("test on a closed port throws a readable error", async () => {
    reset();
    const host = hostFor().host;
    host.network.request = vi.fn(async () => {
      throw Object.assign(new Error("invalid"), { code: "invalid", params: { reason: "network" } });
    });
    await expect(actions().test(ctxOf(host, conn()), {})).rejects.toThrow(/request failed/);
  });
});


describe("ollama: return shape (D441)", () => {
  it("readable text in output, the structured result in data; an error is readable too", async () => {
    reset();
    fake.set({ kind: "ok", pieces: ["Hi", "!"] });
    const res = await actions().chat(ctxOf(hostFor().host, conn()), { messages: [] });
    expect(res.output).toEqual({ type: "text", text: "Hi!" });
    expect(res.data).toMatchObject({ text: "Hi!", stop: "end" });
    fake.set({ kind: "error", status: 401 });
    const bad = await actions().chat(ctxOf(hostFor().host, conn()), { messages: [] });
    expect(bad.data.error.code).toBe("auth");
    expect(bad.output.text).toMatch(/did not accept/);
    const list = await actions().models(ctxOf(hostFor().host, conn()), {});
    expect(list.output.type).toBe("text");
    expect(Array.isArray(list.data.models) || list.data.error).toBeTruthy();
  });
});

describe("ollama: address rules", () => {
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
    const host = hostFor().host;
    for (const u of ["http://api.example.com", "https://api.example.com@evil.example"]) {
      expect(result(await actions().chat(ctxOf(host, conn({ baseUrl: u })), { messages: [], })).error.code).toBe("other");
      await expect(actions().test(ctxOf(host, conn({ baseUrl: u })), {})).rejects.toThrow();
    }
    expect(host.network.request).not.toHaveBeenCalled();
    const page = registry(plugin as any).pages.editor;
    const note = (u: string) => page.render(ctxOf({}, { id: "c1", body: { baseUrl: u, model: "m", secret: undefined } })).then((r: any) => r.view.find((n: any) => n.id === "note"));
    expect(await note("https://api.example.com:8443/v1")).toMatchObject({ text: expect.stringContaining("api.example.com:8443"), tone: "muted" });
    expect(await note("https://api.example.com@evil.example")).toMatchObject({ tone: "danger" });
    expect(await note("http://api.example.com")).toMatchObject({ tone: "danger" });
  });
});

describe("ollama: page and manifest", () => {
  it("the editor page is a valid view", async () => {
    const res = await registry(plugin as any).pages.editor.render(ctxOf({}, conn()));
    expect(checkView(res.view)).toEqual([]);
  });
  it("the manifest implements the chat interface; the address grants the network; defaults", () => {
    const m = JSON.parse(readFileSync(new URL("./manifest.json", import.meta.url), "utf8"));
    expect(m.implements["onedesk.ai.chat/1"]).toEqual({ actions: ["chat", "models", "test"], kind: "connection" });
    for (const a of m.implements["onedesk.ai.chat/1"].actions) expect(m.exports.actions).toContain(a);
    expect(m.requires.network).toEqual({ fromResources: true });
    expect(m.contributes.kinds[0].fields.baseUrl.grants).toBe("network");
    expect(m.contributes.kinds[0].defaults).toMatchObject({ baseUrl: "http://127.0.0.1:11434", keepAlive: "5m" });
  });
});
