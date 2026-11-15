// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { createMockClient } from "./mock";
import { createMixedClient } from "./mixed-client";
import type { KernelClient } from "./real/real-client";
import type { TreeInfo } from "./types";

function fakeKernel(): KernelClient {
  const trees: TreeInfo[] = [{ id: "resources", title: "resources", icon: "folder-tree", source: "stored", groups: true, toolbar: [], menu: [] }];
  const ui = new Map<string, unknown>();
  return {
    hello: { protocol: "1", workspace: { id: "w", name: "W" } },
    transport: { request: async () => null, onEvent: () => () => undefined, close() {} },
    workspace: { info: async () => ({ id: "w", name: "W" }) },
    tree: {
      list: async () => trees,
      children: async () => ({ nodes: [] }),
      path: async () => [],
      move: async () => undefined,
      createGroup: async () => {
        throw new Error("unused");
      },
      rename: async () => undefined,
    },
    resource: { get: async (id) => (id === "kernel-1" ? ({ id, tree: "resources" } as never) : null), delete: async () => undefined },
    page: {
      resolve: async (target) => ({ target, title: "from kernel" }) as never,
      save: async (target) => ({ page: { target, title: "saved by kernel" } as never }),
    },
    command: { newItems: async () => [{ id: "new:k", label: "k", icon: "file" }], execute: async () => [{ type: "reload" }] },
    plugin: { grants: async (plugin) => ({ plugin, folders: [] }), grantFolder: async (plugin, path) => ({ plugin, folders: [path] }), revokeFolder: async (plugin) => ({ plugin, folders: [] }) },
    ui: { get: async <T,>(k: string) => (ui.get(k) ?? null) as T | null, set: async (k, v) => void ui.set(k, v) },
    events: { subscribe: () => () => undefined },
    connection: () => "restored",
  };
}

describe("mixed client", () => {
  it("lists kernel trees first, renames the demo resource tree and drops the demo file tree", async () => {
    const client = createMixedClient(fakeKernel(), createMockClient({ fresh: true, quiet: true }));
    const trees = await client.tree.list();
    expect(trees[0]?.id).toBe("resources");
    const ids = trees.map((t) => t.id);
    expect(ids).toContain("demo:resources");
    expect(ids).not.toContain("files");
    expect(ids.filter((id) => id === "resources")).toHaveLength(1);
    expect(client.demo?.tree("demo:resources")).toBe(true);
    expect(client.demo?.tree("resources")).toBe(false);
  });

  it("sends kernel resources to the kernel and demo resources to the demo", async () => {
    const client = createMixedClient(fakeKernel(), createMockClient({ fresh: true, quiet: true }));
    await client.tree.list();
    expect((await client.page.resolve("resource:kernel-1")).title).toBe("from kernel");
    const demoNodes = (await client.tree.children("demo:resources", null)).nodes;
    expect(demoNodes.length).toBeGreaterThan(0);
    expect(demoNodes.every((n) => n.tree === "demo:resources")).toBe(true);
    const demoLeaf = demoNodes.find((n) => n.target?.startsWith("resource:"));
    if (demoLeaf?.target) {
      const page = await client.page.resolve(demoLeaf.target);
      expect(page.title).not.toBe("from kernel");
      expect(client.demo?.target(demoLeaf.target)).toBe(true);
    }
  });

  it("keeps interface state in the kernel and the New menu from the kernel", async () => {
    const client = createMixedClient(fakeKernel(), createMockClient({ fresh: true, quiet: true }));
    await client.ui.set("layout", { a: 1 });
    expect(await client.ui.get("layout")).toEqual({ a: 1 });
    expect((await client.command.newItems()).map((i) => i.id)).toEqual(["new:k"]);
  });

  it("marks `new:` targets handed out by the demo tree menus so they stay demo", async () => {
    const client = createMixedClient(fakeKernel(), createMockClient({ fresh: true, quiet: true }));
    await client.tree.list();
    const effects = await client.command.execute("new:org.onedesk.note:note", { tree: "demo:resources" });
    const open = effects.find((e) => e.type === "open");
    expect(open && "target" in open && open.target.includes("demo=1")).toBe(true);
    expect(client.demo?.target((open as { target: string }).target)).toBe(true);
  });
});
