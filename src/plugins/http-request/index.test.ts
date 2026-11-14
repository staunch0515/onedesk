import { describe, expect, it } from "vitest";
import { ManifestSchema, OneDeskError, type ManifestInput, ViewTreeSchema, type NetworkResponse } from "@onedesk/plugin-api";
import { activatePlugin, type FakeHost } from "../testing/fake-host";
import manifestJson from "./manifest.json";
import plugin from "./index";

const ok: NetworkResponse = {
  status: 200,
  statusText: "OK",
  headers: { "content-type": "application/json" },
  body: '{"hello":"world"}',
  durationMs: 42,
};

const setup = (fetch: () => NetworkResponse | Promise<NetworkResponse> = () => ok, settings?: Record<string, unknown>) =>
  activatePlugin(plugin, { pluginId: "org.onedesk.http-request", fetch, settings, manifest: manifestJson as ManifestInput });

const req = (host: FakeHost, body: Record<string, unknown> = {}) =>
  host.createResource("http-request", { method: "POST", url: "https://api.example.com/items", ...body });

describe("http-request plugin", () => {
  it("manifest is valid, declares network, matches what is registered", async () => {
    const manifest = ManifestSchema.parse(manifestJson);
    expect(manifest.requires.network).toEqual(["*"]);
    expect(manifest.settings.map((s) => s.name)).toEqual(["timeoutMs"]);
    const host = await setup();
    expect([...host.registered.kinds.keys()]).toEqual(manifest.provides.kinds);
    expect([...host.registered.actions.keys()]).toEqual(manifest.provides.actions);
    expect([...host.registered.views.keys()]).toEqual(manifest.provides.views);
    expect(host.registered.kinds.get("http-request")!.defaultAction).toBe("send");
    expect(host.registered.actions.get("send")!.output).toBe("text");
  });

  it("send: forwards method, headers, body and timeout; stores and returns the response", async () => {
    const host = await setup();
    const r = await req(host, { headers: "Content-Type: application/json\n\nX-Token:  abc ", body: '{"a":1}' });
    const result = await host.runAction("send", r);
    expect(result.status).toBe("success");
    expect(host.fetchCalls).toHaveLength(1);
    expect(host.fetchCalls[0]!.url).toBe("https://api.example.com/items");
    expect(host.fetchCalls[0]!.init).toMatchObject({
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Token": "abc" },
      body: '{"a":1}',
      timeoutMs: 30000,
    });
    expect(result.output).toMatchObject({ type: "text", format: "code" });
    const text = result.output && result.output.type === "text" ? result.output.text : "";
    expect(text.split("\n")[0]).toBe("200 OK · 42 ms");
    expect(text).toContain('{"hello":"world"}');
    expect(host.store.get(`response:${r.id}`)).toMatchObject({ status: 200, statusText: "OK", durationMs: 42, body: ok.body, headers: ok.headers });
    expect(typeof (host.store.get(`response:${r.id}`) as { receivedAt: string }).receivedAt).toBe("string");
  });

  it("send: uses the timeoutMs setting", async () => {
    const host = await setup(() => ok, { timeoutMs: 5000 });
    await host.runAction("send", await req(host));
    expect(host.fetchCalls[0]!.init?.timeoutMs).toBe(5000);
  });

  it("send: omits the body for GET and HEAD, defaults the method to GET", async () => {
    const host = await setup();
    await host.runAction("send", await req(host, { method: "GET", body: "ignored" }));
    await host.runAction("send", await req(host, { method: undefined, body: "ignored" }));
    expect(host.fetchCalls.map((c) => [c.init?.method, c.init?.body])).toEqual([
      ["GET", undefined],
      ["GET", undefined],
    ]);
  });

  it("send: a non-2xx status is still a success with the response stored and a message", async () => {
    const host = await setup(() => ({ ...ok, status: 404, statusText: "Not Found", body: "nope" }));
    const r = await req(host);
    const result = await host.runAction("send", r);
    expect(result.status).toBe("success");
    expect(result.output).toMatchObject({ message: "服务器返回 404" });
    expect(host.store.get(`response:${r.id}`)).toMatchObject({ status: 404 });
  });

  it("send: a network failure becomes an unavailable error and keeps the previous response", async () => {
    const host = await setup();
    const r = await req(host);
    await host.runAction("send", r);
    host.setFetch(() => {
      throw new OneDeskError("unavailable", "连接超时");
    });
    const result = await host.runAction("send", r);
    expect(result.status).toBe("error");
    expect(result.error?.code).toBe("unavailable");
    expect(result.error?.message).toContain("连接超时");
    expect(host.store.get(`response:${r.id}`)).toMatchObject({ status: 200 });
  });

  it.each([
    ["missing url", { url: "" }],
    ["non-http url", { url: "ftp://example.com" }],
    ["unparsable url", { url: "http://" }],
  ])("send: rejects %s without calling the network", async (_n, body) => {
    const host = await setup();
    const result = await host.runAction("send", await req(host, body));
    expect(result.status).toBe("error");
    expect(result.error?.code).toBe("validation");
    expect(host.fetchCalls).toHaveLength(0);
  });

  it("send: rejects a malformed header line and names the line", async () => {
    const host = await setup();
    const result = await host.runAction("send", await req(host, { headers: "Accept: */*\nthis is wrong" }));
    expect(result.status).toBe("error");
    expect(result.error?.code).toBe("validation");
    expect(result.error?.message).toContain("第 2 行");
    expect(host.fetchCalls).toHaveLength(0);
  });

  it("send: rejects an unknown method and a missing resource", async () => {
    const host = await setup();
    expect((await host.runAction("send", await req(host, { method: "TRACE" }))).error?.code).toBe("validation");
    expect((await host.runAction("send", undefined)).error?.code).toBe("validation");
  });

  describe("validate", () => {
    it("accepts a good request", async () => {
      const validate = (await setup()).registered.kinds.get("http-request")!.validate!;
      expect(validate({ url: "https://a.io", headers: "A: b\nC: d" })).toEqual({});
    });
    it("reports bad url and bad header lines", async () => {
      const validate = (await setup()).registered.kinds.get("http-request")!.validate!;
      expect(validate({ url: "x" }).url).toBeTruthy();
      expect(validate({ url: "https://a.io", headers: "oops" }).headers).toContain("第 1 行");
    });
  });

  describe("response view", () => {
    it("prompts to send when there is no response", async () => {
      const host = await setup();
      const tree = await host.renderView("response", await req(host));
      expect(ViewTreeSchema.safeParse(tree).success).toBe(true);
      expect(JSON.stringify(tree)).toContain("发送");
    });

    it("shows status, headers table and body after a send (survives a new host via storage)", async () => {
      const host = await setup();
      const r = await req(host);
      await host.runAction("send", r);
      const tree = await host.renderView("response", r);
      expect(ViewTreeSchema.safeParse(tree).success).toBe(true);
      const nodes = Array.isArray(tree) ? tree : [tree];
      expect(nodes.map((n) => n.type)).toEqual(["text", "table", "text"]);
      expect(JSON.stringify(nodes[0])).toContain("200 OK");
      expect(nodes[1]).toMatchObject({ rows: [{ name: "content-type", value: "application/json" }] });
      expect(nodes[2]).toMatchObject({ format: "code", text: ok.body });
    });

    it("marks error statuses and handles empty body and headers", async () => {
      const host = await setup(() => ({ status: 500, statusText: "Server Error", headers: {}, body: "", durationMs: 1 }));
      const r = await req(host);
      await host.runAction("send", r);
      const tree = await host.renderView("response", r);
      expect(ViewTreeSchema.safeParse(tree).success).toBe(true);
      expect(Array.isArray(tree) && tree[0]).toMatchObject({ tone: "danger" });
    });
  });

  it("deleting a resource removes its stored response", async () => {
    const host = await setup();
    const r = await req(host);
    await host.runAction("send", r);
    await host.resources.delete(r.id);
    await Promise.resolve();
    expect(host.store.has(`response:${r.id}`)).toBe(false);
  });

  it("activation removes stored responses whose resource no longer exists", async () => {
    const host = await setup();
    const live = await req(host);
    await host.storage.set(`response:${live.id}`, { status: 200 });
    await host.storage.set("response:gone", { status: 200 });
    await host.storage.set("other", 1);
    // A second activation on the same storage simulates a restart.
    host.resetRegistrations();
    await plugin.activate(host);
    expect([...host.store.keys()].sort()).toEqual(["other", `response:${live.id}`].sort());
  });

  it("send: does not store a response when the resource was deleted during the request", async () => {
    const host = await setup(async () => {
      await host.resources.delete(r.id);
      return ok;
    });
    const r = await req(host);
    const result = await host.runAction("send", r);
    expect(result.status).toBe("success");
    expect(host.store.has(`response:${r.id}`)).toBe(false);
  });

  it("send: truncates very large bodies and the view warns", async () => {
    const big = "x".repeat(1_000_000 + 10);
    const host = await setup(() => ({ ...ok, body: big }));
    const r = await req(host);
    const result = await host.runAction("send", r);
    expect(result.status).toBe("success");
    expect(result.output).toMatchObject({ message: "正文过大，已截断" });
    const stored = host.store.get(`response:${r.id}`) as { body: string; truncated: boolean };
    expect(stored.body).toHaveLength(1_000_000);
    expect(stored.truncated).toBe(true);
    const tree = await host.renderView("response", r);
    expect(ViewTreeSchema.safeParse(tree).success).toBe(true);
    expect(Array.isArray(tree) && tree.some((n) => n.type === "text" && n.tone === "warning" && n.text.includes("已截断"))).toBe(true);
  });

  it("send: a small body is not marked truncated", async () => {
    const host = await setup();
    const r = await req(host);
    await host.runAction("send", r);
    expect(host.store.get(`response:${r.id}`)).toMatchObject({ truncated: false });
  });

  it("send: header names merge case-insensitively, joined with a comma", async () => {
    const host = await setup();
    await host.runAction("send", await req(host, { headers: "Accept: a/b\naccept: c/d\nX-A: 1" }));
    expect(host.fetchCalls[0]!.init?.headers).toEqual({ Accept: "a/b, c/d", "X-A": "1" });
  });

  it("send: rejects header values with non-ASCII characters but accepts tabs", async () => {
    const host = await setup();
    const bad = await host.runAction("send", await req(host, { headers: "X-Name: 你好" }));
    expect(bad.error?.code).toBe("validation");
    expect(bad.error?.message).toContain("第 1 行");
    expect(host.fetchCalls).toHaveLength(0);
    const good = await host.runAction("send", await req(host, { headers: "X-Name: a\tb" }));
    expect(good.status).toBe("success");
    expect((await setup()).registered.kinds.get("http-request")!.validate!({ url: "https://a.io", headers: "X: é" }).headers).toBeTruthy();
  });

  it("send: aborting the run yields a cancelled result", async () => {
    const host = await setup(() => new Promise<NetworkResponse>((resolve) => setTimeout(() => resolve(ok), 20)));
    const run = host.runActionAbortable("send", await req(host));
    run.abort();
    expect((await run.result).status).toBe("cancelled");
  });

  it("timeoutMs falls back to the manifest default", async () => {
    const host = await setup();
    await host.runAction("send", await req(host));
    expect(host.fetchCalls[0]!.init?.timeoutMs).toBe(30000);
  });

  it("describe returns Chinese summary and usage", async () => {
    const host = await setup();
    const d = host.registered.kinds.get("http-request")!.describe(await req(host, {}));
    expect(d.summary).toContain("POST https://api.example.com/items");
    expect(d.usage).toContain("发送");
    expect(host.registered.kinds.get("http-request")!.describe(host.makeResource("http-request", {})).summary).toContain("GET");
  });
});
