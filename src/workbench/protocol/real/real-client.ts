import type { ConnectionState, EventMessage, HelloResult, TreePage } from "../generated";
import type { ProtocolClient } from "../client";
import type { PageEventResult, PaletteCommand, PluginDetail, Run, ViewNode, AuditFacets, AuditFilter, AuditRow, EnvOption, EnvView, HistoryEntry, ResolvedParam, SearchHit, CommandContext, CommandEffect, NewItem, PageContext, PageDescriptor, PageSaveResult, PluginGrants, Resource, TreeInfo, TreeNode, WorkspaceInfo } from "../types";
import { EventBus } from "./event-bus";
import { KernelError } from "../errors";
import type { Transport } from "./transport";

/** Must equal `PROTOCOL_VERSION` in crates/protocol. */
export const PROTOCOL_VERSION = "1";

/** The part of ProtocolClient the kernel implements in week 1 (week1-protocol §3). */
export interface KernelClient {
  readonly hello: HelloResult;
  readonly transport: Transport;
  workspace: Pick<ProtocolClient["workspace"], "info" | "getConfig" | "setConfig">;
  params: ProtocolClient["params"];
  search: ProtocolClient["search"];
  audit: ProtocolClient["audit"];
  tree: Pick<ProtocolClient["tree"], "list" | "children" | "path" | "move" | "createGroup" | "rename">;
  resource: Pick<ProtocolClient["resource"], "get" | "delete" | "history" | "restore" | "listDeleted" | "undelete" | "purge" | "setFavorite">;
  page: Pick<ProtocolClient["page"], "resolve" | "save" | "event">;
  run: ProtocolClient["run"];
  command: ProtocolClient["command"];
  plugin: Pick<ProtocolClient["plugin"], "grants" | "grantFolder" | "revokeFolder" | "get" | "setEnabled" | "setSetting" | "reload">;
  ui: ProtocolClient["ui"];
  events: ProtocolClient["events"];
  /** Connection state as last reported by the main process. */
  connection(): ConnectionState;
}

/** Removes `null` and `undefined` members: the kernel's optional fields are absent, not null. */
/** The wire type of a parameter `basis` is the node's numeric `rev`; the UI carries it as text. */
const rev = (basis?: string) => (basis === undefined || basis === "" ? undefined : Number(basis));

export function compact<T extends Record<string, unknown>>(value: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null && v !== undefined));
}

function pageContext(context?: PageContext, locale?: string): Record<string, unknown> | undefined {
  const out = compact({ envId: context?.envId, draft: context?.draft, locale });
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Says hello (version check) and returns a client for the kernel-backed methods. */
export async function createKernelClient(transport: Transport, locale?: () => string): Promise<KernelClient> {
  const call = <T,>(method: string, params?: unknown) => transport.request(method, params) as Promise<T>;
  const hello = await call<HelloResult>("hello", { protocol: PROTOCOL_VERSION });
  if (hello.protocol !== PROTOCOL_VERSION) throw new KernelError("versionMismatch", { expected: PROTOCOL_VERSION, actual: String(hello.protocol) });

  const bus = new EventBus();
  let connection: ConnectionState = "restored";
  transport.onEvent((event: EventMessage) => {
    if (event.topic === "connection") {
      connection = event.payload as ConnectionState;
      bus.emit("connection", connection);
      if (connection === "restored") bus.refreshAll();
      return;
    }
    bus.emit(event.topic, event.payload);
  });

  return {
    hello,
    transport,
    workspace: {
      info: () => call<WorkspaceInfo>("workspace.info"),
      getConfig: async (name) => ((await call<string | null>("workspace.getConfig", { name })) ?? null),
      setConfig: async (name, value) => void (await call("workspace.setConfig", { name, value })),
    },
    params: {
      env: async (envId) => ((await call<EnvView | null>("params.env", { envId })) ?? null),
      envOptions: () => call<EnvOption[]>("params.envOptions"),
      resolve: (envId, name) => call<ResolvedParam>("params.resolve", compact({ envId, name })),
      set: async (node, name, value, basis) => void (await call("params.set", compact({ node, name, value, basis: rev(basis) }))),
      unset: async (node, name, basis) => void (await call("params.unset", compact({ node, name, basis: rev(basis) }))),
      acknowledge: async (node, name, basis) => void (await call("params.acknowledge", compact({ node, name, basis: rev(basis) }))),
    },
    search: { query: (text, limit) => call<SearchHit[]>("search.query", compact({ text, limit })) },
    audit: {
      list: (filter: AuditFilter) => call<AuditRow[]>("audit.list", compact(filter)),
      facets: () => call<AuditFacets>("audit.facets"),
    },
    tree: {
      list: () => call<TreeInfo[]>("tree.list"),
      children: (tree, parent, offset) => call<TreePage>("tree.children", compact({ tree, parent, offset })),
      path: (tree, key) => call<string[]>("tree.path", { tree, key }),
      move: async (tree, key, target, position) => void (await call("tree.move", compact({ tree, key, target, position }))),
      createGroup: (tree, parent, name) => call<TreeNode>("tree.createGroup", compact({ tree, parent, name })),
      rename: async (tree, key, name) => void (await call("tree.rename", { tree, key, name })),
    },
    resource: {
      get: (id) => call<Resource | null>("resource.get", { id }),
      delete: async (id) => void (await call("resource.delete", { id })),
      history: (id) => call<HistoryEntry[]>("resource.history", { id }),
      restore: async (id, entryId) => void (await call("resource.restore", { id, entryId })),
      listDeleted: () => call<Resource[]>("resource.listDeleted"),
      undelete: async (id) => void (await call("resource.undelete", { id })),
      purge: async (id) => void (await call("resource.purge", { id })),
      setFavorite: async (id, favorite) => void (await call("resource.setFavorite", { id, favorite })),
    },
    page: {
      resolve: (target, context) => call<PageDescriptor>("page.resolve", compact({ target, context: pageContext(context, locale?.()) })),
      save: (target, changes, basis, context) => call<PageSaveResult>("page.save", compact({ target, changes, basis, context: pageContext(context, locale?.()) })),
      event: async (target, event, context) => call<PageEventResult>("page.event", compact({ target, event, context: pageContext(context, locale?.()) })),
    },
    run: {
      start: (request) => call<string>("run.start", compact({ locale: locale?.(), action: request.action, resourceId: request.resourceId, target: request.target, tabId: request.tabId, envId: request.envId, input: request.input, params: request.params })),
      get: async (id) => ((await call<Run | null>("run.get", { id })) ?? null),
      cancel: async (id) => void (await call("run.cancel", { id })),
      listFor: (resourceId) => call<Run[]>("run.listFor", { id: resourceId }),
      tasks: () => call<Run[]>("run.tasks"),
      clearFinished: async () => void (await call("run.clearFinished")),
      render: (id, tabId) => call<ViewNode[]>("run.render", compact({ id, tabId, locale: locale?.() })),
      setKept: async (id, kept) => void (await call("run.setKept", { id, kept })),
    },
    command: {
      palette: () => call<PaletteCommand[]>("command.palette"),
      newItems: () => call<NewItem[]>("command.newItems"),
      execute: (id, context: CommandContext) => call<CommandEffect[]>("command.execute", { id, context: compact({ locale: locale?.(), ...context }) }),
    },
    plugin: {
      grants: (plugin) => call<PluginGrants>("plugin.grants", { plugin }),
      grantFolder: (plugin, path) => call<PluginGrants>("plugin.grantFolder", { plugin, path }),
      revokeFolder: (plugin, path) => call<PluginGrants>("plugin.revokeFolder", { plugin, path }),
      get: async (id) => ((await call<PluginDetail | null>("plugin.get", { plugin: id })) ?? null),
      setEnabled: async (id, enabled) => void (await call("plugin.setEnabled", { plugin: id, enabled })),
      setSetting: async (id, name, value) => void (await call("plugin.setSetting", { plugin: id, name, value })),
      reload: async (id) => void (await call("plugin.reload", { plugin: id })),
    },
    ui: {
      get: async <T,>(key: string) => ((await call<T | null>("ui.get", { key })) ?? null) as T | null,
      set: async (key, value) => void (await call("ui.set", { key, value: value ?? null })),
    },
    events: { subscribe: (topic, handler) => bus.subscribe(topic, handler) },
    connection: () => connection,
  };
}
