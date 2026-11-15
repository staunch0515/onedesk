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
    workspace: { info: async () => ({ id: "w", name: "W" }), getConfig: async (n: string) => (n === "ui.language" ? "zh-CN" : null), setConfig: async () => undefined },
    params: { envOptions: async () => [{ id: "e1", name: "Default", depth: 0 }] } as never,
    search: { query: async () => [{ target: "resource:k1", title: "kernel hit", icon: "file", subtitle: "", state: "ok" }] },
    audit: { list: async () => [], facets: async () => ({ actors: [], operations: [] }) },
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
    resource: {
      get: async (id) => (id === "kernel-1" ? ({ id, tree: "resources" } as never) : null),
      delete: async () => undefined,
      history: async () => [{ id: "h", at: 1, actor: "user", op: "update", field: "name", before: "a", after: "b" }],
      restore: async () => undefined,
      listDeleted: async () => [],
      undelete: async () => undefined,
      purge: async () => undefined,
      setFavorite: async () => undefined,
    },
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

  it("sends saves of node: pages (files) to the kernel with the basis", async () => {
    const kernel = fakeKernel();
    let seen: { target: string; basis?: string } | undefined;
    kernel.page.save = async (target, _changes, basis) => {
      seen = { target, basis };
      return { page: { target, title: "saved by kernel" } as never };
    };
    const client = createMixedClient(kernel, createMockClient({ fresh: true, quiet: true }));
    await client.tree.list();
    await client.page.save("node:org.onedesk.files%3Afiles/a.txt", { "body.text": "x" }, "7");
    expect(seen).toEqual({ target: "node:org.onedesk.files%3Afiles/a.txt", basis: "7" });
  });

  it("takes configuration, environments, search and audit from the kernel and drops the demo environment tree", async () => {
    const client = createMixedClient(fakeKernel(), createMockClient({ fresh: true, quiet: true }));
    const ids = (await client.tree.list()).map((t) => t.id);
    expect(ids).not.toContain("environments");
    expect(await client.workspace.getConfig("ui.language")).toBe("zh-CN");
    expect((await client.params.envOptions())[0]?.id).toBe("e1");
    expect((await client.search.query("x"))[0]?.title).toBe("kernel hit");
  });

  it("asks the kernel for history of kernel resources and the demo for demo ones", async () => {
    const client = createMixedClient(fakeKernel(), createMockClient({ fresh: true, quiet: true }));
    await client.tree.list();
    expect((await client.resource.history("kernel-1"))[0]?.id).toBe("h");
    const demo = (await client.tree.children("demo:resources", null)).nodes.find((n) => n.target?.startsWith("resource:"));
    if (demo?.target) expect((await client.resource.history(demo.target.slice(9))).every((h) => h.id !== "h")).toBe(true);
  });

  it("treats core: pages (audit, deleted) as kernel pages", async () => {
    const client = createMixedClient(fakeKernel(), createMockClient({ fresh: true, quiet: true }));
    await client.tree.list();
    expect((await client.page.resolve("core:audit")).title).toBe("from kernel");
    expect(client.demo?.target("core:audit")).toBe(false);
  });
});
