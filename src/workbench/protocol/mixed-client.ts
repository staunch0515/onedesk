import type { ProtocolClient } from "./client";
import type { CommandContext, CommandEffect, Resource, TreeInfo } from "./types";
import type { KernelClient } from "./real/real-client";

/** The mock's general resource tree is renamed so it cannot clash with the kernel's `resources` (D265). */
const DEMO_RESOURCES = "demo:resources";
/** The mock's file tree is dropped: the real one comes from a plugin. */
const DROPPED_MOCK_TREES = new Set(["files"]);

function mapTrees<T>(value: T, fn: (tree: string) => string): T {
  if (Array.isArray(value)) return value.map((v) => mapTrees(v, fn)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, k === "tree" && typeof v === "string" ? fn(v) : mapTrees(v, fn)]),
    ) as T;
  }
  return value;
}
const fromMock = <T,>(value: T): T => mapTrees(value, (t) => (t === "resources" ? DEMO_RESOURCES : t));
const toMock = <T,>(value: T): T => mapTrees(value, (t) => (t === DEMO_RESOURCES ? "resources" : t));

/**
 * One client for the interface (D265): what the kernel implements this week goes to the kernel,
 * everything else to the mock and is marked "demo data". Kernel trees come first.
 */
export function createMixedClient(kernel: KernelClient, mock: ProtocolClient): ProtocolClient {
  const mockTrees = new Set<string>();
  /** Resource ids known to belong to the mock / the kernel. */
  const demoIds = new Set<string>();
  const kernelIds = new Set<string>();
  const isDemoTree = (tree: string | undefined) => tree !== undefined && (tree === DEMO_RESOURCES || mockTrees.has(tree));
  /** `new:` targets the mock handed out (marked with `demo=1`). */
  const isDemoNew = (target: string) => target.startsWith("new:") && target.includes("demo=1");

  const listTrees = async (): Promise<TreeInfo[]> => {
    const real = await kernel.tree.list();
    const realIds = new Set(real.map((t) => t.id));
    const demo = (await mock.tree.list())
      .map((t) => (t.id === "resources" ? { ...t, id: DEMO_RESOURCES, title: { "en-US": "Demo resources", "zh-CN": "演示资源" } } : t))
      .filter((t) => t.id === DEMO_RESOURCES || (!DROPPED_MOCK_TREES.has(t.id) && !realIds.has(t.id)));
    mockTrees.clear();
    for (const t of demo) mockTrees.add(t.id);
    return [...real, ...demo];
  };

  /** Which side owns `resource:<id>`; asks the kernel first and remembers the answer. */
  const ownerOf = async (id: string): Promise<"kernel" | "demo"> => {
    if (kernelIds.has(id)) return "kernel";
    if (demoIds.has(id)) return "demo";
    const res = await kernel.resource.get(id).catch(() => null);
    (res ? kernelIds : demoIds).add(id);
    return res ? "kernel" : "demo";
  };
  const targetOwner = async (target: string): Promise<"kernel" | "demo"> => {
    if (target.startsWith("resource:")) return ownerOf(target.slice(9));
    if (target.startsWith("new:")) return isDemoNew(target) ? "demo" : "kernel";
    if (target.startsWith("node:")) {
      const tree = decodeURIComponent(target.slice(5).split("/")[0] ?? "");
      return isDemoTree(tree) ? "demo" : "kernel";
    }
    return "demo";
  };

  const markDemoEffects = (effects: CommandEffect[]): CommandEffect[] =>
    fromMock(effects).map((e) => (e.type === "open" && e.target.startsWith("new:") ? { ...e, target: `${e.target}${e.target.includes("?") ? "&" : "?"}demo=1` } : e));

  const client: ProtocolClient = {
    ...mock,
    version: mock.version,
    demo: {
      tree: (id) => isDemoTree(id),
      target: (target) => {
        if (target.startsWith("resource:")) return demoIds.has(target.slice(9));
        if (target.startsWith("new:")) return isDemoNew(target);
        if (target.startsWith("node:")) return isDemoTree(decodeURIComponent(target.slice(5).split("/")[0] ?? ""));
        return true;
      },
    },
    workspace: { ...mock.workspace, info: () => kernel.workspace.info() },
    tree: {
      list: listTrees,
      children: (tree, parent, offset) => (isDemoTree(tree) ? mock.tree.children(toMock({ tree }).tree, parent, offset).then(fromMock) : kernel.tree.children(tree, parent, offset)),
      path: (tree, key) => (isDemoTree(tree) ? mock.tree.path(toMock({ tree }).tree, key) : kernel.tree.path(tree, key)),
      move: (tree, key, target, position) => (isDemoTree(tree) ? mock.tree.move(toMock({ tree }).tree, key, target, position) : kernel.tree.move(tree, key, target, position)),
      createGroup: (tree, parent, name) => (isDemoTree(tree) ? mock.tree.createGroup(toMock({ tree }).tree, parent, name).then(fromMock) : kernel.tree.createGroup(tree, parent, name)),
      rename: (tree, key, name) => (isDemoTree(tree) ? mock.tree.rename(toMock({ tree }).tree, key, name) : kernel.tree.rename(tree, key, name)),
    },
    resource: {
      ...mock.resource,
      async get(id): Promise<Resource | null> {
        if ((await ownerOf(id)) === "kernel") return kernel.resource.get(id);
        return fromMock(await mock.resource.get(id));
      },
      async delete(id) {
        return (await ownerOf(id)) === "kernel" ? kernel.resource.delete(id) : mock.resource.delete(id);
      },
      async listDeleted() {
        return fromMock(await mock.resource.listDeleted());
      },
    },
    page: {
      ...mock.page,
      async resolve(target, context) {
        if ((await targetOwner(target)) === "kernel") return kernel.page.resolve(target, context);
        return fromMock(await mock.page.resolve(target.replace(/[?&]demo=1/, ""), context));
      },
      async save(target, changes, basis, context) {
        if ((await targetOwner(target)) === "kernel") {
          const result = await kernel.page.save(target, changes, basis, context);
          if (result.page.resourceId) kernelIds.add(result.page.resourceId);
          return result;
        }
        const result = await mock.page.save(target.replace(/[?&]demo=1/, ""), changes, basis, context);
        if (result.page.resourceId) demoIds.add(result.page.resourceId);
        return { page: fromMock(result.page) };
      },
    },
    command: {
      ...mock.command,
      newItems: () => kernel.command.newItems(),
      async execute(id, context: CommandContext) {
        const demo = isDemoTree(context.tree) || (context.target !== undefined && (await targetOwner(context.target)) === "demo" && !context.tree);
        if (!demo) return kernel.command.execute(id, context);
        const effects = markDemoEffects(await mock.command.execute(id, toMock(context)));
        return effects;
      },
    },
    plugin: {
      ...mock.plugin,
      grants: (plugin) => kernel.plugin.grants(plugin),
      grantFolder: (plugin, path) => kernel.plugin.grantFolder(plugin, path),
      revokeFolder: (plugin, path) => kernel.plugin.revokeFolder(plugin, path),
    },
    platform: kernel.transport.pickFolder ? { pickFolder: () => kernel.transport.pickFolder!() } : undefined,
    ui: kernel.ui,
    events: {
      subscribe(topic, handler) {
        const offs = [kernel.events.subscribe(topic, handler), mock.events.subscribe(topic.replace(DEMO_RESOURCES, "resources"), (t, p) => handler(t === "tree:resources" ? `tree:${DEMO_RESOURCES}` : t, p))];
        return () => offs.forEach((off) => off());
      },
    },
  };
  return client;
}
