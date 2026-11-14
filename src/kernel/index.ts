/**
 * Kernel entry: `createKernel({ platform })` wires the modules together. The kernel knows resources, plugins and
 * views — nothing about any concrete plugin — and reaches the outside world only through the injected Platform.
 */
import { ActionRunner } from "./actions";
import { CollectionStore } from "./collections";
import type { CreateKernel, Kernel, KernelOptions } from "./contracts";
import { DataTransfer } from "./data";
import { EventBus } from "./events";
import { PluginHost } from "./plugin-host";
import { Prefs } from "./prefs";
import { Registry } from "./registry";
import { ResourceStore } from "./resources";
import type { Runtime } from "./util";
import { ViewRenderer } from "./views";

export * from "./contracts";

const DEFAULT_CONTEXT: Kernel["context"] = {
  workspace: { id: "local", name: "本地工作区" },
  user: { id: "local", name: "本地用户" },
};

function fallbackId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export const createKernel: CreateKernel = async (options: KernelOptions): Promise<Kernel> => {
  const { platform } = options;
  const db = platform.db;
  const context = options.context ?? DEFAULT_CONTEXT;
  const runtime: Runtime = {
    now: () => platform.now?.() ?? new Date(),
    randomId: () => platform.randomId?.() ?? globalThis.crypto?.randomUUID?.() ?? fallbackId(),
  };

  const events = new EventBus();
  const registry = new Registry();
  const collections = new CollectionStore(db, runtime, events);
  const resources = new ResourceStore(db, runtime, events, registry, collections);
  await resources.init();
  const prefs = new Prefs(db, events);
  // The runner and the host refer to each other (host aborts runs; runner asks whether a plugin is disabled).
  const hostRef: { current?: PluginHost } = {};
  const isPluginDisabled = (id: string): boolean => hostRef.current?.isDisabled(id) ?? false;
  const readableKinds = (id: string): string[] => hostRef.current?.readableKinds(id) ?? [];
  const actions = new ActionRunner(runtime, events, registry, resources, context, isPluginDisabled, readableKinds);
  const host = new PluginHost(db, runtime, events, registry, resources, actions, { db, runtime, events, registry, resources, collections, platform, context });
  hostRef.current = host;
  const views = new ViewRenderer(registry, resources, actions, isPluginDisabled);
  const data = new DataTransfer(db, runtime, events, resources, collections);

  return {
    events: {
      on: (type, handler) => events.on(type, handler),
      onAny: (handler) => events.onAny(handler),
    },
    resources: {
      get: (id) => resources.get(id),
      list: (query = {}) => {
        const { includeDisabled, ...rest } = query;
        return resources.list(rest, { includeDisabled: includeDisabled === true });
      },
      create: (draft) => resources.create(draft),
      update: (id, patch) => resources.update(id, patch),
      delete: (id) => resources.delete(id),
      validate: (kind, body) => resources.validate(kind, body),
      tags: () => resources.tags(),
      groups: () => resources.groups(),
    },
    search: (text, searchOptions) => resources.search(text, searchOptions),
    collections: {
      list: () => collections.list(),
      get: (id) => collections.get(id),
      create: (input) => collections.create(input),
      update: (id, input) => collections.update(id, input),
      delete: (id) => collections.delete(id),
      resources: (id) => resources.list({ collectionId: id }),
    },
    plugins: {
      load: (sources) => host.load(sources),
      list: () => host.list(),
      loadErrors: () => host.loadErrors(),
      enable: (id) => host.enable(id),
      disable: (id) => host.disable(id),
      uninstall: (id) => host.uninstall(id),
      uninstalled: () => host.uninstalled(),
      reinstall: (id) => host.reinstall(id),
      getSettings: (id) => host.getSettings(id),
      setSettings: (id, values) => host.setSettings(id, values),
    },
    registry: {
      kinds: () => registry.kinds(),
      kind: (id) => registry.kind(id),
      kindOwner: (id) => registry.kindOwner(id),
      actionsFor: (kind) => registry.actionsFor(kind),
      action: (key) => registry.action(key),
      viewsFor: (kind) => registry.viewsFor(kind),
      menuItems: () => registry.menuItems(),
    },
    actions: {
      inputFields: (key, resource) => actions.inputFields(key, resource),
      run: (key, args) => actions.run(key, args),
      lastResult: (resourceId) => actions.lastResult(resourceId),
      running: () => actions.running(),
      cancel: (runId) => actions.cancel(runId),
    },
    views: {
      render: (key, resourceId) => views.render(key, resourceId),
    },
    prefs: {
      get: (key) => prefs.get(key),
      set: (key, value) => prefs.set(key, value),
    },
    secrets: platform.secrets,
    data: {
      exportAll: () => data.exportAll(),
      planImport: (files) => data.planImport(files),
      applyImport: (plan, decide) => data.applyImport(plan, decide),
    },
    context,
  };
};
