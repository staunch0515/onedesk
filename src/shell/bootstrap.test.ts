import { describe, expect, it, vi } from "vitest";
import { createTestKernel } from "../kernel/testing";
import { builtinPluginSources } from "../plugins";
import { externalPluginSource } from "./bootstrap";
import { sampleDrafts, seedSampleData } from "./sample-data";

describe("外部插件来源", () => {
  const base = { dir: "/p/demo", manifestText: '{"id":"org.x.demo"}', entrySource: "export default {}", error: null };

  it("清单解析为 JSON，入口经加载函数取 default", async () => {
    const module = { activate: () => {} };
    const load = vi.fn(async () => module);
    const source = externalPluginSource(base, load);
    expect(source).toMatchObject({ origin: "external", location: "/p/demo", manifest: { id: "org.x.demo" } });
    expect(source.error).toBeUndefined();
    expect(await source.load()).toBe(module);
    expect(load).toHaveBeenCalledWith("export default {}");
  });

  it("扫描错误原样传入；坏 JSON 和缺入口给出原因", async () => {
    expect(externalPluginSource({ ...base, manifestText: null, error: "缺少 manifest.json" }).error).toBe("缺少 manifest.json");
    expect(externalPluginSource({ ...base, manifestText: "{" }).error).toMatch(/不是合法 JSON/);
    await expect(externalPluginSource({ ...base, entrySource: null }).load()).rejects.toThrow("找不到入口文件");
  });
});

describe("预览模式示例数据", () => {
  it("每种内置 kind 一个、两个分组；只写一次", async () => {
    const t = await createTestKernel({ plugins: builtinPluginSources() });
    await seedSampleData(t.kernel);
    const list = await t.kernel.resources.list();
    expect(new Set(list.map((r) => r.kind))).toEqual(new Set(["link", "note", "prompt", "http-request"]));
    expect(new Set(list.map((r) => r.group)).size).toBe(2);
    for (const r of list) expect(t.kernel.resources.validate(r.kind, r.body)).toEqual({});
    await seedSampleData(t.kernel);
    expect(await t.kernel.resources.list()).toHaveLength(sampleDrafts().length);
  });
});
