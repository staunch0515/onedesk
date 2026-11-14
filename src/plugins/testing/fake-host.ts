/**
 * In-memory `HostApi` for plugin unit tests. Not the real kernel: it only mimics the contract
 * (registration capture, storage, resources, injected network, recorded system calls).
 * Phase 2 re-tests the plugins against the real kernel.
 */
import {
  ActionOutputSchema,
  OneDeskError,
  type ActionDefinition,
  type ActionOutputInput,
  type ActionResult,
  type Collection,
  type HostApi,
  type HostEvent,
  type KindDefinition,
  type ManifestInput,
  type MenuItemDefinition,
  type NetworkRequestInit,
  type NetworkResponse,
  type NotifyMessage,
  type PluginModule,
  type Resource,
  type ResourceDraft,
  type ViewDefinition,
  type ViewState,
  type ViewTree,
} from "@onedesk/plugin-api";

export type FetchHandler = (url: string, init: NetworkRequestInit | undefined) => NetworkResponse | Promise<NetworkResponse>;

export interface FakeHostOptions {
  pluginId?: string;
  /** Plugin settings values. */
  settings?: Record<string, unknown>;
  /** Manifest JSON: its `settings[].default` values back `settings.get` when no explicit value is set. */
  manifest?: ManifestInput;
  secrets?: Record<string, string>;
  /** Injected network behaviour; default rejects with `unavailable`. */
  fetch?: FetchHandler;
}

export interface FakeHost extends HostApi {
  /** What the plugin registered, keyed by local id. */
  readonly registered: {
    kinds: Map<string, KindDefinition>;
    actions: Map<string, ActionDefinition>;
    views: Map<string, ViewDefinition>;
  };
  readonly menuItems: MenuItemDefinition[];
  readonly store: Map<string, unknown>;
  /** Recorded calls. */
  readonly opened: { url: string; options?: { profile?: string } }[];
  readonly copied: string[];
  readonly fetchCalls: { url: string; init: NetworkRequestInit | undefined }[];
  readonly notifications: NotifyMessage[];
  /** Forget registrations and event handlers but keep storage and resources (simulates an app restart before re-activation). */
  resetRegistrations(): void;
  /** Replace the injected network behaviour. */
  setFetch(handler: FetchHandler): void;
  /** Make `openExternal` / `copyText` fail (simulates a host-side failure). */
  failSystemCalls(message: string): void;
  /** Build a resource of a registered kind. */
  makeResource(kind: string, body: Record<string, unknown>, extra?: Partial<Resource>): Resource;
  /**
   * Run a registered action like the kernel would: returns a result, never throws. Output is validated with
   * `ActionOutputSchema`; a `{ fromField }` input is built from the resource's parameter field (name -> string).
   */
  runAction(
    actionId: string,
    resource: Resource | undefined,
    input?: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ): Promise<ActionResult>;
  /** Start an action whose signal can be aborted: `abort()` then await `result` (status "cancelled"). */
  runActionAbortable(
    actionId: string,
    resource: Resource | undefined,
    input?: Record<string, unknown>,
  ): { abort(): void; result: Promise<ActionResult> };
  /** Create and store a resource (without events), so `resources.get` finds it. */
  createResource(kind: string, body: Record<string, unknown>, extra?: Partial<Resource>): Promise<Resource>;
  /** Render a registered view. */
  renderView(viewId: string, resource: Resource, state?: Partial<ViewState>): Promise<ViewTree>;
  /** Deliver an event to subscribed handlers. */
  emit(event: HostEvent): void;
}

const SAFE_URL = /^(https?:\/\/|mailto:)/i;

export function createFakeHost(options: FakeHostOptions = {}): FakeHost {
  const pluginId = options.pluginId ?? "org.onedesk.test";
  const kinds = new Map<string, KindDefinition>();
  const actions = new Map<string, ActionDefinition>();
  const views = new Map<string, ViewDefinition>();
  const menuItems: MenuItemDefinition[] = [];
  const store = new Map<string, unknown>();
  const resources = new Map<string, Resource>();
  const opened: FakeHost["opened"] = [];
  const copied: string[] = [];
  const fetchCalls: FakeHost["fetchCalls"] = [];
  const notifications: NotifyMessage[] = [];
  const handlers = new Map<string, ((event: HostEvent) => void)[]>();
  let fetchHandler: FetchHandler =
    options.fetch ??
    (() => {
      throw new OneDeskError("unavailable", "未注入网络响应");
    });
  let systemFailure: string | undefined;
  let counter = 0;

  const register = <T>(map: Map<string, T>, id: string, what: string, value: T) => {
    if (map.has(id)) throw new OneDeskError("conflict", `${what} ${id} 已注册`);
    map.set(id, value);
  };

  const host: FakeHost = {
    pluginId,
    registered: { kinds, actions, views },
    menuItems,
    store,
    opened,
    copied,
    fetchCalls,
    notifications,

    resources: {
      registerKind: (kind) => register(kinds, kind.id, "kind", kind),
      get: async (id) => resources.get(id) ?? null,
      list: async (query) => [...resources.values()].filter((r) => !query?.kind || r.kind === query.kind),
      create: async (draft: ResourceDraft) => {
        const resource = host.makeResource(draft.kind, draft.body ?? {}, { name: draft.name });
        resources.set(resource.id, resource);
        host.emit({ type: "resource.created", resource });
        return resource;
      },
      update: async (id, patch) => {
        const current = resources.get(id);
        if (!current) throw new OneDeskError("not_found", "资源不存在");
        const next = { ...current, ...patch, version: current.version + 1 } as Resource;
        resources.set(id, next);
        host.emit({ type: "resource.updated", resource: next });
        return next;
      },
      delete: async (id) => {
        const current = resources.get(id);
        resources.delete(id);
        if (current) host.emit({ type: "resource.deleted", id, kind: current.kind });
      },
    },
    collections: {
      list: async () => [],
      get: async () => null,
      create: async (input): Promise<Collection> => ({ id: `col-${++counter}`, ...input, createdAt: new Date().toISOString() }),
    },
    actions: {
      register: (action) => register(actions, action.id, "action", action),
      run: async (key, args) =>
        host.runAction(key.split("/").pop() ?? key, args.resourceId ? resources.get(args.resourceId) : undefined, args.input),
    },
    events: {
      on: (type, handler) => {
        const list = handlers.get(type) ?? [];
        list.push(handler as (event: HostEvent) => void);
        handlers.set(type, list);
        return () => handlers.set(type, (handlers.get(type) ?? []).filter((h) => h !== handler));
      },
    },
    ui: {
      registerView: (view) => register(views, view.id, "view", view),
      registerMenuItem: (item) => {
        menuItems.push(item);
      },
      openExternal: async (url, opts) => {
        if (systemFailure) throw new OneDeskError("unavailable", systemFailure);
        if (!SAFE_URL.test(url)) throw new OneDeskError("validation", "只支持打开 http、https、mailto 链接");
        opened.push({ url, options: opts });
      },
      copyText: async (text) => {
        if (systemFailure) throw new OneDeskError("unavailable", systemFailure);
        copied.push(text);
      },
    },
    storage: {
      get: async <T = unknown>(key: string) => store.get(key) as T | undefined,
      set: async (key, value) => {
        store.set(key, structuredClone(value));
      },
      delete: async (key) => {
        store.delete(key);
      },
      keys: async () => [...store.keys()],
    },
    settings: {
      get: async <T = unknown>(name: string) => {
        if (options.settings && name in options.settings) return options.settings[name] as T;
        return options.manifest?.settings?.find((f) => f.name === name)?.default as T | undefined;
      },
    },
    secrets: { get: async (name) => options.secrets?.[name] },
    network: {
      fetch: async (url, init) => {
        fetchCalls.push({ url, init });
        return fetchHandler(url, init);
      },
    },
    notify: (message) => {
      notifications.push(message);
    },
    context: { workspace: { id: "ws", name: "测试工作区" }, user: { id: "u", name: "测试用户" } },

    resetRegistrations: () => {
      kinds.clear();
      actions.clear();
      views.clear();
      menuItems.length = 0;
      handlers.clear();
    },
    setFetch: (handler) => {
      fetchHandler = handler;
    },
    failSystemCalls: (message) => {
      systemFailure = message;
    },
    makeResource: (kind, body, extra) => {
      const now = new Date().toISOString();
      return {
        id: `res-${++counter}`,
        kind,
        name: "示例",
        group: "",
        tags: [],
        description: "",
        body,
        visibility: "private",
        aiVisible: false,
        version: 1,
        createdAt: now,
        updatedAt: now,
        origin: "original",
        ...extra,
      };
    },
    createResource: async (kind, body, extra) => {
      const resource = host.makeResource(kind, body, extra);
      resources.set(resource.id, resource);
      return resource;
    },
    runActionAbortable: (actionId, resource, input) => {
      const controller = new AbortController();
      return { abort: () => controller.abort(), result: host.runAction(actionId, resource, input, { signal: controller.signal }) };
    },
    runAction: async (actionId, resource, input = {}, runOptions) => {
      const signal = runOptions?.signal ?? new AbortController().signal;
      const started = Date.now();
      const finish = (r: Pick<ActionResult, "status" | "output" | "error">): ActionResult => ({
        runId: `run-${++counter}`,
        action: `${pluginId}/${actionId}`,
        resourceId: resource?.id,
        durationMs: Date.now() - started,
        finishedAt: new Date().toISOString(),
        ...r,
      });
      const action = actions.get(actionId);
      if (!action) return finish({ status: "error", error: { code: "not_found", message: "动作不存在" } });
      let actualInput = input;
      const spec = action.input;
      if (spec && !Array.isArray(spec)) {
        const defs = resource?.body[spec.fromField];
        actualInput = {};
        for (const def of Array.isArray(defs) ? defs : []) {
          const name = (def as { name?: unknown }).name;
          if (typeof name === "string" && input[name] !== undefined && input[name] !== null) actualInput[name] = String(input[name]);
        }
      }
      try {
        const raw = (await action.run(
          { resource, workspace: host.context.workspace, user: host.context.user, source: "manual", signal },
          actualInput,
        )) as ActionOutputInput;
        if (signal.aborted) return finish({ status: "cancelled" });
        const parsed = ActionOutputSchema.safeParse(raw);
        if (!parsed.success) return finish({ status: "error", error: { code: "internal", message: `动作输出不合法：${parsed.error.message}` } });
        if (parsed.data.type !== "none" && parsed.data.type !== action.output) {
          return finish({ status: "error", error: { code: "internal", message: `动作输出类型 ${parsed.data.type} 与声明 ${action.output} 不符` } });
        }
        return finish({ status: "success", output: parsed.data });
      } catch (e) {
        if (signal.aborted) return finish({ status: "cancelled" });
        const code = e instanceof OneDeskError ? e.code : "internal";
        return finish({
          status: "error",
          error: { code, message: e instanceof Error ? e.message : String(e), hint: e instanceof OneDeskError ? e.hint : undefined },
        });
      }
    },
    renderView: async (viewId, resource, state) => {
      const view = views.get(viewId);
      if (!view) throw new OneDeskError("not_found", "视图不存在");
      return view.render(resource, { revision: 1, ...state });
    },
    emit: (event) => {
      for (const h of handlers.get(event.type) ?? []) h(event);
    },
  };
  return host;
}

/** Create a fake host and activate a plugin module on it. */
export async function activatePlugin(module: PluginModule, options?: FakeHostOptions): Promise<FakeHost> {
  const host = createFakeHost(options);
  await module.activate(host);
  return host;
}
