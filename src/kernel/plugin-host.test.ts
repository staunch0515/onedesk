import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostApi, PluginModule } from "../plugin-api";
import { CORE_EDIT_VIEW } from "./contracts";
import type { KernelEvent } from "./contracts";
import { ACTIVATION_TIMEOUT_MS } from "./plugin-host";
import { createTestKernel, pluginSource } from "./testing";
import { SAMPLE_ID, SAMPLE_KIND, createSamplePlugin, sampleKind, sampleManifest } from "./testing/sample";

const noop: PluginModule = { activate: () => undefined };
const ECHO = `${SAMPLE_ID}/echo`;

describe("清单校验：每种拒绝原因", () => {
  it("扫描错误：上报原因，不加载", async () => {
    const t = await createTestKernel({
      plugins: [pluginSource(null, noop, { origin: "external", location: "/plugins/broken", error: "manifest.json 不是合法 JSON" })],
    });
    expect(t.kernel.plugins.list()).toEqual([]);
    expect(t.kernel.plugins.loadErrors()).toEqual([{ origin: "external", location: "/plugins/broken", reason: "manifest.json 不是合法 JSON" }]);
  });

  it("清单缺失", async () => {
    const t = await createTestKernel({ plugins: [pluginSource(null, noop)] });
    expect(t.kernel.plugins.loadErrors()[0]?.reason).toContain("缺失");
  });

  it.each([
    ["id 不是反向域名", { id: "sample" }, "id"],
    ["version 不是语义化版本", { version: "1" }, "version"],
    ["未知字段（严格校验）", { permisions: [] }, "permisions"],
    ["provides 类型不对", { provides: { kinds: "sample" } }, "provides.kinds"],
    ["缺少 name", { name: undefined }, "name"],
    ["settings 字段不合法", { settings: [{ name: "a b", label: "x", type: "text" }] }, "settings"],
  ])("格式错误：%s", async (_label, patch, mention) => {
    const t = await createTestKernel({ plugins: [pluginSource({ ...sampleManifest(), ...patch }, noop)] });
    expect(t.kernel.plugins.list()).toEqual([]);
    const [error] = t.kernel.plugins.loadErrors();
    expect(error?.reason).toContain("清单格式错误");
    expect(error?.reason).toContain(mention);
  });

  it("apiVersion 不兼容", async () => {
    const t = await createTestKernel({ plugins: [createSamplePlugin({ manifest: { apiVersion: "2" } }).source] });
    expect(t.kernel.plugins.list()).toEqual([]);
    expect(t.kernel.plugins.loadErrors()).toEqual([expect.objectContaining({ pluginId: SAMPLE_ID, reason: expect.stringContaining("apiVersion") })]);
  });

  it("id 重复：第一个生效，第二个被拒绝", async () => {
    const first = createSamplePlugin();
    const second = createSamplePlugin({ origin: "external" });
    const t = await createTestKernel({ plugins: [first.source, second.source] });
    expect(t.kernel.plugins.list()).toHaveLength(1);
    expect(t.kernel.plugins.loadErrors()).toEqual([expect.objectContaining({ origin: "external", pluginId: SAMPLE_ID, reason: expect.stringContaining("重复") })]);
    expect(second.activations).toBe(0);
  });

  it("kind 已被其他插件声明", async () => {
    const other = pluginSource({ ...sampleManifest(), id: "org.test.other" }, noop);
    const t = await createTestKernel({ plugins: [createSamplePlugin().source, other] });
    expect(t.kernel.plugins.loadErrors()[0]?.reason).toContain(`资源类型 ${SAMPLE_KIND} 已由插件 ${SAMPLE_ID} 提供`);
  });

  it.each<[string, (host: HostApi) => void, string]>([
    ["未声明的 kind", (h) => h.resources.registerKind({ ...sampleKind, id: "undeclared", defaultAction: undefined, views: [] }), "provides.kinds"],
    ["未声明的动作", (h) => h.actions.register({ id: "undeclared", label: "x", output: "none", run: () => ({ type: "none" }) }), "provides.actions"],
    ["未声明的视图", (h) => h.ui.registerView({ id: "undeclared", label: "x", render: () => [] }), "provides.views"],
    [
      "未声明的注册被插件吞掉异常",
      (h) => {
        try {
          h.actions.register({ id: "undeclared", label: "x", output: "none", run: () => ({ type: "none" }) });
        } catch {
          /* 故意吞掉 */
        }
      },
      "provides.actions",
    ],
    ["kind 定义不合法", (h) => h.resources.registerKind({ ...sampleKind, schema: [{ name: "x", label: "x", type: "select" }] }), "资源类型定义不正确"],
    ["动作缺少 run", (h) => h.actions.register({ id: "echo", label: "x", output: "none" } as never), "run"],
    ["视图缺少 render", (h) => h.ui.registerView({ id: "summary", label: "x" } as never), "render"],
    ["kind 缺少 describe", (h) => h.resources.registerKind({ ...sampleKind, describe: undefined } as never), "describe"],
    [
      "重复注册",
      (h) => {
        const view = { id: "summary", label: "x", render: () => [] };
        h.ui.registerView(view);
        h.ui.registerView(view);
      },
      "重复注册",
    ],
    ["默认动作没有注册", (h) => h.resources.registerKind({ ...sampleKind, views: [] }), "默认动作 echo 没有注册"],
    [
      "默认动作不适用于该 kind",
      (h) => {
        h.resources.registerKind({ ...sampleKind, views: [] });
        h.actions.register({ id: "echo", label: "x", output: "none", run: () => ({ type: "none" }) });
      },
      "kinds 中没有该类型",
    ],
    ["kind 的视图没有注册", (h) => h.resources.registerKind({ ...sampleKind, defaultAction: undefined }), "视图 summary 没有注册"],
    [
      "动作挂到别的插件的 kind 上",
      (h) => h.actions.register({ id: "echo", label: "x", kinds: ["foreign"], output: "none", run: () => ({ type: "none" }) }),
      "不是本插件注册的类型 foreign",
    ],
    ["菜单项的动作没有注册", (h) => h.ui.registerMenuItem({ id: "m", label: "x", action: "echo" }), "菜单项 m 的动作 echo 没有注册"],
    [
      "activate 抛错",
      () => {
        throw new Error("启动失败");
      },
      "启动失败",
    ],
  ])("激活被拒绝：%s", async (_label, activate, mention) => {
    const plugin = createSamplePlugin({ activate });
    const t = await createTestKernel({ plugins: [plugin.source] });
    const [info] = t.kernel.plugins.list();
    expect(info?.state).toBe("disabled");
    expect(info?.activationError).toContain(mention);
    // Nothing of a failed activation stays registered.
    expect(t.kernel.registry.kinds()).toEqual([]);
    expect(t.kernel.registry.viewsFor(SAMPLE_KIND)).toEqual([]);
    expect(t.kernel.registry.action(ECHO)).toBeUndefined();
    await expect(t.kernel.plugins.enable(SAMPLE_ID)).rejects.toMatchObject({ code: "unavailable" });
  });

  it("入口模块加载失败或没有 activate", async () => {
    const t = await createTestKernel({
      plugins: [
        pluginSource(sampleManifest(), () => {
          throw new Error("语法错误");
        }),
        pluginSource({ ...sampleManifest({ provides: {} }), id: "org.test.empty" }, {} as PluginModule),
      ],
    });
    const [a, b] = t.kernel.plugins.list();
    expect(a?.activationError).toContain("语法错误");
    expect(b?.activationError).toContain("activate");
    expect(t.kernel.plugins.loadErrors()).toEqual([]);
  });

  it("坏插件不影响其他插件", async () => {
    const good = createSamplePlugin();
    const t = await createTestKernel({
      plugins: [pluginSource({ id: "bad" }, noop), pluginSource(null, noop, { error: "读不到" }), good.source, createSamplePlugin({ manifest: { id: "org.test.v2", apiVersion: "9", provides: {} } }).source],
    });
    expect(t.kernel.plugins.loadErrors()).toHaveLength(3);
    expect(t.kernel.plugins.list().map((p) => [p.manifest.id, p.state])).toEqual([[SAMPLE_ID, "enabled"]]);
  });

  it("激活结束后不能再注册", async () => {
    const plugin = createSamplePlugin();
    await createTestKernel({ plugins: [plugin.source] });
    expect(() => plugin.host().ui.registerMenuItem({ id: "late", label: "x", action: "hello" })).toThrow(/只能在插件激活时注册/);
  });
});

describe("生命周期", () => {
  it("安装 → 启用 → 激活 → 停用 → 重新启用 → 卸载（外部插件）", async () => {
    const plugin = createSamplePlugin({ origin: "external" });
    const t = await createTestKernel();
    const events: KernelEvent[] = [];
    t.kernel.events.on("plugin.changed", (e) => events.push(e));

    // 安装：外部插件首次发现默认停用，不执行它的代码。
    await t.kernel.plugins.load([plugin.source]);
    expect(t.kernel.plugins.list()).toEqual([expect.objectContaining({ origin: "external", state: "disabled", resourceCount: 0 })]);
    expect(plugin.activations).toBe(0);
    expect(t.kernel.registry.kinds()).toEqual([]);
    expect(t.kernel.registry.kindOwner(SAMPLE_KIND)).toBe(SAMPLE_ID);

    // 启用 → 激活
    await t.kernel.plugins.enable(SAMPLE_ID);
    expect(plugin.activations).toBe(1);
    expect(t.kernel.plugins.list()[0]?.state).toBe("enabled");
    expect(t.kernel.registry.kinds().map((k) => [k.id, k.pluginId])).toEqual([[SAMPLE_KIND, SAMPLE_ID]]);
    expect(t.kernel.registry.kind(SAMPLE_KIND)?.name).toBe("示例");
    expect(t.kernel.registry.actionsFor(SAMPLE_KIND).map((a) => a.id)).toEqual(["echo", "fail", "slow", "wrong", "fill"]);
    expect(t.kernel.registry.action(ECHO)).toEqual({ key: ECHO, pluginId: SAMPLE_ID, id: "echo", label: "回显", kinds: [SAMPLE_KIND], output: "text", isDefaultFor: [SAMPLE_KIND] });
    expect(t.kernel.registry.action(`${SAMPLE_ID}/hello`)).toMatchObject({ kinds: [], isDefaultFor: [] });
    expect(t.kernel.registry.viewsFor(SAMPLE_KIND).map((v) => v.key)).toEqual([`${SAMPLE_ID}/summary`, `${SAMPLE_ID}/broken`, CORE_EDIT_VIEW]);
    expect(t.kernel.registry.menuItems()).toEqual([{ id: "hello", label: "问候", action: "hello", pluginId: SAMPLE_ID, actionKey: `${SAMPLE_ID}/hello` }]);

    const resource = await t.kernel.resources.create({ kind: SAMPLE_KIND, name: "a", body: { url: "https://example.com" } });
    expect(t.kernel.plugins.list()[0]?.resourceCount).toBe(1);

    // 停用：资源保留，动作和视图消失，事件订阅撤销。
    let seen = 0;
    plugin.host().events.on("resource.updated", () => seen++);
    const staleHost = plugin.host();
    await t.kernel.plugins.disable(SAMPLE_ID);
    expect(plugin.deactivations).toBe(1);
    expect(t.kernel.plugins.list()[0]).toMatchObject({ state: "disabled", resourceCount: 1 });
    expect(t.kernel.registry.kinds()).toEqual([]);
    expect(t.kernel.registry.actionsFor(SAMPLE_KIND)).toEqual([]);
    expect(t.kernel.registry.viewsFor(SAMPLE_KIND)).toEqual([]);
    expect(t.kernel.registry.menuItems()).toEqual([]);
    expect(t.kernel.registry.kindOwner(SAMPLE_KIND)).toBe(SAMPLE_ID);
    expect(await t.kernel.resources.get(resource.id)).toEqual(resource);
    expect(await t.kernel.resources.list()).toEqual([]);
    expect(await t.kernel.resources.list({ includeDisabled: true })).toEqual([resource]);
    await t.kernel.resources.update(resource.id, { name: "b" });
    expect(seen).toBe(0);
    await expect(staleHost.resources.list()).rejects.toMatchObject({ code: "unavailable" });
    expect(() => staleHost.notify({ title: "x" })).toThrow(/已停用/);
    expect(await t.kernel.actions.run(ECHO, { resourceId: resource.id, input: { text: "x" } })).toMatchObject({ status: "error", error: { code: "unavailable" } });
    await expect(t.kernel.views.render(`${SAMPLE_ID}/summary`, resource.id)).rejects.toMatchObject({ code: "unavailable" });

    // 重新启用：全部恢复。
    await t.kernel.plugins.enable(SAMPLE_ID);
    expect(plugin.activations).toBe(2);
    expect(t.kernel.registry.actionsFor(SAMPLE_KIND)).toHaveLength(5);
    expect(t.kernel.registry.viewsFor(SAMPLE_KIND)).toHaveLength(3);
    expect(await t.kernel.resources.list()).toHaveLength(1);
    expect(await t.kernel.actions.run(ECHO, { resourceId: resource.id, input: { text: "x" } })).toMatchObject({ status: "success" });

    // 卸载：记录与存储清掉，资源保留，返回它独占声明的密钥。
    await plugin.host().storage.set("k", 1);
    await t.kernel.plugins.setSettings(SAMPLE_ID, { greeting: "hi" });
    expect(await t.kernel.plugins.uninstall(SAMPLE_ID)).toEqual({ declaredSecrets: ["sample_token"] });
    expect(t.kernel.plugins.list()).toEqual([]);
    expect(t.kernel.registry.kindOwner(SAMPLE_KIND)).toBeUndefined();
    expect(t.kernel.registry.kinds()).toEqual([]);
    expect(await t.kernel.resources.get(resource.id)).not.toBeNull();
    expect(t.db.exec("SELECT COUNT(*) FROM plugin_storage")[0]?.values).toEqual([[0]]);
    expect(t.db.exec("SELECT enabled, uninstalled, settings FROM plugins")[0]?.values).toEqual([[0, 1, "{}"]]);
    expect(events.length).toBeGreaterThanOrEqual(5);

    // 再次扫描不会自动装回来（D54）。
    await t.kernel.plugins.load([createSamplePlugin({ origin: "external" }).source]);
    expect(t.kernel.plugins.list()).toEqual([]);
    expect(t.kernel.plugins.loadErrors()).toEqual([]);
  });

  it("内置插件默认启用，不能卸载；启用状态跨重启保留", async () => {
    const t = await createTestKernel({ plugins: [createSamplePlugin().source] });
    expect(t.kernel.plugins.list()[0]?.state).toBe("enabled");
    await expect(t.kernel.plugins.uninstall(SAMPLE_ID)).rejects.toMatchObject({ code: "permission" });
    await t.kernel.plugins.disable(SAMPLE_ID);

    // “重启”：同一个数据库上新建内核。
    const { createKernel } = await import("./index");
    const again = createSamplePlugin();
    const kernel2 = await createKernel({ platform: t.platform });
    await kernel2.plugins.load([again.source]);
    expect(kernel2.plugins.list()[0]?.state).toBe("disabled");
    expect(again.activations).toBe(0);
  });

  it("操作不存在的插件报 not_found", async () => {
    const t = await createTestKernel();
    await expect(t.kernel.plugins.enable("org.test.none")).rejects.toMatchObject({ code: "not_found" });
    await expect(t.kernel.plugins.disable("org.test.none")).rejects.toMatchObject({ code: "not_found" });
    await expect(t.kernel.plugins.uninstall("org.test.none")).rejects.toMatchObject({ code: "not_found" });
    await expect(t.kernel.plugins.getSettings("org.test.none")).rejects.toMatchObject({ code: "not_found" });
  });

  it("deactivate 抛错不妨碍停用", async () => {
    const plugin = createSamplePlugin();
    plugin.module.deactivate = () => {
      throw new Error("boom");
    };
    const t = await createTestKernel({ plugins: [plugin.source] });
    const quiet = console.error;
    console.error = () => undefined;
    await t.kernel.plugins.disable(SAMPLE_ID);
    console.error = quiet;
    expect(t.kernel.plugins.list()[0]?.state).toBe("disabled");
  });

  it("卸载时不返回其他插件也声明的密钥（D53）", async () => {
    const a = createSamplePlugin({ origin: "external" });
    const b = pluginSource({ id: "org.test.other", name: "其他", version: "1.0.0", apiVersion: "1", requires: { secrets: ["sample_token"] } }, noop);
    const t = await createTestKernel({ plugins: [a.source, b] });
    expect(await t.kernel.plugins.uninstall(SAMPLE_ID)).toEqual({ declaredSecrets: [] });
  });
});

describe("插件设置", () => {
  it("默认值、保存、校验、只保留声明的字段", async () => {
    const plugin = createSamplePlugin();
    const t = await createTestKernel({ plugins: [plugin.source] });
    expect(await t.kernel.plugins.getSettings(SAMPLE_ID)).toEqual({ greeting: "你好" });
    expect(await plugin.host().settings.get("greeting")).toBe("你好");
    await t.kernel.plugins.setSettings(SAMPLE_ID, { greeting: "hi", unknown: 1 });
    expect(await t.kernel.plugins.getSettings(SAMPLE_ID)).toEqual({ greeting: "hi" });
    expect(await plugin.host().settings.get("greeting")).toBe("hi");
    await expect(t.kernel.plugins.setSettings(SAMPLE_ID, { greeting: 1 })).rejects.toMatchObject({ code: "validation", fields: { greeting: expect.any(String) } });
    await expect(t.kernel.plugins.setSettings(SAMPLE_ID, null as never)).rejects.toMatchObject({ code: "validation" });
    expect(await t.kernel.plugins.getSettings(SAMPLE_ID)).toEqual({ greeting: "hi" });
  });
});

describe("重新安装已卸载的外部插件（D54/D90）", () => {
  it("卸载后列在 uninstalled()；重新安装后默认停用，启用后恢复，资源一直保留", async () => {
    const plugin = createSamplePlugin({ origin: "external" });
    const t = await createTestKernel({ plugins: [plugin.source] });
    await t.kernel.plugins.enable(SAMPLE_ID);
    const resource = await t.kernel.resources.create({ kind: SAMPLE_KIND, name: "a", body: { url: "https://example.com" } });
    expect(t.kernel.plugins.uninstalled()).toEqual([]);

    await t.kernel.plugins.uninstall(SAMPLE_ID);
    expect(t.kernel.plugins.uninstalled()).toEqual([{ id: SAMPLE_ID, name: "示例", location: plugin.source.location }]);

    const events: KernelEvent[] = [];
    t.kernel.events.on("plugin.changed", (e) => events.push(e));
    await t.kernel.plugins.reinstall(SAMPLE_ID);
    expect(t.kernel.plugins.uninstalled()).toEqual([]);
    expect(t.kernel.plugins.list()).toEqual([expect.objectContaining({ origin: "external", state: "disabled", resourceCount: 1 })]);
    expect(t.kernel.plugins.loadErrors()).toEqual([]);
    expect(t.kernel.registry.kindOwner(SAMPLE_KIND)).toBe(SAMPLE_ID);
    expect(t.kernel.registry.kinds()).toEqual([]);
    expect(plugin.activations).toBe(1); // 重新安装不执行插件代码
    expect(t.db.exec("SELECT enabled, uninstalled FROM plugins")[0]?.values).toEqual([[0, 0]]);
    expect(events).toEqual([{ type: "plugin.changed", pluginId: SAMPLE_ID }]);

    await t.kernel.plugins.enable(SAMPLE_ID);
    expect(plugin.activations).toBe(2);
    expect(await t.kernel.resources.list()).toEqual([resource]);
    await expect(t.kernel.plugins.reinstall(SAMPLE_ID)).rejects.toMatchObject({ code: "not_found" });
  });

  it("重启后（新内核、同一个库）扫描到已卸载的插件：不加载，但可以重新安装", async () => {
    const first = await createTestKernel({ plugins: [createSamplePlugin({ origin: "external" }).source] });
    await first.kernel.plugins.uninstall(SAMPLE_ID);

    const { createKernel } = await import("./index");
    const kernel = await createKernel({ platform: first.platform });
    const again = createSamplePlugin({ origin: "external" });
    await kernel.plugins.load([again.source]);
    expect(kernel.plugins.list()).toEqual([]);
    expect(kernel.plugins.loadErrors()).toEqual([]);
    expect(kernel.plugins.uninstalled()).toEqual([{ id: SAMPLE_ID, name: "示例", location: again.source.location }]);
    expect(kernel.registry.kindOwner(SAMPLE_KIND)).toBeUndefined();

    await kernel.plugins.reinstall(SAMPLE_ID);
    expect(kernel.plugins.list().map((p) => [p.manifest.id, p.state])).toEqual([[SAMPLE_ID, "disabled"]]);
    await kernel.plugins.enable(SAMPLE_ID);
    expect(again.activations).toBe(1);
    // 再“重启”一次：不再被跳过。
    const kernel3 = await createKernel({ platform: first.platform });
    await kernel3.plugins.load([createSamplePlugin({ origin: "external" }).source]);
    expect(kernel3.plugins.list().map((p) => p.state)).toEqual(["enabled"]);
    expect(kernel3.plugins.uninstalled()).toEqual([]);
  });

  it("没有这个已卸载插件时报 not_found；kind 已被别的插件占用时拒绝且保持已卸载", async () => {
    const t = await createTestKernel({ plugins: [createSamplePlugin({ origin: "external" }).source] });
    await expect(t.kernel.plugins.reinstall("org.test.none")).rejects.toMatchObject({ code: "not_found" });
    await expect(t.kernel.plugins.reinstall(SAMPLE_ID)).rejects.toMatchObject({ code: "not_found" }); // 已安装的不算
    await t.kernel.plugins.uninstall(SAMPLE_ID);
    await t.kernel.plugins.load([pluginSource({ ...sampleManifest(), id: "org.test.taker" }, noop)]);
    expect(t.kernel.registry.kindOwner(SAMPLE_KIND)).toBe("org.test.taker");
    await expect(t.kernel.plugins.reinstall(SAMPLE_ID)).rejects.toMatchObject({ code: "conflict", message: expect.stringContaining("org.test.taker") });
    expect(t.kernel.plugins.uninstalled().map((p) => p.id)).toEqual([SAMPLE_ID]);
    expect(t.db.exec("SELECT uninstalled FROM plugins WHERE id = ?", [SAMPLE_ID])[0]?.values).toEqual([[1]]);
  });
});

describe("激活超时", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("activate 10 秒没有完成：记为激活错误，不阻塞后面的插件和启动", async () => {
    const t = await createTestKernel();
    let lateHost: HostApi | undefined;
    const hanging = createSamplePlugin({
      manifest: { id: "org.test.hang", provides: { kinds: ["hang-item"], views: ["late"] } },
      activate: (host) => {
        lateHost = host;
        host.resources.registerKind({ id: "hang-item", name: "卡住", schema: [], views: [], describe: () => ({ summary: "", usage: "" }) });
        return new Promise<void>(() => undefined);
      },
    });
    const good = createSamplePlugin();

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let done = false;
    const loading = t.kernel.plugins.load([hanging.source, good.source]).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(ACTIVATION_TIMEOUT_MS - 1);
    expect(done).toBe(false);
    expect(good.activations).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    await loading;
    vi.useRealTimers();

    expect(ACTIVATION_TIMEOUT_MS).toBe(10_000);
    const [hung, ok] = t.kernel.plugins.list();
    expect(hung).toMatchObject({ state: "disabled", activationError: "激活失败：超过 10 秒没有完成" });
    expect(ok).toMatchObject({ state: "enabled" });
    expect(ok?.activationError).toBeUndefined();
    expect(t.kernel.plugins.loadErrors()).toEqual([]);
    // 超时前注册的内容不生效；超时后宿主接口已撤销，迟到的注册和调用都被拒绝。
    expect(t.kernel.registry.kind("hang-item")).toBeUndefined();
    expect(t.kernel.registry.kinds().map((k) => k.id)).toEqual([SAMPLE_KIND]);
    expect(() => lateHost!.ui.registerView({ id: "late", label: "x", render: () => [] })).toThrow(/已停用/);
    await expect(lateHost!.storage.set("k", 1)).rejects.toMatchObject({ code: "unavailable" });
  });

  it("超时后才失败的 activate 不会产生未处理的异常；按时完成的不受计时器影响", async () => {
    const t = await createTestKernel();
    let fail: ((e: Error) => void) | undefined;
    const slow = createSamplePlugin({
      manifest: { id: "org.test.slow", provides: {} },
      activate: () =>
        new Promise<void>((_resolve, reject) => {
          fail = reject;
        }),
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const loading = t.kernel.plugins.load([slow.source, createSamplePlugin().source]);
    await vi.advanceTimersByTimeAsync(ACTIVATION_TIMEOUT_MS);
    await loading;
    fail?.(new Error("迟到的失败"));
    await vi.advanceTimersByTimeAsync(ACTIVATION_TIMEOUT_MS);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
    expect(t.kernel.plugins.list().map((p) => [p.manifest.id, p.state])).toEqual([["org.test.slow", "disabled"], [SAMPLE_ID, "enabled"]]);
  });
});
