import { describe, expect, it } from "vitest";
import { builtinPluginSources } from "../plugins";
import { CORE_EDIT_VIEW } from "./contracts";
import { createTestKernel } from "./testing";

/** Integration: the real built-in plugins go through the same load path as any other plugin. */
describe("内置插件经公开路径加载", () => {
  it("全部通过清单校验并激活；每个 kind 都有归属、默认视图和编辑视图", async () => {
    const sources = builtinPluginSources();
    const t = await createTestKernel({ plugins: sources });
    expect(t.kernel.plugins.loadErrors()).toEqual([]);
    const plugins = t.kernel.plugins.list();
    expect(plugins).toHaveLength(sources.length);
    for (const plugin of plugins) {
      expect(plugin.activationError).toBeUndefined();
      expect(plugin).toMatchObject({ origin: "builtin", state: "enabled" });
      for (const kind of plugin.manifest.provides.kinds) {
        expect(t.kernel.registry.kind(kind)?.pluginId).toBe(plugin.manifest.id);
        expect(t.kernel.registry.kindOwner(kind)).toBe(plugin.manifest.id);
        expect(t.kernel.registry.viewsFor(kind).at(-1)?.key).toBe(CORE_EDIT_VIEW);
      }
    }
    expect(t.kernel.registry.kinds().length).toBeGreaterThan(0);
  });

  it("停用再启用任意一个都能恢复", async () => {
    const t = await createTestKernel({ plugins: builtinPluginSources() });
    for (const plugin of t.kernel.plugins.list()) {
      const id = plugin.manifest.id;
      await t.kernel.plugins.disable(id);
      for (const kind of plugin.manifest.provides.kinds) expect(t.kernel.registry.kind(kind)).toBeUndefined();
      await t.kernel.plugins.enable(id);
      for (const kind of plugin.manifest.provides.kinds) expect(t.kernel.registry.kind(kind)?.pluginId).toBe(id);
    }
  });
});
