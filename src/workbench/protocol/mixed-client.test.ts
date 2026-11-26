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
    workspace: { info: async () => ({ id: "w", name: "W" }), list: async () => [{ id: "w", name: "W", folder: "w", current: true }], create: async () => ({ id: "x", name: "X", folder: "x", current: false }), switchTo: async () => ({ id: "w", name: "W", folder: "w", current: true }), rename: async () => undefined, remove: async () => undefined, openWindow: async () => undefined, getConfig: async (n: string) => (n === "ui.language" ? "zh-CN" : null), setConfig: async () => undefined, export: async () => ({ folder: "/x", resources: 1, revisions: 0, runs: 0, audit: 0, blobs: 0 }), importPreview: async () => ({ valid: false, source: "", exportedAt: 0, create: 0, update: 0, skipped: [], fingerprint: "", grantHosts: [], secretNames: [] }), import: async () => { throw new Error("unused"); } },
    refs: { outgoing: async () => [], incoming: async () => [{ source: { id: "kernel-1", name: "k" }, field: "body.text", text: "x", state: "ok" }] },
    params: { envOptions: async () => [{ id: "e1", name: "Default", depth: 0 }] } as never,
    app: { inspectPlugin: async () => ({ valid: true }) as never, installPlugin: async () => ({ plugin: "p", version: "1" }), removePlugin: async () => undefined },
    secrets: { list: async () => [{ name: "token", updatedAt: 1, usedBy: [] }], set: async () => undefined, delete: async () => undefined },
    search: { query: async () => [{ target: "resource:k1", title: "kernel hit", icon: "file", subtitle: "", state: "ok" }] },
    mcp: { status: async () => ({ enabled: false, ratePerMinute: 30, maxRows: 200, allowFreeQuery: false, allowProposals: false, tools: 4 }) },
    identity: { get: async () => null, create: async () => ({}) as never, update: async () => ({}) as never, delete: async () => undefined, exportCard: async () => undefined },
    contact: { importCard: async () => ({ id: "c", created: true }), setChecked: async () => undefined, exportCard: async () => undefined },
    proposal: { get: async () => ({}) as never, review: async () => ({}) as never, withdraw: async () => ({}) as never, count: async () => ({ pending: 0, ids: [] }), create: async () => ({ id: "p" }) },
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
      at: async () => {
        throw new Error("unused");
      },
      setAiVisible: async () => ({ changed: 1 }),
    },
    page: {
      event: async () => ({ message: "kernel event" }),
      resolve: async (target) => ({ target, title: "from kernel" }) as never,
      save: async (target) => ({ page: { target, title: "saved by kernel" } as never }),
    },
    result: { actions: async () => [] },
    run: {
      start: async () => "kernel-run",
      get: async (id) => ({ id, status: "running" }) as never,
      cancel: async () => undefined,
      listFor: async () => [],
      tasks: async () => [{ id: "kernel-run" } as never],
      clearFinished: async () => undefined,
      render: async () => [],
      setKept: async () => undefined,
      export: async (_id, path) => ({ path, rows: 2 }),
    },
    command: { palette: async () => [{ id: "k:cmd", label: "k", group: "k" }], newItems: async () => [{ id: "new:k", label: "k", icon: "file" }], execute: async () => [{ type: "reload" }] },
    plugin: { get: async (id: string) => ({ id } as never), setEnabled: async () => undefined, setSetting: async () => undefined, reload: async () => undefined, activateVersion: async () => ({ upgraded: 1, kept: 0 }), setPinned: async () => undefined, undoUpgrade: async () => ({ restored: 0, modified: [] }), confirmPermissions: async () => undefined, grants: async (plugin) => ({ plugin, folders: [] }), grantFolder: async (plugin, path) => ({ plugin, folders: [path] }), revokeFolder: async (plugin) => ({ plugin, folders: [] }), replaceFolder: async (plugin, _p, n) => ({ plugin, folders: [n] }) },
    i18n: { languages: async () => [{ locale: "en-US", name: "English" }], shell: async (locale) => ({ locale, texts: {} }) },
    ui: { get: async <T,>(k: string) => (ui.get(k) ?? null) as T | null, set: async (k, v) => void ui.set(k, v) },
    events: { subscribe: () => () => undefined },
    connection: () => "restored",
  };
}

describe("mixed client", () => {
  it("lists only the kernel's trees: no demo tree (fake resources, fake data sources) is shown next to real data", async () => {
    const client = createMixedClient(fakeKernel(), createMockClient({ fresh: true, quiet: true }));
    const trees = await client.tree.list();
    expect(trees[0]?.id).toBe("resources");
    const ids = trees.map((t) => t.id);
    expect(ids).not.toContain("demo:resources");
    expect(ids).not.toContain("files");
    expect(ids.filter((id) => id === "resources")).toHaveLength(1);
    expect(ids.every((id) => client.demo?.tree(id) === false)).toBe(true);
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

  it("does not send a write to the demo when the kernel failed or only said no", async () => {
    const kernel = fakeKernel();
    const saved: string[] = [];
    kernel.page.save = async (target) => {
      saved.push(target);
      return { page: { target, title: "saved by kernel" } as never };
    };
    let failing = true;
    kernel.resource.get = async (id) => {
      if (failing) throw new Error("worker gone");
      return id === "kernel-1" ? ({ id, tree: "resources" } as never) : null;
    };
    const mock = createMockClient({ fresh: true, quiet: true });
    let mockSaves = 0;
    const origSave = mock.page.save;
    mock.page.save = async (...a) => {
      mockSaves += 1;
      return origSave(...a);
    };
    const client = createMixedClient(kernel, mock);
    await client.tree.list();
    // Kernel error: the error surfaces, nothing is written, nothing is remembered.
    await expect(client.page.save("resource:kernel-1", { name: "x" })).rejects.toThrow("worker gone");
    expect(mockSaves).toBe(0);
    expect(client.demo?.target("resource:kernel-1")).toBe(false);
    // Kernel answers: it owns the resource.
    failing = false;
    await client.page.save("resource:kernel-1", { name: "x" });
    expect(saved).toEqual(["resource:kernel-1"]);
    // Unknown on both sides: the kernel gets the call (and will say notFound), the demo does not.
    await client.page.save("resource:nowhere", { name: "x" });
    expect(saved).toContain("resource:nowhere");
    expect(mockSaves).toBe(0);
    expect(client.demo?.target("resource:nowhere")).toBe(false);
  });

  it("runs kernel resources in the kernel and demo resources in the demo, and follows each run to its side", async () => {
    const client = createMixedClient(fakeKernel(), createMockClient({ fresh: true, quiet: true }));
    await client.tree.list();
    const base = { action: "run", tabId: "t1", envId: null, input: {}, params: {} };
    const kernelRun = await client.run.start({ ...base, target: "resource:kernel-1", resourceId: "kernel-1" });
    expect(kernelRun).toBe("kernel-run");
    expect((await client.run.get(kernelRun))?.status).toBe("running");
    const demo = (await client.tree.children("demo:resources", null)).nodes.find((n) => n.target?.startsWith("resource:") && n.kind.endsWith(":query"));
    if (demo?.target) {
      const demoRun = await client.run.start({ ...base, target: demo.target, resourceId: demo.target.slice(9) });
      expect(demoRun).not.toBe("kernel-run");
      expect((await client.run.get(demoRun))?.id).toBe(demoRun);
      expect(client.demo?.target(`run:${demoRun}`)).toBe(true);
    }
    expect(client.demo?.target("run:kernel-run")).toBe(false);
    expect((await client.run.tasks())[0]?.id).toBe("kernel-run");
  });

  it("takes plugin pages, plugin state and the command palette from the kernel", async () => {
    const client = createMixedClient(fakeKernel(), createMockClient({ fresh: true, quiet: true }));
    await client.tree.list();
    expect((await client.page.resolve("plugin:org.example")).title).toBe("from kernel");
    expect((await client.plugin.get("org.example"))?.id).toBe("org.example");
    expect((await client.command.palette())[0]?.id).toBe("k:cmd");
    expect((await client.page.event("resource:kernel-1", "tidy", {})).message).toBe("kernel event");
    expect(client.demo?.target("plugin:org.example")).toBe(false);
  });

  it("sends installing, removing, versions and secrets to the kernel", async () => {
    const client = createMixedClient(fakeKernel(), createMockClient({ fresh: true, quiet: true }));
    expect((await client.app?.installPlugin("/x", "p", "1", "fp"))?.plugin).toBe("p");
    expect((await client.secrets?.list())?.[0]?.name).toBe("token");
    expect((await client.plugin.activateVersion("p", "2")).upgraded).toBe(1);
  });

  it("sends references, export and import to the kernel for kernel resources", async () => {
    const client = createMixedClient(fakeKernel(), createMockClient({ fresh: true, quiet: true }));
    expect((await client.refs.incoming("kernel-1"))[0]?.source.id).toBe("kernel-1");
    expect((await client.workspace.export("/x")).resources).toBe(1);
    expect((await client.workspace.importPreview("/x")).valid).toBe(false);
  });
});
