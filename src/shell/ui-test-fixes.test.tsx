// @vitest-environment jsdom
/** Regression tests for the issues found by the end-to-end UI tests (round 3). */
import "../design/testing/jsdom-setup";
import { configure, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestKernel, type TestKernel } from "../kernel/testing";
import { builtinPluginSources } from "../plugins";
import { App } from "./app";
import { t } from "./i18n";
import type { Route } from "./shell-context";
import type { ShellServices } from "./services";

configure({ asyncUtilTimeout: 10_000 });

function services(tk: TestKernel): ShellServices {
  return {
    mode: "browser",
    status: () => tk.platform.app.status(),
    openExternal: async () => {},
    pickFolder: async () => null,
    exportWrite: async () => "",
    importRead: async () => ({ resources: "[]", collections: "[]", manifest: "{}" }),
  };
}

function renderApp(tk: TestKernel, initialRoute?: Route) {
  return render(<App kernel={tk.kernel} services={services(tk)} initialTheme="light" initialDensity="comfortable" initialRoute={initialRoute} />);
}

afterEach(() => vi.restoreAllMocks());

describe("界面测试发现的问题", { timeout: 30_000 }, () => {
  it("笔记中的 # 标题不再是第二个 h1", async () => {
    const tk = await createTestKernel({ plugins: builtinPluginSources() });
    const r = await tk.kernel.resources.create({ kind: "note", name: "读书笔记", body: { content: "# 读书笔记\n\n正文" } });
    renderApp(tk, { page: "resource", id: r.id });
    await screen.findByText("正文");
    expect(screen.getAllByRole("heading", { level: 1 }).map((h) => h.textContent)).toEqual(["读书笔记"]);
    expect(screen.getByRole("heading", { level: 2, name: "读书笔记" })).toBeInTheDocument();
  });

  it("设置页列出每个加载失败插件的原因（G.4、D135），并可前往插件页", async () => {
    const broken = { origin: "external" as const, location: "/plugins/broken", manifest: { id: "Not A Valid Id" }, load: async () => ({ activate() {} }) };
    const tk = await createTestKernel({ plugins: [...builtinPluginSources(), broken] });
    renderApp(tk, { page: "settings" });
    expect(await screen.findByText(t("settings.pluginErrorsSome", { count: 1 }))).toBeInTheDocument();
    const table = screen.getByRole("table", { name: t("plugins.errorsTitle") });
    expect(within(table).getByText(/\/plugins\/broken/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("link", { name: t("settings.gotoPlugins") }));
    expect(await screen.findByRole("heading", { level: 1, name: t("plugins.title") })).toBeInTheDocument();
  });

  it("没有加载错误时设置页只显示一行说明", async () => {
    const tk = await createTestKernel({ plugins: builtinPluginSources() });
    renderApp(tk, { page: "settings" });
    expect(await screen.findByText(t("settings.pluginErrorsNone"))).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: t("plugins.errorsTitle") })).toBeNull();
  });

  it("新建集合：切换规则和选择值时没有受控/非受控警告；空集合文案简短；删除集合是次要按钮", async () => {
    const errors = vi.spyOn(console, "error");
    const tk = await createTestKernel({ plugins: builtinPluginSources() });
    renderApp(tk, { page: "collections" });
    fireEvent.click(await screen.findByRole("button", { name: t("collections.new") }));
    const dialog = await screen.findByRole("dialog", { name: t("collections.new") });
    fireEvent.change(within(dialog).getByRole("textbox", { name: new RegExp(t("collections.name")) }), { target: { value: "空集合" } });
    const ruleType = within(dialog).getByRole("combobox", { name: t("collections.ruleType") });
    fireEvent.keyDown(ruleType, { key: "Enter" });
    fireEvent.click(await screen.findByRole("option", { name: t("collections.rule.kind") }));
    const value = within(dialog).getByRole("combobox", { name: new RegExp(t("collections.ruleKindValue")) });
    fireEvent.keyDown(value, { key: "Enter" });
    fireEvent.click(await screen.findByRole("option", { name: "笔记" }));
    fireEvent.click(within(dialog).getByRole("button", { name: t("common.create") }));
    expect(await screen.findByText(t("collections.itemsEmpty"))).toBeInTheDocument();
    expect(t("collections.itemsEmpty").length).toBeLessThanOrEqual(12);
    const del = screen.getByRole("button", { name: t("collections.delete") });
    expect(del).toHaveClass("od-button--secondary");
    expect(errors.mock.calls.flat().join(" ")).not.toMatch(/uncontrolled|controlled/);
  });

  it("命令面板的结果列表用中文名称", async () => {
    const tk = await createTestKernel({ plugins: builtinPluginSources() });
    renderApp(tk);
    await screen.findByRole("navigation", { name: t("app.sidebarLabel") });
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(await screen.findByRole("listbox", { name: t("palette.listLabel") })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("listbox", { name: "Suggestions" })).toBeNull());
  });
});
