import { beforeEach, describe, expect, it } from "vitest";
import type { HostApi, HostEvent, NetworkResponse } from "../plugin-api";
import type { KernelEvent } from "./contracts";
import { isNetworkAllowed } from "./host-api";
import { createTestKernel } from "./testing";
import type { TestKernel } from "./testing";
import { SAMPLE_ID, SAMPLE_KIND, createSamplePlugin } from "./testing/sample";

const describeKind = () => ({ summary: "", usage: "" });
const OK: NetworkResponse = { status: 200, statusText: "OK", headers: {}, body: "ok", durationMs: 1 };

/** Two extra plugins: `reader` requires the sample plugin, `stranger` requires nothing. */
function extras() {
  const hosts: Record<string, HostApi> = {};
  const make = (id: string, kind: string, requires: string[]) =>
    createSamplePlugin({
      manifest: { id, provides: { kinds: [kind], actions: ["ping"] }, requires: { plugins: requires } },
      activate: (host) => {
        hosts[id] = host;
        host.resources.registerKind({ id: kind, name: kind, schema: [], views: [], describe: describeKind });
        host.actions.register({ id: "ping", label: "ping", output: "text", run: () => ({ type: "text", text: `pong from ${id}` }) });
      },
    });
  return { hosts, sources: [make("org.test.reader", "reader-item", [SAMPLE_ID]).source, make("org.test.stranger", "stranger-item", []).source] };
}

let t: TestKernel;
let sample: HostApi;
let reader: HostApi;
let stranger: HostApi;

beforeEach(async () => {
  const plugin = createSamplePlugin();
  const { hosts, sources } = extras();
  t = await createTestKernel({ plugins: [plugin.source, ...sources], secrets: { sample_token: "s3cret", other_token: "nope" }, fetch: async () => OK });
  sample = plugin.host();
  reader = hosts["org.test.reader"]!;
  stranger = hosts["org.test.stranger"]!;
});

const sampleDraft = (name = "a") => ({ kind: SAMPLE_KIND, name, body: { url: "https://example.com" } });

describe("宿主 API：资源读写范围（D10/D60）", () => {
  it("自己的 kind 可读可写；id 和 origin 被忽略", async () => {
    const r = await sample.resources.create({ ...sampleDraft(), id: "forced", origin: "subscribed" });
    expect(r.id).not.toBe("forced");
    expect(r.origin).toBe("original");
    expect(await sample.resources.get(r.id)).toEqual(r);
    expect((await sample.resources.update(r.id, { name: "b" })).name).toBe("b");
    expect(await sample.resources.list({ kind: SAMPLE_KIND })).toHaveLength(1);
    await sample.resources.delete(r.id);
    expect(await sample.resources.get(r.id)).toBeNull();
    expect(sample.pluginId).toBe(SAMPLE_ID);
  });

  it("requires.plugins 声明的插件：只读，不能写", async () => {
    const r = await sample.resources.create(sampleDraft());
    expect(await reader.resources.get(r.id)).toEqual(r);
    expect(await reader.resources.list({ kind: SAMPLE_KIND })).toEqual([r]);
    await expect(reader.resources.update(r.id, { name: "x" })).rejects.toMatchObject({ code: "permission" });
    await expect(reader.resources.delete(r.id)).rejects.toMatchObject({ code: "permission" });
    await expect(reader.resources.create(sampleDraft())).rejects.toMatchObject({ code: "permission" });
    expect((await t.kernel.resources.get(r.id))?.name).toBe("a");
  });

  it("没有声明的插件：读写都拒绝", async () => {
    const r = await sample.resources.create(sampleDraft());
    await expect(stranger.resources.get(r.id)).rejects.toMatchObject({ code: "permission" });
    await expect(stranger.resources.list({ kind: SAMPLE_KIND })).rejects.toMatchObject({ code: "permission" });
    await expect(stranger.resources.update(r.id, { name: "x" })).rejects.toMatchObject({ code: "permission" });
    await expect(stranger.resources.delete(r.id)).rejects.toMatchObject({ code: "permission" });
    await expect(stranger.resources.create(sampleDraft())).rejects.toMatchObject({ code: "permission" });
    await expect(stranger.resources.create(undefined as never)).rejects.toMatchObject({ code: "permission" });
  });

  it("不带 kind 的 list 只返回可读范围内的资源", async () => {
    await sample.resources.create(sampleDraft());
    await reader.resources.create({ kind: "reader-item", name: "r" });
    await stranger.resources.create({ kind: "stranger-item", name: "s" });
    expect((await sample.resources.list()).map((r) => r.kind)).toEqual([SAMPLE_KIND]);
    expect((await reader.resources.list()).map((r) => r.kind).sort()).toEqual(["reader-item", SAMPLE_KIND]);
    expect((await stranger.resources.list()).map((r) => r.kind)).toEqual(["stranger-item"]);
  });

  it("不存在的资源：get 返回 null，update/delete 报 not_found", async () => {
    expect(await sample.resources.get("nope")).toBeNull();
    await expect(sample.resources.update("nope", { name: "x" })).rejects.toMatchObject({ code: "not_found" });
    await expect(sample.resources.delete("nope")).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("宿主 API：事件范围", () => {
  it("只收到可读 kind 的资源事件和可运行插件的动作结果", async () => {
    const seen: Record<string, string[]> = { sample: [], reader: [], stranger: [] };
    const record = (name: string) => (e: HostEvent) => {
      seen[name]!.push(e.type);
    };
    for (const [name, host] of [["sample", sample], ["reader", reader], ["stranger", stranger]] as const) {
      host.events.on("resource.created", record(name));
      host.events.on("resource.updated", record(name));
      host.events.on("resource.deleted", record(name));
      host.events.on("action.completed", record(name));
    }
    const r = await t.kernel.resources.create(sampleDraft());
    await t.kernel.resources.update(r.id, { name: "b" });
    await t.kernel.actions.run(`${SAMPLE_ID}/hello`, {});
    await t.kernel.resources.delete(r.id);
    const all = ["resource.created", "resource.updated", "action.completed", "resource.deleted"];
    expect(seen).toEqual({ sample: all, reader: all, stranger: [] });
  });

  it("可以取消订阅；不支持的事件类型被拒绝", async () => {
    let count = 0;
    const off = sample.events.on("resource.created", () => count++);
    await sample.resources.create(sampleDraft());
    off();
    await sample.resources.create(sampleDraft());
    expect(count).toBe(1);
    expect(() => sample.events.on("plugin.changed" as never, () => undefined)).toThrow(/不支持/);
  });
});

describe("宿主 API：运行动作", () => {
  it("可以运行自己的和 requires.plugins 的动作", async () => {
    expect(await sample.actions.run(`${SAMPLE_ID}/hello`, {})).toMatchObject({ status: "success" });
    const r = await sample.resources.create(sampleDraft("首页"));
    expect(await reader.actions.run(`${SAMPLE_ID}/echo`, { resourceId: r.id, input: { text: "x" } })).toMatchObject({ status: "success", output: { text: "首页:x!" } });
  });

  it("其他插件的动作：返回 permission 失败结果，不抛异常，也不执行", async () => {
    const events: KernelEvent[] = [];
    t.kernel.events.onAny((e) => events.push(e));
    const result = await stranger.actions.run(`${SAMPLE_ID}/hello`, { resourceId: "x" });
    expect(result).toMatchObject({ status: "error", action: `${SAMPLE_ID}/hello`, resourceId: "x", error: { code: "permission" } });
    expect(await sample.actions.run("org.test.reader/ping", {})).toMatchObject({ status: "error", error: { code: "permission" } });
    expect(await stranger.actions.run("no-slash", {})).toMatchObject({ status: "error", error: { code: "permission" } });
    expect(events).toEqual([]);
  });

  it("插件停用后旧的 host 运行动作返回 unavailable", async () => {
    await t.kernel.plugins.disable("org.test.stranger");
    expect(await stranger.actions.run("org.test.stranger/ping", {})).toMatchObject({ status: "error", error: { code: "unavailable" } });
  });
});

describe("宿主 API：网络主机模式（D13/D59）", () => {
  it.each([
    ["精确主机", "https://api.example.com/v1?q=1"],
    ["精确主机 http", "http://api.example.com"],
    ["精确主机大小写", "https://API.Example.COM/"],
    ["精确主机带端口", "https://api.example.com:8443/x"],
    ["通配子域", "https://a.example.org/"],
    ["通配多级子域", "https://a.b.example.org/"],
  ])("允许：%s", async (_label, url) => {
    expect(await sample.network.fetch(url)).toEqual(OK);
    expect(t.requests.at(-1)?.url).toBe(url);
  });

  it.each([
    ["未声明的主机", "https://evil.com/"],
    ["通配不含根域", "https://example.org/"],
    ["后缀相似的主机", "https://evilexample.org/"],
    ["声明主机作为前缀", "https://api.example.com.evil.com/"],
    ["声明主机作为子域的父域", "https://x.api.example.com/"],
    ["userinfo 伪装", "https://api.example.com@evil.com/"],
    ["非 http 协议", "ftp://api.example.com/"],
    ["file 协议", "file:///etc/passwd"],
    ["无法解析", "not a url"],
    ["相对地址", "/api"],
    ["空串", ""],
  ])("拒绝：%s", async (_label, url) => {
    await expect(sample.network.fetch(url)).rejects.toMatchObject({ code: "permission" });
    expect(t.requests).toEqual([]);
  });

  it("没有声明任何主机时全部拒绝；声明 * 时允许任意 http/https 主机", async () => {
    await expect(stranger.network.fetch("https://api.example.com/")).rejects.toMatchObject({ code: "permission" });
    expect(isNetworkAllowed(["*"], "https://anything.example/")).toBe(true);
    expect(isNetworkAllowed(["*"], "ftp://anything.example/")).toBe(false);
    expect(isNetworkAllowed(["*"], "javascript:alert(1)")).toBe(false);
  });

  it("不规范的模式一律不匹配", () => {
    expect(isNetworkAllowed(["*.*"], "https://a.b/")).toBe(false);
    expect(isNetworkAllowed(["*."], "https://a.b/")).toBe(false);
    expect(isNetworkAllowed(["api.*.com"], "https://api.x.com/")).toBe(false);
    expect(isNetworkAllowed(["*example.org"], "https://evilexample.org/")).toBe(false);
    expect(isNetworkAllowed(["example.com:8080"], "https://example.com:8080/")).toBe(true);
    expect(isNetworkAllowed(["example.com:8080"], "https://example.com:9090/")).toBe(false);
    expect(isNetworkAllowed([" Example.com "], "https://example.com./")).toBe(true);
  });

  it("默认超时 30 秒，可覆盖；非 2xx 正常返回；失败转为 unavailable", async () => {
    await sample.network.fetch("https://api.example.com/", { method: "POST", body: "x" });
    expect(t.requests.at(-1)?.init).toEqual({ method: "POST", body: "x", timeoutMs: 30_000 });
    await sample.network.fetch("https://api.example.com/", { timeoutMs: 5 });
    expect(t.requests.at(-1)?.init).toEqual({ timeoutMs: 5 });

    const p = createSamplePlugin();
    await createTestKernel({ plugins: [p.source], fetch: async () => ({ ...OK, status: 404, statusText: "Not Found" }) });
    expect(await p.host().network.fetch("https://api.example.com/missing")).toMatchObject({ status: 404 });

    const failing = createSamplePlugin();
    const down = await createTestKernel({
      plugins: [failing.source],
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });
    await expect(failing.host().network.fetch("https://api.example.com/")).rejects.toMatchObject({ code: "unavailable", message: expect.stringContaining("fetch failed") });
    down.close();

    const offline = createSamplePlugin();
    await createTestKernel({ plugins: [offline.source] });
    await expect(offline.host().network.fetch("https://api.example.com/")).rejects.toMatchObject({ code: "unavailable", message: "测试中没有提供网络" });
  });
});

describe("宿主 API：密钥（D14）", () => {
  it("只能读清单声明的名字", async () => {
    expect(await sample.secrets.get("sample_token")).toBe("s3cret");
    await expect(sample.secrets.get("other_token")).rejects.toMatchObject({ code: "permission" });
    await expect(stranger.secrets.get("sample_token")).rejects.toMatchObject({ code: "permission" });
  });

  it("声明了但没有设置的密钥返回 undefined", async () => {
    await t.kernel.secrets.delete("sample_token");
    expect(await sample.secrets.get("sample_token")).toBeUndefined();
  });
});

describe("宿主 API：其他能力", () => {
  it("存储按插件隔离，值是 JSON", async () => {
    await sample.storage.set("last", { status: 200, list: [1, 2] });
    await sample.storage.set("last", { status: 201 });
    await sample.storage.set("b", "x");
    await stranger.storage.set("last", "mine");
    expect(await sample.storage.get("last")).toEqual({ status: 201 });
    expect(await stranger.storage.get("last")).toBe("mine");
    expect(await sample.storage.keys()).toEqual(["b", "last"]);
    await sample.storage.delete("b");
    await sample.storage.set("last", undefined);
    expect(await sample.storage.keys()).toEqual([]);
    expect(await sample.storage.get("last")).toBeUndefined();
    expect(await stranger.storage.keys()).toEqual(["last"]);
    await expect(sample.storage.set("", 1)).rejects.toMatchObject({ code: "validation" });
  });

  it("打开外部链接只允许 http、https、mailto；复制文本", async () => {
    await sample.ui.openExternal("https://example.com/a");
    await sample.ui.openExternal("mailto:a@example.com", { profile: "work" });
    for (const url of ["javascript:alert(1)", "file:///etc/passwd", "example.com", "", 1 as never]) {
      await expect(sample.ui.openExternal(url)).rejects.toMatchObject({ code: "validation" });
    }
    expect(t.opened).toEqual(["https://example.com/a", "mailto:a@example.com"]);
    await sample.ui.copyText("你好");
    expect(t.copied).toEqual(["你好"]);
  });

  it("通知经事件发给外壳，带插件 id 和默认 tone", async () => {
    const seen: KernelEvent[] = [];
    t.kernel.events.on("notify", (e) => seen.push(e));
    sample.notify({ title: "已复制" });
    expect(seen).toEqual([{ type: "notify", pluginId: SAMPLE_ID, message: { tone: "info", title: "已复制" } }]);
    expect(() => sample.notify({ title: "" })).toThrow(/通知内容不正确/);
  });

  it("集合：可列出、读取、创建", async () => {
    const c = await sample.collections.create({ name: "工作", rule: { type: "tag", value: "工作" } });
    expect(await sample.collections.list()).toEqual([c]);
    expect(await sample.collections.get(c.id)).toEqual(c);
  });

  it("上下文是副本，改动不影响内核", () => {
    sample.context.workspace.name = "改了";
    expect(t.kernel.context.workspace.name).toBe("本地工作区");
    expect(stranger.context.workspace.name).toBe("本地工作区");
  });

  it("停用后所有调用都报 unavailable", async () => {
    await t.kernel.plugins.disable(SAMPLE_ID);
    await expect(sample.resources.get("x")).rejects.toMatchObject({ code: "unavailable" });
    await expect(sample.resources.create(sampleDraft())).rejects.toMatchObject({ code: "unavailable" });
    await expect(sample.resources.update("x", {})).rejects.toMatchObject({ code: "unavailable" });
    await expect(sample.resources.delete("x")).rejects.toMatchObject({ code: "unavailable" });
    await expect(sample.collections.list()).rejects.toMatchObject({ code: "unavailable" });
    await expect(sample.collections.get("x")).rejects.toMatchObject({ code: "unavailable" });
    await expect(sample.collections.create({ name: "x", rule: { type: "tag", value: "x" } })).rejects.toMatchObject({ code: "unavailable" });
    await expect(sample.storage.get("x")).rejects.toMatchObject({ code: "unavailable" });
    await expect(sample.storage.set("x", 1)).rejects.toMatchObject({ code: "unavailable" });
    await expect(sample.storage.delete("x")).rejects.toMatchObject({ code: "unavailable" });
    await expect(sample.storage.keys()).rejects.toMatchObject({ code: "unavailable" });
    await expect(sample.settings.get("greeting")).rejects.toMatchObject({ code: "unavailable" });
    await expect(sample.secrets.get("sample_token")).rejects.toMatchObject({ code: "unavailable" });
    await expect(sample.network.fetch("https://api.example.com/")).rejects.toMatchObject({ code: "unavailable" });
    await expect(sample.ui.openExternal("https://example.com")).rejects.toMatchObject({ code: "unavailable" });
    await expect(sample.ui.copyText("x")).rejects.toMatchObject({ code: "unavailable" });
    expect(() => sample.events.on("resource.created", () => undefined)).toThrow(/已停用/);
    expect(() => sample.ui.registerView({ id: "summary", label: "x", render: () => [] })).toThrow(/已停用/);
    expect(t.requests).toEqual([]);
    expect(t.opened).toEqual([]);
  });
});
