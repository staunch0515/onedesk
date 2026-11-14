import { beforeEach, describe, expect, it } from "vitest";
import type { Resource } from "../plugin-api";
import type { KernelEvent } from "./contracts";
import { createTestKernel } from "./testing";
import type { TestKernel } from "./testing";
import { SAMPLE_ID, SAMPLE_KIND, createSamplePlugin } from "./testing/sample";

let source: TestKernel;

beforeEach(async () => {
  const plugin = createSamplePlugin();
  source = await createTestKernel({ plugins: [plugin.source], secrets: { sample_token: "TOP-SECRET-VALUE" } });
  await source.kernel.resources.create({ kind: SAMPLE_KIND, name: "一", tags: ["工作"], body: { url: "https://example.com/1" } });
  await source.kernel.resources.create({ kind: SAMPLE_KIND, name: "二", description: "第二个", body: { url: "https://example.com/2", note: "正文" } });
  await source.kernel.collections.create({ name: "工作", rule: { type: "tag", value: "工作" } });
  await source.kernel.plugins.setSettings(SAMPLE_ID, { greeting: "hi" });
  await plugin.host().storage.set("last", { ok: true });
});

/** What the shell does: write each part as JSON text, read it back as text. */
async function exportedFiles(t: TestKernel) {
  const bundle = await t.kernel.data.exportAll();
  return { bundle, files: { resources: JSON.stringify(bundle.resources), collections: JSON.stringify(bundle.collections), manifest: JSON.stringify(bundle.manifest) } };
}

describe("导出", () => {
  it("包含资源、集合、插件状态与存储、清单；不含密钥", async () => {
    const { bundle } = await exportedFiles(source);
    expect(bundle.manifest).toMatchObject({ app: "onedesk", formatVersion: 1, schemaVersion: 1, counts: { resources: 2, collections: 1 } });
    expect(Date.parse(bundle.manifest.exportedAt)).not.toBeNaN();
    expect(bundle.resources.map((r) => r.name).sort()).toEqual(["一", "二"]);
    expect(bundle.collections).toHaveLength(1);
    expect(bundle.plugins).toEqual([{ id: SAMPLE_ID, enabled: true, settings: { greeting: "hi" }, storage: { last: { ok: true } } }]);
    expect(JSON.stringify(bundle)).not.toContain("TOP-SECRET-VALUE");
  });

  it("停用插件的资源也导出", async () => {
    await source.kernel.plugins.disable(SAMPLE_ID);
    const { bundle } = await exportedFiles(source);
    expect(bundle.resources).toHaveLength(2);
    expect(bundle.plugins[0]?.enabled).toBe(false);
  });
});

describe("导入", () => {
  it("导入到空库：保留 id、版本、时间戳；未知 kind 也导入；可搜索", async () => {
    const { bundle, files } = await exportedFiles(source);
    const target = await createTestKernel(); // 没有任何插件：kind 未知
    const events: KernelEvent[] = [];
    target.kernel.events.onAny((e) => events.push(e));
    const plan = await target.kernel.data.planImport(files);
    expect(plan.newResources).toHaveLength(2);
    expect(plan.conflicts).toEqual([]);
    expect(plan.newCollections).toHaveLength(1);
    expect(await target.kernel.data.applyImport(plan, () => "skip")).toEqual({ created: 3, overwritten: 0, skipped: 0 });

    const imported = await target.kernel.resources.list({ includeDisabled: true });
    expect(imported).toEqual(await source.kernel.resources.list());
    expect(await target.kernel.collections.list()).toEqual(bundle.collections);
    expect(await target.kernel.search("正文", { includeDisabled: true })).toHaveLength(1);
    expect(events.filter((e) => e.type === "resource.created")).toHaveLength(2);
    expect(events.filter((e) => e.type === "collection.changed")).toHaveLength(1);
    // 插件状态、设置、存储只导出不导入。
    expect(target.db.exec("SELECT COUNT(*) FROM plugins")[0]?.values).toEqual([[0]]);

    // 装上插件后资源计数正确（计数在导入后刷新）。
    await target.kernel.plugins.load([createSamplePlugin().source]);
    expect(target.kernel.plugins.list()[0]?.resourceCount).toBe(2);
  });

  it("相同 id：按决定覆盖或跳过", async () => {
    const { files } = await exportedFiles(source);
    const [first, second] = (await source.kernel.resources.list()).reverse() as [Resource, Resource];
    const [collection] = await source.kernel.collections.list();
    // 导出之后本地又改了两条资源和集合，并新增一条。
    await source.kernel.resources.update(first.id, { name: "一（本地改）" });
    await source.kernel.resources.update(second.id, { name: "二（本地改）" });
    await source.kernel.collections.update(collection!.id, { name: "本地集合名" });
    const extra = await source.kernel.resources.create({ kind: SAMPLE_KIND, name: "三", body: { url: "https://example.com/3" } });

    const plan = await source.kernel.data.planImport(files);
    expect(plan.newResources).toEqual([]);
    expect(plan.conflicts.map((c) => [c.incoming.name, c.existing.name])).toEqual(expect.arrayContaining([["一", "一（本地改）"], ["二", "二（本地改）"]]));
    expect(plan.collectionConflicts).toHaveLength(1);

    const events: KernelEvent[] = [];
    source.kernel.events.onAny((e) => events.push(e));
    const asked: string[] = [];
    const result = await source.kernel.data.applyImport(plan, (conflict) => {
      asked.push(`${conflict.type}:${conflict.id}`);
      return conflict.id === first.id ? "overwrite" : "skip";
    });
    expect(result).toEqual({ created: 0, overwritten: 1, skipped: 2 });
    expect(asked.sort()).toEqual([`collection:${collection!.id}`, `resource:${first.id}`, `resource:${second.id}`].sort());

    expect(await source.kernel.resources.get(first.id)).toEqual(first); // 覆盖：回到导出时的内容和版本
    expect((await source.kernel.resources.get(second.id))?.name).toBe("二（本地改）"); // 跳过
    expect((await source.kernel.collections.get(collection!.id))?.name).toBe("本地集合名");
    expect(await source.kernel.resources.get(extra.id)).toEqual(extra); // 不在导入里的不动
    expect(await source.kernel.search("本地改")).toHaveLength(1);
    expect(events).toEqual([{ type: "resource.updated", resource: first }]);
  });

  it("覆盖集合", async () => {
    const { files } = await exportedFiles(source);
    const [collection] = await source.kernel.collections.list();
    await source.kernel.collections.update(collection!.id, { name: "改名" });
    const plan = await source.kernel.data.planImport(files);
    expect(await source.kernel.data.applyImport(plan, (c) => (c.type === "collection" ? "overwrite" : "skip"))).toEqual({ created: 0, overwritten: 1, skipped: 2 });
    expect(await source.kernel.collections.get(collection!.id)).toEqual(collection);
  });

  it("也接受已解析的 JSON", async () => {
    const { bundle } = await exportedFiles(source);
    const target = await createTestKernel();
    const plan = await target.kernel.data.planImport({ resources: bundle.resources, collections: bundle.collections, manifest: bundle.manifest });
    expect(plan.newResources).toHaveLength(2);
  });

  it.each<[string, (f: { resources: string; collections: string; manifest: string }) => unknown, string]>([
    ["不是 JSON", (f) => ({ ...f, resources: "{oops" }), "resources.json 不是合法的 JSON"],
    ["不是 OneDesk 导出", (f) => ({ ...f, manifest: JSON.stringify({ app: "other", formatVersion: 1, schemaVersion: 1, exportedAt: "x" }) }), "manifest.json"],
    ["格式版本不支持", (f) => ({ ...f, manifest: JSON.stringify({ app: "onedesk", formatVersion: 2, schemaVersion: 1, exportedAt: "x" }) }), "格式版本"],
    ["清单缺失", (f) => ({ ...f, manifest: undefined }), "manifest.json"],
    ["资源不是数组", (f) => ({ ...f, resources: "{}" }), "resources.json"],
    ["资源缺字段", (f) => ({ ...f, resources: JSON.stringify([{ id: "x", kind: "sample", name: "x" }]) }), "resources.json"],
    ["资源 id 重复", (f) => ({ ...f, resources: JSON.stringify([...(JSON.parse(f.resources) as unknown[]), (JSON.parse(f.resources) as unknown[])[0]]) }), "重复的 id"],
    ["集合规则不合法", (f) => ({ ...f, collections: JSON.stringify([{ id: "c", name: "x", rule: { type: "smart", value: "x" }, createdAt: "2026-01-01T00:00:00.000Z" }]) }), "collections.json"],
  ])("拒绝无效的导入文件：%s", async (_label, mutate, mention) => {
    const { files } = await exportedFiles(source);
    const target = await createTestKernel();
    await expect(target.kernel.data.planImport(mutate(files) as never)).rejects.toMatchObject({ code: "validation", message: expect.stringContaining(mention) });
    expect(await target.kernel.resources.list({ includeDisabled: true })).toEqual([]);
  });

  it("写入失败时整体回滚", async () => {
    const { files } = await exportedFiles(source);
    const target = await createTestKernel();
    const plan = await target.kernel.data.planImport(files);
    // 计划之后同一个 id 被别处写入：新资源用 INSERT，冲突会让整个事务失败。
    const clash = plan.newResources[1]!;
    target.db.run("INSERT INTO resources (id, kind, name, created_at, updated_at) VALUES (?, 'x', 'x', 'x', 'x')", [clash.id]);
    await expect(target.kernel.data.applyImport(plan, () => "overwrite")).rejects.toMatchObject({ code: "conflict", message: expect.stringContaining("数据没有改动") });
    expect(target.db.exec("SELECT COUNT(*) FROM resources")[0]?.values).toEqual([[1]]);
    expect(await target.kernel.collections.list()).toEqual([]);
  });

  it("空计划不做任何事", async () => {
    const target = await createTestKernel();
    const plan = await target.kernel.data.planImport({ resources: "[]", collections: "[]", manifest: JSON.stringify({ app: "onedesk", formatVersion: 1, schemaVersion: 1, exportedAt: "x" }) });
    expect(await target.kernel.data.applyImport(plan, () => "overwrite")).toEqual({ created: 0, overwritten: 0, skipped: 0 });
  });
});
