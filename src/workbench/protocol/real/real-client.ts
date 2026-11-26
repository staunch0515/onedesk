import type { AssistProvider, PackageImportResult, PackageInfo, BlobInfo, ConnectionState, EmbedActResult, EmbedResult, RefSuggestion, EventMessage, HelloResult, TreePage } from "../generated";
import type { ProtocolClient } from "../client";
import type { ExportResult, ImportPreview, ImportResult, KnownParam, RefInfo, RunExportResult, InstallPreview, InstallRequest, PluginVersionParams, SecretInfo, UndoUpgradeResult, UpgradeResult, PageEventResult, PaletteCommand, PluginDetail, Run, ViewNode, TreeMoveResult, AuditFacets, AuditFilter, McpInfo, McpStatus, AuditRow, EnvOption, EnvView, HistoryEntry, ResolvedParam, ResultAction, SearchHit, CommandContext, CommandEffect, NewItem, PageContext, PageDescriptor, PageSaveResult, PluginGrants, Resource, TreeInfo, TreeNode, WorkspaceEntry, WorkspacesResult, WorkspaceInfo, LanguageInfo, ShellTexts } from "../types";
import { EventBus } from "./event-bus";
import { KernelError } from "../errors";
import type { Transport } from "./transport";

/** Must equal `PROTOCOL_VERSION` in crates/protocol. */
export const PROTOCOL_VERSION = "1";

/** The part of ProtocolClient the kernel implements in week 1 (week1-protocol §3). */
export interface KernelClient {
  readonly hello: HelloResult;
  readonly transport: Transport;
  workspace: Pick<ProtocolClient["workspace"], "info" | "list" | "create" | "switchTo" | "rename" | "remove" | "openWindow" | "getConfig" | "setConfig" | "export" | "importPreview" | "import" | "packageInspect" | "packageImport">;
  params: ProtocolClient["params"];
  refs: ProtocolClient["refs"];
  search: ProtocolClient["search"];
  audit: ProtocolClient["audit"];
  mcp: ProtocolClient["mcp"];
  tree: Pick<ProtocolClient["tree"], "list" | "children" | "path" | "move" | "createGroup" | "rename">;
  resource: Pick<ProtocolClient["resource"], "get" | "delete" | "history" | "restore" | "listDeleted" | "undelete" | "purge" | "setFavorite" | "setAiVisible">;
  page: Pick<ProtocolClient["page"], "resolve" | "save" | "event">;
  run: ProtocolClient["run"];
  result: ProtocolClient["result"];
  assist?: ProtocolClient["assist"];
  blob?: ProtocolClient["blob"];
  command: ProtocolClient["command"];
  plugin: Pick<ProtocolClient["plugin"], "grants" | "grantFolder" | "revokeFolder" | "replaceFolder" | "get" | "setEnabled" | "setSetting" | "reload" | "activateVersion" | "setPinned" | "undoUpgrade" | "confirmPermissions" | "installRequests" | "answerInstallRequest">;
  app: NonNullable<ProtocolClient["app"]>;
  secrets: NonNullable<ProtocolClient["secrets"]>;
  ui: ProtocolClient["ui"];
  /** `i18n.languages` / `i18n.shell` (D379). */
  i18n: NonNullable<ProtocolClient["i18n"]>;
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
  const out = compact({ envId: context?.envId, draft: context?.draft, params: context?.params, row: context?.row, locale: context?.locale ?? locale });
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
      list: async () => (await call<WorkspacesResult>("app.workspaces")).items,
      create: (name) => call<WorkspaceEntry>("app.createWorkspace", { name }),
      switchTo: (id) => call<WorkspaceEntry>("app.switchWorkspace", { id }),
      rename: async (id, name) => void (await call("app.renameWorkspace", { id, name })),
      remove: async (id) => void (await call("app.deleteWorkspace", { id })),
      openWindow: async (id) => {
        if (!transport.openWindow) throw new KernelError("unsupported", {});
        await transport.openWindow(id);
      },
      getConfig: async (name) => ((await call<string | null>("workspace.getConfig", { name })) ?? null),
      setConfig: async (name, value) => void (await call("workspace.setConfig", { name, value })),
      export: (folder) => call<ExportResult>("workspace.export", { folder }),
      importPreview: (folder) => call<ImportPreview>("workspace.importPreview", { folder }),
      import: (folder, fingerprint, parent) => call<ImportResult>("workspace.import", compact({ folder, fingerprint, parent })),
      packageInspect: (path) => call<PackageInfo>("package.inspect", { path }),
      packageImport: (path) => call<PackageImportResult>("package.import", { path }),
    },
    refs: {
      outgoing: (id) => call<RefInfo[]>("refs.outgoing", { id }),
      incoming: (id) => call<RefInfo[]>("refs.incoming", { id }),
      suggest: (text, limit) => call<RefSuggestion[]>("refs.suggest", compact({ text, limit })),
      rewrite: (source, field, seq) => call<{ text: string }>("refs.rewrite", { source, field, seq }),
      embed: (p) => call<EmbedResult>("resource.embed", compact({ id: p.id, section: p.section, envId: p.envId ?? undefined, locale: locale?.(), args: p.args ?? undefined, params: p.params, inline: p.inline })),
      embedAct: (p) => call<EmbedActResult>("resource.embedAct", compact({ id: p.id, section: p.section, envId: p.envId ?? undefined, locale: locale?.(), args: p.args ?? undefined, params: p.params, action: p.action, values: p.values })),
    },
    params: {
      env: async (envId) => ((await call<EnvView | null>("params.env", { envId })) ?? null),
      envOptions: () => call<EnvOption[]>("params.envOptions"),
      resolve: (envId, name) => call<ResolvedParam>("params.resolve", compact({ envId, name })),
      set: async (node, name, value, basis, type) => void (await call("params.set", compact({ node, name, value, basis: rev(basis), type }))),
      unset: async (node, name, basis) => void (await call("params.unset", compact({ node, name, basis: rev(basis) }))),
      acknowledge: async (node, name, basis) => void (await call("params.acknowledge", compact({ node, name, basis: rev(basis) }))),
      rename: async (node, name, newName, basis) => void (await call("params.rename", compact({ node, name, newName, basis: rev(basis) }))),
      known: () => call<KnownParam[]>("params.known"),
    },
    app: {
      inspectPlugin: (folder) => call<InstallPreview>("app.inspectPlugin", { folder }),
      installPlugin: (folder, id, version, fingerprint) => call<PluginVersionParams>("app.installPlugin", { folder, id, version, fingerprint }),
      removePlugin: async (plugin, version) => void (await call("app.removePlugin", { plugin, version })),
      mcpInfo: () => call<McpInfo>("app.mcpInfo", {}),
    },
    secrets: {
      list: () => call<SecretInfo[]>("secrets.list"),
      set: async (name, value) => void (await call("secrets.set", { name, value })),
      delete: async (name) => void (await call("secrets.delete", { name })),
    },
    search: { query: (text, limit) => call<SearchHit[]>("search.query", compact({ text, limit })) },
    mcp: { status: () => call<McpStatus>("mcp.status", {}) },
    audit: {
      list: (filter: AuditFilter) => call<AuditRow[]>("audit.list", compact(filter)),
      facets: () => call<AuditFacets>("audit.facets"),
    },
    tree: {
      list: () => call<TreeInfo[]>("tree.list"),
      children: (tree, parent, offset, locale) => call<TreePage>("tree.children", compact({ tree, parent, offset, locale })),
      path: (tree, key) => call<string[]>("tree.path", { tree, key }),
      move: async (tree, key, target, position, locale) => {
        const out = await call<TreeMoveResult | null | undefined>("tree.move", compact({ tree, key, target, position, locale }));
        return out ?? undefined;
      },
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
      setAiVisible: (id, visible, withChildren) => call("resource.setAiVisible", compact({ id, visible, withChildren })),
    },
    page: {
      resolve: (target, context) => call<PageDescriptor>("page.resolve", compact({ target, context: pageContext(context, locale?.()) })),
      save: (target, changes, basis, context, overwrite) => call<PageSaveResult>("page.save", compact({ target, changes, basis, overwrite: overwrite && overwrite.length > 0 ? overwrite : undefined, context: pageContext(context, locale?.()) })),
      event: async (target, event, context) => call<PageEventResult>("page.event", compact({ target, event, context: pageContext(context, locale?.()) })),
    },
    result: {
      actions: async (runId) => (await call<ResultAction[] | null>("result.actions", { runId })) ?? [],
    },
    assist: {
      provider: () => call<AssistProvider>("assist.provider"),
    },
    blob: {
      put: (p) => call<BlobInfo>("blob.put", compact({ data: p.data, path: p.path })),
      read: (blob, resource) => call<{ type: string; data: string }>("blob.read", compact({ blob, resource })),
    },
    run: {
      start: (request) => call<string>("run.start", compact({ locale: locale?.(), action: request.action, resourceId: request.resourceId, target: request.target, tabId: request.tabId, envId: request.envId, input: request.input, params: request.params, resultRun: request.resultRun })),
      get: async (id) => ((await call<Run | null>("run.get", { id })) ?? null),
      cancel: async (id) => void (await call("run.cancel", { id })),
      listFor: (resourceId) => call<Run[]>("run.listFor", { id: resourceId }),
      tasks: () => call<Run[]>("run.tasks"),
      clearFinished: async () => void (await call("run.clearFinished")),
      render: (id, tabId) => call<ViewNode[]>("run.render", compact({ id, tabId, locale: locale?.() })),
      setKept: async (id, kept, name) => void (await call("run.setKept", compact({ id, kept, name }))),
      rows: (id, offset, limit) => call<{ rows: Array<Array<string | number | null>>; total: number }>("run.rows", { id, offset, limit }),
      export: (id, path) => call<RunExportResult>("run.export", { run: id, path, format: "csv" }),
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
      replaceFolder: (plugin, path, newPath) => call<PluginGrants>("plugin.replaceFolder", { plugin, path, newPath }),
      get: async (id) => ((await call<PluginDetail | null>("plugin.get", { plugin: id })) ?? null),
      setEnabled: async (id, enabled) => void (await call("plugin.setEnabled", { plugin: id, enabled })),
      setSetting: async (id, name, value) => void (await call("plugin.setSetting", { plugin: id, name, value })),
      reload: async (id) => void (await call("plugin.reload", { plugin: id })),
      activateVersion: (id, version) => call<UpgradeResult>("plugin.activateVersion", { plugin: id, version }),
      setPinned: async (id, version, pinned) => void (await call("plugin.setPinned", { plugin: id, version, pinned })),
      undoUpgrade: (batch, also) => call<UndoUpgradeResult>("plugin.undoUpgrade", { batch, also: also ?? [] }),
      confirmPermissions: async (id, version, fingerprint) => void (await call("plugin.confirmPermissions", { plugin: id, version, fingerprint })),
      installRequests: () => call<InstallRequest[]>("plugin.installRequests"),
      answerInstallRequest: async (answer) => void (await call("plugin.answerInstallRequest", compact({ ...answer }))),
    },
    ui: {
      get: async <T,>(key: string) => ((await call<T | null>("ui.get", { key })) ?? null) as T | null,
      set: async (key, value) => void (await call("ui.set", { key, value: value ?? null })),
    },
    i18n: {
      languages: () => call<LanguageInfo[]>("i18n.languages"),
      shell: (locale) => call<ShellTexts>("i18n.shell", { locale }),
    },
    events: { subscribe: (topic, handler) => bus.subscribe(topic, handler) },
    connection: () => connection,
  };
}
