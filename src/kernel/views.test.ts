import { beforeEach, describe, expect, it } from "vitest";
import { CORE_EDIT_VIEW } from "./contracts";
import { createTestKernel } from "./testing";
import type { TestKernel } from "./testing";
import { SAMPLE_ID, SAMPLE_KIND, createSamplePlugin } from "./testing/sample";

const SUMMARY = `${SAMPLE_ID}/summary`;
const BROKEN = `${SAMPLE_ID}/broken`;
let t: TestKernel;

beforeEach(async () => {
  t = await createTestKernel({ plugins: [createSamplePlugin().source] });
});

const add = (name: string) => t.kernel.resources.create({ kind: SAMPLE_KIND, name, body: { url: "https://example.com" } });

describe("视图渲染与校验", () => {
  it("返回校验后的节点数组，补全默认值", async () => {
    const r = await add("首页");
    expect(await t.kernel.views.render(SUMMARY, r.id)).toEqual([
      { type: "text", text: "首页 r1", format: "plain" },
      { type: "form", fields: [{ label: "上次结果", value: null }] },
    ]);
  });

  it("ViewState：资源或动作结果变化时 revision 递增，并带上最近一次结果", async () => {
    const r = await add("首页");
    await t.kernel.resources.update(r.id, { name: "新首页" });
    expect((await t.kernel.views.render(SUMMARY, r.id))[0]).toMatchObject({ text: "新首页 r2" });
    await t.kernel.actions.run(`${SAMPLE_ID}/fail`, { resourceId: r.id });
    expect(await t.kernel.views.render(SUMMARY, r.id)).toMatchObject([{ text: "新首页 r3" }, { fields: [{ value: "error" }] }]);
  });

  it("单个节点也归一成数组", async () => {
    const single = createSamplePlugin({
      manifest: { id: "org.test.single", provides: { kinds: ["single"], views: ["one", "async"] } },
      activate: (host) => {
        host.resources.registerKind({ id: "single", name: "单个", schema: [], views: ["one", "async"], describe: () => ({ summary: "", usage: "" }) });
        host.ui.registerView({ id: "one", label: "一", render: () => ({ type: "link", href: "https://example.com", text: "打开" }) });
        host.ui.registerView({ id: "async", label: "二", render: async () => ({ type: "table", columns: [{ key: "a", label: "A" }], rows: [{ a: 1 }] }) });
      },
    });
    await t.kernel.plugins.load([single.source]);
    const r = await t.kernel.resources.create({ kind: "single", name: "x" });
    expect(await t.kernel.views.render("org.test.single/one", r.id)).toEqual([{ type: "link", href: "https://example.com", text: "打开" }]);
    expect(await t.kernel.views.render("org.test.single/async", r.id)).toEqual([{ type: "table", columns: [{ key: "a", label: "A" }], rows: [{ a: 1 }] }]);
    // 视图不能用在别的插件的 kind 上（D60）。
    const sample = await add("首页");
    await expect(t.kernel.views.render("org.test.single/one", sample.id)).rejects.toMatchObject({ code: "validation" });
  });

  it("视图树不合法（危险链接）时拒绝", async () => {
    const r = await add("首页");
    await expect(t.kernel.views.render(BROKEN, r.id)).rejects.toMatchObject({ code: "validation", message: expect.stringContaining("视图内容不正确") });
  });

  it("render 抛错时转为 internal 错误", async () => {
    const r = await add("抛错");
    await expect(t.kernel.views.render(BROKEN, r.id)).rejects.toMatchObject({ code: "internal", message: "视图渲染失败：渲染出错" });
  });

  it("未知视图、未知资源、编辑视图", async () => {
    const r = await add("首页");
    await expect(t.kernel.views.render(`${SAMPLE_ID}/nope`, r.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(t.kernel.views.render(SUMMARY, "nope")).rejects.toMatchObject({ code: "not_found" });
    await expect(t.kernel.views.render(CORE_EDIT_VIEW, r.id)).rejects.toMatchObject({ code: "not_implemented" });
  });
});
