import type { ConnectionState, EventMessage, HelloResult, TreePage } from "../generated";
import type { ProtocolClient } from "../client";
import type { CommandContext, CommandEffect, NewItem, PageContext, PageDescriptor, PageSaveResult, PluginGrants, Resource, TreeInfo, TreeNode, WorkspaceInfo } from "../types";
import { EventBus } from "./event-bus";
import { KernelError } from "../errors";
import type { Transport } from "./transport";

/** Must equal `PROTOCOL_VERSION` in crates/protocol. */
export const PROTOCOL_VERSION = "1";

/** The part of ProtocolClient the kernel implements in week 1 (week1-protocol §3). */
export interface KernelClient {
  readonly hello: HelloResult;
  readonly transport: Transport;
  workspace: Pick<ProtocolClient["workspace"], "info">;
  tree: Pick<ProtocolClient["tree"], "list" | "children" | "path" | "move" | "createGroup" | "rename">;
  resource: Pick<ProtocolClient["resource"], "get" | "delete">;
  page: Pick<ProtocolClient["page"], "resolve" | "save">;
  command: Pick<ProtocolClient["command"], "newItems" | "execute">;
  plugin: Pick<ProtocolClient["plugin"], "grants" | "grantFolder" | "revokeFolder">;
  ui: ProtocolClient["ui"];
  events: ProtocolClient["events"];
  /** Connection state as last reported by the main process. */
  connection(): ConnectionState;
}

/** Removes `null` and `undefined` members: the kernel's optional fields are absent, not null. */
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
    workspace: { info: () => call<WorkspaceInfo>("workspace.info") },
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
    },
    page: {
      resolve: (target, context) => call<PageDescriptor>("page.resolve", compact({ target, context: pageContext(context, locale?.()) })),
      save: (target, changes, basis, context) => call<PageSaveResult>("page.save", compact({ target, changes, basis, context: pageContext(context, locale?.()) })),
    },
    command: {
      newItems: () => call<NewItem[]>("command.newItems"),
      execute: (id, context: CommandContext) => call<CommandEffect[]>("command.execute", { id, context: compact(context) }),
    },
    plugin: {
      grants: (plugin) => call<PluginGrants>("plugin.grants", { plugin }),
      grantFolder: (plugin, path) => call<PluginGrants>("plugin.grantFolder", { plugin, path }),
      revokeFolder: (plugin, path) => call<PluginGrants>("plugin.revokeFolder", { plugin, path }),
    },
    ui: {
      get: async <T,>(key: string) => ((await call<T | null>("ui.get", { key })) ?? null) as T | null,
      set: async (key, value) => void (await call("ui.set", { key, value: value ?? null })),
    },
    events: { subscribe: (topic, handler) => bus.subscribe(topic, handler) },
    connection: () => connection,
  };
}
