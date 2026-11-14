// @vitest-environment jsdom
/** Regression tests for the issues found in the independent review of the shell. */
import "../design/testing/jsdom-setup";
import { act, configure, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Kernel } from "../kernel/contracts";
import { createTestKernel, type TestKernel } from "../kernel/testing";
import type { ActionResult, NetworkResponse } from "../plugin-api";
import { builtinPluginSources } from "../plugins";
import { ActionResultPanel, outputSummary } from "./action-ui";
import { App } from "./app";
import { KIND_CACHE_PREF, rememberKinds } from "./kind-cache";
import type { Route } from "./shell-context";
import type { ShellServices } from "./services";

configure({ asyncUtilTimeout: 10_000 });
const SLOW = { timeout: 30_000 };

const response: NetworkResponse = { status: 200, statusText: "OK", headers: {}, body: "{}", durationMs: 1 };

function services(t: TestKernel): ShellServices {
  return {
    mode: "browser",
    status: () => t.platform.app.status(),
    openExternal: async () => {},
    pickFolder: async () => null,
    exportWrite: async () => "",
    importRead: async () => ({ resources: "[]", collections: "[]", manifest: "{}" }),
  };
}

function renderApp(t: TestKernel, kernel: Kernel = t.kernel, initialRoute?: Route) {
  return render(<App kernel={kernel} services={services(t)} initialTheme="light" initialDensity="comfortable" initialRoute={initialRoute} />);
}

const nav = () => screen.getByRole("navigation", { name: "资源目录" });

describe("评审修复", SLOW, () => {
  it("阻断 1：资源页上启用插件后不显示“有未保存的修改”，导航不被拦截", async () => {
    const t = await createTestKernel({ plugins: builtinPluginSources() });
    const r = await t.kernel.resources.create({ kind: "link", name: "官网", body: { url: "https://example.com" } });
    await t.kernel.plugins.disable("org.onedesk.link");
    renderApp(t, t.kernel, { page: "resource", id: r.id });
    const enable = await screen.findByRole("button", { name: "启用插件" });
    fireEvent.click(enable);
    expect(await screen.findByRole("tab", { name: "详情" })).toBeInTheDocument();
    await act(async () => {
      await new Promise((r2) => setTimeout(r2, 50));
    });
    expect(screen.queryByText("有未保存的修改")).toBeNull();
    fireEvent.click(within(nav()).getByRole("button", { name: "全部资源" }));
    expect(await screen.findByRole("heading", { level: 1, name: "全部资源" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("阻断 1：真正编辑过才算未保存", async () => {
    const t = await createTestKernel({ plugins: builtinPluginSources() });
    const r = await t.kernel.resources.create({ kind: "link", name: "官网", body: { url: "https://example.com" } });
    renderApp(t, t.kernel, { page: "resource", id: r.id, tab: "core/edit" });
    const name = await screen.findByLabelText(/^名称/);
    expect(screen.queryByText("有未保存的修改")).toBeNull();
    fireEvent.change(name, { target: { value: "官网 2" } });
    expect(await screen.findByText("有未保存的修改")).toBeInTheDocument();
    fireEvent.change(name, { target: { value: "官网" } });
    await waitFor(() => expect(screen.queryByText("有未保存的修改")).toBeNull());
  });

  it("阻断 2：命令面板按正文和标签都能找到资源（结果集变化后不被 cmdk 过滤掉）", async () => {
    const t = await createTestKernel({ plugins: builtinPluginSources() });
    await t.kernel.resources.create({ kind: "note", name: "周会记录", tags: ["例会"], body: { content: "讨论了季度目标" } });
    await t.kernel.resources.create({ kind: "link", name: "官网", body: { url: "https://example.com" } });
    renderApp(t);
    await within(await screen.findByRole("navigation", { name: "资源目录" })).findByRole("button", { name: "周会记录" });
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const input = await screen.findByPlaceholderText("搜索资源、动作、页面…");
    for (const query of ["季度目标", "例会"]) {
      fireEvent.change(input, { target: { value: query } });
      const option = await screen.findByRole("option", { name: /周会记录/ });
      expect(option).toBeInTheDocument();
      expect(screen.queryByRole("option", { name: /官网/ })).toBeNull();
    }
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByRole("heading", { level: 1, name: "周会记录" })).toBeInTheDocument();
  });

  it("⌘K 不会叠在其他对话框上；面板打开时 ⌘K 关闭它", async () => {
    const t = await createTestKernel({ plugins: builtinPluginSources() });
    renderApp(t);
    await screen.findByRole("navigation", { name: "资源目录" });
    fireEvent.keyDown(window, { key: "n", metaKey: true });
    await screen.findByRole("dialog", { name: "新建资源" });
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(screen.queryByPlaceholderText("搜索资源、动作、页面…")).toBeNull();
    fireEvent.keyDown(document.activeElement ?? window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    await screen.findByPlaceholderText("搜索资源、动作、页面…");
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    await waitFor(() => expect(screen.queryByPlaceholderText("搜索资源、动作、页面…")).toBeNull());
  });

  it("命令面板：当前资源有动作在运行时，它的动作项禁用", async () => {
    let release: (v: NetworkResponse) => void = () => {};
    const t = await createTestKernel({ plugins: builtinPluginSources(), fetch: () => new Promise((r) => (release = r)) });
    const r = await t.kernel.resources.create({ kind: "http-request", name: "接口", body: { method: "GET", url: "https://a.com" } });
    renderApp(t, t.kernel, { page: "resource", id: r.id });
    fireEvent.click(await screen.findByRole("button", { name: "发送" }));
    await screen.findByText("取消运行");
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const item = await screen.findByRole("option", { name: /发送/ });
    expect(item).toHaveAttribute("aria-disabled", "true");
    await act(async () => release(response));
  });

  it("侧栏删除：确认后有成功提示；删除失败显示原因", async () => {
    const t = await createTestKernel({ plugins: builtinPluginSources() });
    await t.kernel.resources.create({ kind: "link", name: "官网", body: { url: "https://example.com" } });
    await t.kernel.resources.create({ kind: "link", name: "坏的", body: { url: "https://example.com" } });
    const kernel: Kernel = {
      ...t.kernel,
      resources: {
        ...t.kernel.resources,
        delete: async (id) => {
          const res = await t.kernel.resources.get(id);
          if (res?.name === "坏的") throw new Error("数据库忙");
          return t.kernel.resources.delete(id);
        },
      },
    };
    renderApp(t, kernel);
    for (const [name, expected] of [
      ["官网", "已删除“官网”"],
      ["坏的", "无法删除“坏的”"],
    ] as const) {
      fireEvent.keyDown(await within(nav()).findByRole("button", { name: `“${name}”的操作` }), { key: "Enter" });
      fireEvent.click(await screen.findByRole("menuitem", { name: "删除" }));
      const dialog = await screen.findByRole("dialog", { name: `删除“${name}”？` });
      fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));
      expect(await screen.findByText(expected)).toBeInTheDocument();
    }
    expect(await screen.findByText("数据库忙")).toBeInTheDocument();
  });

  it("侧栏加载失败：错误状态 + 重试", async () => {
    const t = await createTestKernel({ plugins: builtinPluginSources() });
    let fail = true;
    const kernel: Kernel = {
      ...t.kernel,
      resources: {
        ...t.kernel.resources,
        list: async (q) => {
          if (fail) throw new Error("读取失败");
          return t.kernel.resources.list(q);
        },
      },
    };
    renderApp(t, kernel);
    expect(await within(await screen.findByRole("navigation", { name: "资源目录" })).findByText("菜单加载失败")).toBeInTheDocument();
    fail = false;
    fireEvent.click(within(nav()).getByRole("button", { name: "重试" }));
    await waitFor(() => expect(within(nav()).queryByText("菜单加载失败")).toBeNull());
  });

  it("灰色行：停用插件的资源名称不被 Text 的颜色覆盖", async () => {
    const t = await createTestKernel({ plugins: builtinPluginSources() });
    await t.kernel.resources.create({ kind: "link", name: "官网", body: { url: "https://example.com" } });
    await t.kernel.plugins.disable("org.onedesk.link");
    renderApp(t);
    const cell = await screen.findByText("官网", { selector: "td span" });
    expect(cell.closest("tr")).toHaveClass("od-table__row--muted");
    expect(cell.className).toBe("");
  });

  it("插件页：没有设置项的插件不显示“设置”按钮", async () => {
    const t = await createTestKernel({ plugins: builtinPluginSources() });
    renderApp(t, t.kernel, { page: "plugins" });
    const table = await screen.findByRole("table", { name: "插件列表" });
    expect(within(table).getAllByRole("button", { name: /的设置$/ })).toHaveLength(1); // only HTTP 请求 has settings
  });

  it("停用插件的资源：只读数据用记住的字段名；没有记录时显示原始键名并说明", async () => {
    const t = await createTestKernel({ plugins: builtinPluginSources() });
    const r = await t.kernel.resources.create({ kind: "link", name: "官网", body: { url: "https://example.com" } });
    await rememberKinds(t.kernel);
    await t.kernel.plugins.disable("org.onedesk.link");
    const view = renderApp(t, t.kernel, { page: "resource", id: r.id });
    expect(await screen.findByText("网址", { selector: "dt" })).toBeInTheDocument();
    view.unmount();
    await t.kernel.prefs.set(KIND_CACHE_PREF, {});
    // App re-remembers only registered kinds; link is disabled, so its labels stay unknown.
    renderApp(t, t.kernel, { page: "resource", id: r.id });
    expect(await screen.findByText("url", { selector: "dt" })).toHaveClass("od-mono");
    expect(screen.getByText("插件不可用，无法读取字段名称，以下显示原始键名。")).toBeInTheDocument();
  });
});

describe("结果面板（compact）", () => {
  const result: ActionResult = {
    runId: "r1",
    status: "success",
    output: { type: "text", format: "code", text: "200 OK\n" + "x".repeat(50) },
    durationMs: 3,
    action: "p/a",
    finishedAt: "2026-01-01T00:00:00.000Z",
  };

  it("资源有插件视图时只显示状态行，可展开完整输出", () => {
    render(<ActionResultPanel label="发送" result={result} compact onCancel={() => {}} onDismiss={() => {}} onOpenLink={() => {}} />);
    expect(screen.getByText("200 OK")).toBeInTheDocument();
    expect(document.querySelector("pre")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "显示完整输出" }));
    expect(document.querySelector("pre")?.textContent).toContain("x".repeat(50));
  });

  it("摘要：message 优先，其次第一行、行数、链接、文件名", () => {
    expect(outputSummary({ type: "text", format: "plain", text: "\n\n第一行\n第二行" })).toBe("第一行");
    expect(outputSummary({ type: "text", format: "plain", text: "x", message: "消息" })).toBe("消息");
    expect(outputSummary({ type: "table", columns: [], rows: [{}, {}] })).toBe("共 2 行");
    expect(outputSummary({ type: "file", name: "a.txt", content: "" })).toBe("文件：a.txt");
  });
});
