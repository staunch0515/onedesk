// @vitest-environment jsdom
/**
 * Integration with the real kernel and the four built-in plugins: create (via the schema form model) → open each
 * view (rendered by the shell's view-tree renderer) → run the actions. Plus a smoke test of the whole App.
 */
import "../design/testing/jsdom-setup";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CORE_EDIT_VIEW } from "../kernel/contracts";
import { createTestKernel, type TestKernel } from "../kernel/testing";
import type { NetworkResponse } from "../plugin-api";
import { builtinPluginSources } from "../plugins";
import { App } from "./app";
import { initialValues, valuesToData, valuesToInput, type FormValues } from "./schema-form";
import type { ShellServices } from "./services";
import { ViewTree } from "./view-tree";

const response: NetworkResponse = { status: 200, statusText: "OK", headers: { "content-type": "application/json" }, body: '{"ok":true}', durationMs: 5 };

async function kernelWithPlugins(): Promise<TestKernel> {
  return createTestKernel({ plugins: builtinPluginSources(), fetch: async () => response });
}

function services(t: TestKernel): ShellServices {
  return {
    mode: "browser",
    status: () => t.platform.app.status(),
    openExternal: (url) => t.platform.system.openExternal(url),
    pickFolder: async () => null,
    exportWrite: async () => "",
    importRead: async () => ({ resources: "[]", collections: "[]", manifest: "{}" }),
  };
}

/** Builds a body the way the edit form does: editing values → stored values. */
function bodyFor(t: TestKernel, kind: string, edits: FormValues): Record<string, unknown> {
  const schema = t.kernel.registry.kind(kind)!.schema;
  return valuesToData(schema, { ...initialValues(schema, {}, true), ...edits });
}

async function renderViews(t: TestKernel, id: string, kind: string) {
  for (const view of t.kernel.registry.viewsFor(kind)) {
    if (view.key === CORE_EDIT_VIEW) continue;
    const nodes = await t.kernel.views.render(view.key, id);
    const { unmount, container } = render(<ViewTree nodes={nodes} onOpenLink={() => {}} />);
    expect(container.textContent?.length).toBeGreaterThan(0);
    unmount();
  }
}

describe("四个内置插件：创建 → 打开视图 → 运行动作", () => {
  it("网址：打开", async () => {
    const t = await kernelWithPlugins();
    const r = await t.kernel.resources.create({ kind: "link", name: "官网", body: bodyFor(t, "link", { url: "https://example.com" }) });
    await renderViews(t, r.id, "link");
    const [open] = t.kernel.registry.actionsFor("link");
    expect(open?.isDefaultFor).toContain("link");
    const result = await t.kernel.actions.run(open!.key, { resourceId: r.id });
    expect(result.status).toBe("success");
    expect(t.opened).toEqual(["https://example.com"]);
  });

  it("笔记：markdown 视图，没有动作", async () => {
    const t = await kernelWithPlugins();
    const r = await t.kernel.resources.create({ kind: "note", name: "笔记", body: bodyFor(t, "note", { content: "# 标题" }) });
    expect(t.kernel.registry.actionsFor("note")).toEqual([]);
    const nodes = await t.kernel.views.render(t.kernel.registry.viewsFor("note")[0]!.key, r.id);
    render(<ViewTree nodes={nodes} onOpenLink={() => {}} />);
    expect(screen.getByRole("heading", { name: "标题" })).toBeInTheDocument();
  });

  it("提示词：参数编辑器的值 → 输入表单 → 复制", async () => {
    const t = await kernelWithPlugins();
    const body = bodyFor(t, "prompt", {
      template: "你好 {{who}}，{{tone}}",
      parameters: [
        { name: "who", label: "对象", default: "", required: true },
        { name: "tone", label: "语气", default: "简洁", required: false },
      ],
    });
    const r = await t.kernel.resources.create({ kind: "prompt", name: "问候", body });
    await renderViews(t, r.id, "prompt");
    const [copy] = t.kernel.registry.actionsFor("prompt");
    const fields = t.kernel.actions.inputFields(copy!.key, r);
    expect(fields.map((f) => [f.name, f.required === true])).toEqual([
      ["who", true],
      ["tone", false],
    ]);
    const values = { ...initialValues(fields, {}, true), who: "世界" };
    const result = await t.kernel.actions.run(copy!.key, { resourceId: r.id, input: valuesToInput(fields, values) });
    expect(result.status).toBe("success");
    expect(t.copied).toEqual(["你好 世界，简洁"]);
  });

  it("HTTP 请求：发送并在响应视图中看到结果；网络失败是失败结果", async () => {
    const t = await kernelWithPlugins();
    const r = await t.kernel.resources.create({ kind: "http-request", name: "接口", body: bodyFor(t, "http-request", { method: "GET", url: "https://api.example.com/x" }) });
    const [send] = t.kernel.registry.actionsFor("http-request");
    const ok = await t.kernel.actions.run(send!.key, { resourceId: r.id });
    expect(ok.status).toBe("success");
    expect(t.requests[0]?.url).toBe("https://api.example.com/x");
    const nodes = await t.kernel.views.render(t.kernel.registry.viewsFor("http-request")[0]!.key, r.id);
    render(<ViewTree nodes={nodes} onOpenLink={() => {}} />);
    expect(screen.getByText("content-type")).toBeInTheDocument();

    const offline = await createTestKernel({ plugins: builtinPluginSources() });
    const r2 = await offline.kernel.resources.create({ kind: "http-request", name: "接口", body: { method: "GET", url: "https://api.example.com/x" } });
    const failed = await offline.kernel.actions.run(send!.key, { resourceId: r2.id });
    expect(failed.status).toBe("error");
    expect(failed.error?.message).toBeTruthy();
  });
});

describe("应用外壳（真实内核）", () => {
  it("菜单列出资源；打开资源、运行默认动作看到结果；停用插件后菜单项消失、启用后恢复", async () => {
    const t = await kernelWithPlugins();
    await t.kernel.resources.create({ kind: "link", name: "官网", group: "工作", body: { url: "https://example.com" } });
    await t.kernel.resources.create({ kind: "http-request", name: "接口", group: "工作", body: { method: "GET", url: "https://api.example.com" } });
    render(<App kernel={t.kernel} services={services(t)} initialTheme="light" initialDensity="comfortable" />);

    const nav = await screen.findByRole("navigation", { name: "资源目录" });
    const linkItem = await within(nav).findByRole("button", { name: "官网" });
    expect(within(nav).getByRole("button", { name: "接口" })).toBeInTheDocument();
    expect(within(nav).getByText("工作")).toBeInTheDocument();

    fireEvent.click(linkItem);
    expect(await screen.findByRole("heading", { level: 1, name: "官网" })).toBeInTheDocument();
    const tabs = screen.getByRole("tablist", { name: "视图" });
    expect(within(tabs).getAllByRole("tab").map((x) => x.textContent)).toEqual(["详情", "编辑"]);

    fireEvent.click(screen.getByRole("button", { name: "打开" }));
    expect(await screen.findByText("“打开”已完成")).toBeInTheDocument();
    expect(t.opened).toEqual(["https://example.com"]);

    await act(() => t.kernel.plugins.disable("org.onedesk.http-request"));
    await waitFor(() => expect(within(nav).queryByRole("button", { name: "接口" })).toBeNull());
    expect((await t.kernel.resources.list({ includeDisabled: true })).map((r) => r.name)).toContain("接口");
    await act(() => t.kernel.plugins.enable("org.onedesk.http-request"));
    expect(await within(nav).findByRole("button", { name: "接口" })).toBeInTheDocument();
  });

  it("数据不符合字段定义的资源：菜单中灰色 + 警示图标，资源页提示要修正的字段", async () => {
    const t = await kernelWithPlugins();
    const r = await t.kernel.resources.create({ kind: "link", name: "坏网址", body: { url: "https://example.com" } });
    // Imported or older data can violate the schema (D62); simulate it below the kernel.
    t.db.run("UPDATE resources SET body = ? WHERE id = ?", ['{"url":"not a url"}', r.id]);
    render(<App kernel={t.kernel} services={services(t)} initialTheme="light" initialDensity="comfortable" />);
    const nav = await screen.findByRole("navigation", { name: "资源目录" });
    const item = await within(nav).findByRole("button", { name: "坏网址" });
    expect(item).toHaveAttribute("aria-disabled", "true");
    expect(within(nav).getByRole("img", { name: /数据不符合字段定义/ })).toBeInTheDocument();
    fireEvent.click(item);
    expect(await screen.findByText("在“编辑”中修正以下字段：网址")).toBeInTheDocument();
  });

  it("编辑：字段级错误；有未保存的修改时离开要确认", async () => {
    const t = await kernelWithPlugins();
    const r = await t.kernel.resources.create({ kind: "link", name: "官网", body: { url: "https://example.com" } });
    render(<App kernel={t.kernel} services={services(t)} initialTheme="light" initialDensity="comfortable" initialRoute={{ page: "resource", id: r.id, tab: CORE_EDIT_VIEW }} />);
    const url = await screen.findByLabelText(/^网址/);
    fireEvent.change(url, { target: { value: "javascript:alert(1)" } });
    fireEvent.click(screen.getAllByRole("button", { name: "保存" })[0]!);
    expect(await screen.findByText(/网址必须以/)).toBeInTheDocument();
    expect((await t.kernel.resources.get(r.id))?.body.url).toBe("https://example.com");

    fireEvent.click(within(screen.getByRole("navigation", { name: "资源目录" })).getByRole("button", { name: "全部资源" }));
    const dialog = await screen.findByRole("dialog", { name: "放弃未保存的修改？" });
    fireEvent.click(within(dialog).getByRole("button", { name: "继续编辑" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("heading", { level: 1, name: "官网" })).toBeInTheDocument();
  });
});
