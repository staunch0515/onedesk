import type { ProtocolClient } from "./client";
import type { CommandContext, CommandEffect, Resource, TreeInfo } from "./types";
import type { KernelClient } from "./real/real-client";

/** The mock's general resource tree is renamed so it cannot clash with the kernel's `resources` (D265). */
const DEMO_RESOURCES = "demo:resources";
/** Demo topics that the kernel words differently. */
const TOPIC_ALIASES: Record<string, string> = { env: "tree:env", "tree:environments": "tree:env" };

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
  /** Runs started on demo pages; every other run is the kernel's. */
  const demoRuns = new Set<string>();
  const runSide = (id: string) => (demoRuns.has(id) ? mock : kernel);
  /** `new:` targets the mock handed out (marked with `demo=1`). */
  const isDemoNew = (target: string) => target.startsWith("new:") && target.includes("demo=1");

  /** The release shows only the kernel's trees: the demo's (fake resources, fake data sources) are never listed next to real data (D452 review). */
  const listTrees = async (): Promise<TreeInfo[]> => {
    mockTrees.clear();
    return kernel.tree.list();
  };

  /**
   * Which side owns `resource:<id>`. Only what a side positively answered is remembered. A kernel
   * error is not an answer: it is thrown, so a write is never sent to the demo by mistake. When the
   * kernel says "none" the demo is asked; if it has none either, the kernel gets the call (and
   * answers notFound). A negative answer is never cached.
   */
  const ownerOf = async (id: string): Promise<"kernel" | "demo"> => {
    if (kernelIds.has(id)) return "kernel";
    if (demoIds.has(id)) return "demo";
    const res = await kernel.resource.get(id);
    if (res) {
      kernelIds.add(id);
      return "kernel";
    }
    const demo = await mock.resource.get(id).catch(() => null);
    if (demo) {
      demoIds.add(id);
      return "demo";
    }
    return "kernel";
  };
  const targetOwner = async (target: string): Promise<"kernel" | "demo"> => {
    if (target.startsWith("resource:")) return ownerOf(target.slice(9));
    if (target.startsWith("new:")) return isDemoNew(target) ? "demo" : "kernel";
    if (target.startsWith("node:")) {
      const tree = decodeURIComponent(target.slice(5).split("/")[0] ?? "");
      return isDemoTree(tree) ? "demo" : "kernel";
    }
    // `core:audit`, `core:deleted`: kernel pages. `plugin:<id>`: plugins are the kernel's.
    if (target.startsWith("core:") || target.startsWith("plugin:") || target.startsWith("shell:") || target.startsWith("page:")) return "kernel";
    if (target.startsWith("run:")) return demoRuns.has(target.slice(4)) ? "demo" : "kernel";
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
        if (target.startsWith("core:") || target.startsWith("plugin:") || target.startsWith("shell:") || target.startsWith("page:")) return false;
        if (target.startsWith("run:")) return demoRuns.has(target.slice(4));
        return true;
      },
    },
    workspace: {
      ...mock.workspace,
      info: () => kernel.workspace.info(),
      // The main process manages the workspaces (D400); no demo tabs are opened on first start.
      list: () => kernel.workspace.list(),
      create: (name) => kernel.workspace.create(name),
      switchTo: (id) => kernel.workspace.switchTo(id),
      rename: (id, name) => kernel.workspace.rename(id, name),
      remove: (id) => kernel.workspace.remove(id),
      openWindow: (id) => kernel.workspace.openWindow(id),
      startTargets: async () => [], getConfig: (name) => kernel.workspace.getConfig(name), setConfig: (name, value) => kernel.workspace.setConfig(name, value),
      export: (folder) => kernel.workspace.export(folder),
      importPreview: (folder) => kernel.workspace.importPreview(folder),
      import: (folder, fingerprint, parent) => kernel.workspace.import(folder, fingerprint, parent),
    },
    refs: {
      async outgoing(id) {
        return (await ownerOf(id)) === "kernel" ? kernel.refs.outgoing(id) : fromMock(await mock.refs.outgoing(id));
      },
      async incoming(id) {
        return (await ownerOf(id)) === "kernel" ? kernel.refs.incoming(id) : fromMock(await mock.refs.incoming(id));
      },
      embed: kernel.refs.embed,
      suggest: kernel.refs.suggest,
      rewrite: kernel.refs.rewrite,
    },
    params: kernel.params,
    app: kernel.app,
    secrets: kernel.secrets,
    search: kernel.search,
    audit: kernel.audit,
    mcp: kernel.mcp,
    tree: {
      list: listTrees,
      children: (tree, parent, offset, locale) => (isDemoTree(tree) ? mock.tree.children(toMock({ tree }).tree, parent, offset, locale).then(fromMock) : kernel.tree.children(tree, parent, offset, locale)),
      path: (tree, key) => (isDemoTree(tree) ? mock.tree.path(toMock({ tree }).tree, key) : kernel.tree.path(tree, key)),
      move: (tree, key, target, position, locale) => (isDemoTree(tree) ? mock.tree.move(toMock({ tree }).tree, key, target, position) : kernel.tree.move(tree, key, target, position, locale)),
      createGroup: (tree, parent, name) => (isDemoTree(tree) ? mock.tree.createGroup(toMock({ tree }).tree, parent, name).then(fromMock) : kernel.tree.createGroup(tree, parent, name)),
      rename: (tree, key, name) => (isDemoTree(tree) ? mock.tree.rename(toMock({ tree }).tree, key, name) : kernel.tree.rename(tree, key, name)),
    },
    resource: {
      async history(id) {
        return (await ownerOf(id)) === "kernel" ? kernel.resource.history(id) : mock.resource.history(id);
      },
      async restore(id, entryId) {
        return (await ownerOf(id)) === "kernel" ? kernel.resource.restore(id, entryId) : mock.resource.restore(id, entryId);
      },
      async setFavorite(id, favorite) {
        return (await ownerOf(id)) === "kernel" ? kernel.resource.setFavorite(id, favorite) : mock.resource.setFavorite(id, favorite);
      },
      async setAiVisible(id, visible, withChildren) {
        return (await ownerOf(id)) === "kernel" ? kernel.resource.setAiVisible(id, visible, withChildren) : mock.resource.setAiVisible(id, visible, withChildren);
      },
      undelete: (id) => kernel.resource.undelete(id),
      purge: (id) => kernel.resource.purge(id),
      async get(id): Promise<Resource | null> {
        if ((await ownerOf(id)) === "kernel") return kernel.resource.get(id);
        return fromMock(await mock.resource.get(id));
      },
      async delete(id) {
        return (await ownerOf(id)) === "kernel" ? kernel.resource.delete(id) : mock.resource.delete(id);
      },
      listDeleted: () => kernel.resource.listDeleted(),
    },
    page: {
      ...mock.page,
      async event(target, event, context) {
        return (await targetOwner(target)) === "kernel" ? kernel.page.event(target, event, context) : mock.page.event(target.replace(/[?&]demo=1/, ""), event, context);
      },
      async resolve(target, context) {
        if ((await targetOwner(target)) === "kernel") return kernel.page.resolve(target, context);
        // Demo pages know the demo's own environments, not the kernel's: they get none.
        return fromMock(await mock.page.resolve(target.replace(/[?&]demo=1/, ""), { ...context, envId: null }));
      },
      async save(target, changes, basis, context, overwrite) {
        if ((await targetOwner(target)) === "kernel") {
          const result = await kernel.page.save(target, changes, basis, context, overwrite);
          if (result.page.resourceId) kernelIds.add(result.page.resourceId);
          return result;
        }
        const result = await mock.page.save(target.replace(/[?&]demo=1/, ""), changes, basis, context);
        if (result.page.resourceId) demoIds.add(result.page.resourceId);
        return { page: fromMock(result.page) };
      },
    },
    run: {
      async start(request) {
        if ((await targetOwner(request.target)) === "kernel") return kernel.run.start(request);
        const id = await mock.run.start({ ...request, target: request.target.replace(/[?&]demo=1/, "") });
        demoRuns.add(id);
        return id;
      },
      get: (id) => runSide(id).run.get(id),
      export: (id, path) => runSide(id).run.export(id, path),
      rows: (id, offset, limit) => (runSide(id).run.rows ? runSide(id).run.rows!(id, offset, limit) : Promise.reject(new Error("run.rows"))),
      cancel: (id) => runSide(id).run.cancel(id),
      render: (id, tabId) => runSide(id).run.render(id, tabId),
      setKept: (id, kept, name) => runSide(id).run.setKept(id, kept, name),
      async listFor(resourceId) {
        return (await ownerOf(resourceId)) === "kernel" ? kernel.run.listFor(resourceId) : mock.run.listFor(resourceId);
      },
      tasks: () => kernel.run.tasks(),
      async clearFinished() {
        await Promise.all([kernel.run.clearFinished(), mock.run.clearFinished()]);
      },
    },
    result: { actions: (runId) => runSide(runId).result.actions(runId) },
    // Writing help needs the kernel's plugins: none on demo pages.
    assist: kernel.assist,
    blob: kernel.blob,
    command: {
      ...mock.command,
      palette: () => kernel.command.palette(),
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
      get: (id) => kernel.plugin.get(id),
      setEnabled: (id, enabled) => kernel.plugin.setEnabled(id, enabled),
      setSetting: (id, name, value) => kernel.plugin.setSetting(id, name, value),
      reload: (id) => kernel.plugin.reload(id),
      activateVersion: (id, version) => kernel.plugin.activateVersion(id, version),
      setPinned: (id, version, pinned) => kernel.plugin.setPinned(id, version, pinned),
      undoUpgrade: (batch, also) => kernel.plugin.undoUpgrade(batch, also),
      confirmPermissions: (id, version, fingerprint) => kernel.plugin.confirmPermissions(id, version, fingerprint),
      grants: (plugin) => kernel.plugin.grants(plugin),
      grantFolder: (plugin, path) => kernel.plugin.grantFolder(plugin, path),
      revokeFolder: (plugin, path) => kernel.plugin.revokeFolder(plugin, path),
      replaceFolder: (plugin, path, newPath) => kernel.plugin.replaceFolder(plugin, path, newPath),
      installRequests: kernel.plugin.installRequests ? () => kernel.plugin.installRequests!() : undefined,
      answerInstallRequest: kernel.plugin.answerInstallRequest ? (answer) => kernel.plugin.answerInstallRequest!(answer) : undefined,
    },
    // The kernel's languages (language plugins) replace the demo's own: a workspace with a kernel has no demo language.
    i18n: kernel.i18n,
    platform:
      kernel.transport.pickFolder || kernel.transport.openExternal
        ? {
            openExternal: kernel.transport.openExternal ? (url) => kernel.transport.openExternal!(url) : undefined,
            pickFolder: kernel.transport.pickFolder ? () => kernel.transport.pickFolder!() : undefined,
            pickPackageFile: kernel.transport.pickPackageFile ? () => kernel.transport.pickPackageFile!() : undefined,
            pickImageFile: kernel.transport.pickImageFile ? () => kernel.transport.pickImageFile!() : undefined,
            pickSaveFile: kernel.transport.pickSaveFile ? (name) => kernel.transport.pickSaveFile!(name) : undefined,
          }
        : undefined,
    ui: kernel.ui,
    events: {
      subscribe(topic, handler) {
        const offs = [kernel.events.subscribe(TOPIC_ALIASES[topic] ?? topic, handler), mock.events.subscribe(topic.replace(DEMO_RESOURCES, "resources"), (t, p) => handler(t === "tree:resources" ? `tree:${DEMO_RESOURCES}` : t, p))];
        return () => offs.forEach((off) => off());
      },
    },
  };
  return client;
}
