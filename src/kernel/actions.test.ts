import { beforeEach, describe, expect, it } from "vitest";
import type { Resource } from "../plugin-api";
import type { KernelEvent } from "./contracts";
import { createTestKernel } from "./testing";
import type { TestKernel } from "./testing";
import { SAMPLE_ID, SAMPLE_KIND, createSamplePlugin } from "./testing/sample";
import type { SamplePlugin } from "./testing/sample";

const key = (id: string) => `${SAMPLE_ID}/${id}`;
let t: TestKernel;
let plugin: SamplePlugin;
let resource: Resource;
let events: KernelEvent[];

beforeEach(async () => {
  plugin = createSamplePlugin();
  t = await createTestKernel({ plugins: [plugin.source] });
  resource = await t.kernel.resources.create({
    kind: SAMPLE_KIND,
    name: "首页",
    body: { url: "https://example.com", params: [{ name: "who", label: "称呼", required: true }, { name: "lang", default: "中文", required: true }, { name: "tone" }] },
  });
  events = [];
  t.kernel.events.onAny((e) => events.push(e));
});

describe("动作执行", () => {
  it("成功：校验输入、补默认值、返回输出并发出事件", async () => {
    const result = await t.kernel.actions.run(key("echo"), { resourceId: resource.id, input: { text: "hi" } });
    expect(result).toMatchObject({ status: "success", action: key("echo"), resourceId: resource.id, output: { type: "text", text: "首页:hi!", format: "plain" } });
    expect(result.runId).toBeTruthy();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.error).toBeUndefined();
    expect(events.map((e) => e.type)).toEqual(["action.started", "action.completed"]);
    expect(events[0]).toEqual({ type: "action.started", runId: result.runId, key: key("echo"), resourceId: resource.id });
    expect(events[1]).toEqual({ type: "action.completed", result });
    expect(t.kernel.actions.lastResult(resource.id)).toEqual(result);
    expect(t.kernel.actions.running()).toEqual([]);
  });

  it("全局动作不需要资源", async () => {
    const result = await t.kernel.actions.run(key("hello"), {});
    expect(result).toMatchObject({ status: "success", output: { type: "text", text: "你好" } });
    expect(result.resourceId).toBeUndefined();
  });

  it("插件抛 OneDeskError：code、message、hint 原样进入结果", async () => {
    const result = await t.kernel.actions.run(key("fail"), { resourceId: resource.id });
    expect(result).toMatchObject({ status: "error", error: { code: "unavailable", message: "服务不可用", hint: "稍后重试" } });
    expect(result.output).toBeUndefined();
    expect(t.kernel.actions.lastResult(resource.id)).toEqual(result);
    expect(events.at(-1)).toEqual({ type: "action.completed", result });
  });

  it("插件抛普通错误：转为 internal", async () => {
    const result = await t.kernel.actions.run(key("fail"), { resourceId: resource.id, input: { plain: true } });
    expect(result).toMatchObject({ status: "error", error: { code: "internal", message: "普通错误" } });
  });

  it("输出类型与声明不符", async () => {
    const result = await t.kernel.actions.run(key("wrong"), { resourceId: resource.id });
    expect(result).toMatchObject({ status: "error", error: { code: "validation", message: expect.stringContaining("输出类型与声明不符") } });
  });

  it("输出格式不合法", async () => {
    const custom = createSamplePlugin({
      manifest: { id: "org.test.custom", provides: { actions: ["bad", "empty"] } },
      activate: (host) => {
        host.actions.register({ id: "bad", label: "x", output: "link", run: () => ({ type: "link", href: "javascript:alert(1)" }) });
        host.actions.register({ id: "empty", label: "x", output: "text", run: () => undefined as never });
      },
    });
    await t.kernel.plugins.load([custom.source]);
    expect(await t.kernel.actions.run("org.test.custom/bad", {})).toMatchObject({ status: "error", error: { code: "validation", message: expect.stringContaining("输出格式不正确") } });
    // Returning nothing counts as `none`, which every action may return.
    expect(await t.kernel.actions.run("org.test.custom/empty", {})).toMatchObject({ status: "success", output: { type: "none" } });
  });

  it("取消：结果为 cancelled，signal 被中止", async () => {
    const pending = t.kernel.actions.run(key("slow"), { resourceId: resource.id });
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    const [running] = t.kernel.actions.running();
    expect(running).toMatchObject({ key: key("slow"), resourceId: resource.id });
    t.kernel.actions.cancel(running!.runId);
    const result = await pending;
    expect(result).toMatchObject({ status: "cancelled", runId: running!.runId, error: { message: "已取消" } });
    expect(t.kernel.actions.running()).toEqual([]);
    t.kernel.actions.cancel("unknown-run"); // 不存在的 runId 不报错
  });

  it("未取消的慢动作正常完成", async () => {
    const pending = t.kernel.actions.run(key("slow"), { resourceId: resource.id });
    await new Promise((r) => setTimeout(r, 0));
    plugin.releaseSlow();
    expect(await pending).toMatchObject({ status: "success", output: { type: "none", message: "完成" } });
  });

  it("插件停用：运行中的动作被取消，之后再运行返回错误", async () => {
    const pending = t.kernel.actions.run(key("slow"), { resourceId: resource.id });
    await new Promise((r) => setTimeout(r, 0));
    await t.kernel.plugins.disable(SAMPLE_ID);
    expect(await pending).toMatchObject({ status: "cancelled", error: { message: expect.stringContaining("插件已停用") } });
    const after = await t.kernel.actions.run(key("echo"), { resourceId: resource.id, input: { text: "x" } });
    expect(after).toMatchObject({ status: "error", error: { code: "unavailable", message: expect.stringContaining("插件已停用") } });
  });

  it.each<[string, string, { resourceId?: string; input?: Record<string, unknown> }, string]>([
    ["未知动作", `${SAMPLE_ID}/nope`, {}, "not_found"],
    ["未知插件", "org.test.none/echo", {}, "not_found"],
    ["没有斜杠的键", "echo", {}, "not_found"],
    ["资源不存在", key("echo"), { resourceId: "nope", input: { text: "x" } }, "not_found"],
    ["需要资源却没给", key("echo"), { input: { text: "x" } }, "validation"],
    ["缺少必填输入", key("echo"), { resourceId: "RESOURCE" }, "validation"],
    ["输入类型不对", key("echo"), { resourceId: "RESOURCE", input: { text: 1 } }, "validation"],
    ["输入不是对象", key("echo"), { resourceId: "RESOURCE", input: [] as never }, "validation"],
  ])("不抛异常，返回失败结果：%s", async (_label, actionKey, args, code) => {
    const fixed = args.resourceId === "RESOURCE" ? { ...args, resourceId: resource.id } : args;
    const result = await t.kernel.actions.run(actionKey, fixed);
    expect(result).toMatchObject({ status: "error", error: { code } });
    expect(events.some((e) => e.type === "action.started")).toBe(false);
    expect(events.at(-1)).toEqual({ type: "action.completed", result });
  });

  it("动作不适用于该类型的资源", async () => {
    const other = createSamplePlugin({
      manifest: { id: "org.test.other", provides: { kinds: ["other"] } },
      activate: (host) => host.resources.registerKind({ id: "other", name: "其他", schema: [], views: [], describe: () => ({ summary: "", usage: "" }) }),
    });
    await t.kernel.plugins.load([other.source]);
    const r = await t.kernel.resources.create({ kind: "other", name: "x" });
    expect(await t.kernel.actions.run(key("echo"), { resourceId: r.id, input: { text: "x" } })).toMatchObject({ status: "error", error: { code: "validation" } });
  });

  it("来源和上下文传给插件", async () => {
    let seen: unknown;
    const custom = createSamplePlugin({
      manifest: { id: "org.test.ctx", provides: { actions: ["ctx"] } },
      activate: (host) =>
        host.actions.register({
          id: "ctx",
          label: "x",
          output: "none",
          run: (context) => {
            seen = { source: context.source, workspace: context.workspace.id, user: context.user.id, aborted: context.signal.aborted, resource: context.resource };
            return { type: "none" };
          },
        }),
    });
    await t.kernel.plugins.load([custom.source]);
    await t.kernel.actions.run("org.test.ctx/ctx", { source: "schedule" });
    expect(seen).toEqual({ source: "schedule", workspace: "local", user: "local", aborted: false, resource: undefined });
  });
});

describe("动作输入字段", () => {
  it("静态字段原样返回；未知动作返回空", () => {
    expect(t.kernel.actions.inputFields(key("echo")).map((f) => f.name)).toEqual(["text", "suffix"]);
    expect(t.kernel.actions.inputFields(key("fail"))).toEqual([]);
    expect(t.kernel.actions.inputFields("org.test.none/x")).toEqual([]);
  });

  it("fromField：每个参数生成一个 text 字段；只有 required 且无默认值的才必填", () => {
    expect(t.kernel.actions.inputFields(key("fill"), resource)).toEqual([
      { name: "who", label: "称呼", type: "text", required: true },
      { name: "lang", label: "lang", type: "text", default: "中文" },
      { name: "tone", label: "tone", type: "text" },
    ]);
  });

  it("fromField：没有资源、字段不是列表、条目不合法时忽略", async () => {
    expect(t.kernel.actions.inputFields(key("fill"))).toEqual([]);
    expect(t.kernel.actions.inputFields(key("fill"), { ...resource, body: { params: "x" } })).toEqual([]);
    expect(t.kernel.actions.inputFields(key("fill"), { ...resource, body: { params: [{ name: "ok" }, { name: "1bad" }, 3] } }).map((f) => f.name)).toEqual(["ok"]);
  });

  it("fromField：run 收到 { 参数名: 字符串 }，空串回退到默认值，缺少必填时报错", async () => {
    const ok = await t.kernel.actions.run(key("fill"), { resourceId: resource.id, input: { who: "老王", lang: "", tone: "" } });
    expect(ok).toMatchObject({ status: "success", output: { text: JSON.stringify({ who: "老王", lang: "中文", tone: "" }) } });
    const missing = await t.kernel.actions.run(key("fill"), { resourceId: resource.id, input: { who: "" } });
    expect(missing).toMatchObject({ status: "error", error: { code: "validation", message: "称呼不能为空" } });
  });
});
