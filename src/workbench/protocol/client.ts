import type {
  ProtocolError,
  InstallAnswer,
  InstallPreview,
  InstallRequest,
  PluginVersionParams,
  SecretInfo,
  UndoUpgradeResult,
  UpgradeResult,
  TreeNode,
  TreeMoveResult,
  PageSaveResult,
  AuditFacets,
  AuditFilter,
  AuditRow,
  CommandContext,
  CommandEffect,
  DropPosition,
  EnvOption,
  EnvView,
  EventHandler,
  ExportResult,
  ImportPreview,
  ImportResult,
  KnownParam,
  RefInfo,
  RunExportResult,
  HistoryEntry,
  NewItem,
  PageContext,
  PageDescriptor,
  PageEventResult,

  PaletteCommand,
  PluginDetail,
  PluginGrants,
  ResolvedParam,
  Resource,
  Run,
  RunRequest,
  SearchHit,
  TreeInfo,
  TreePage,
  ViewNode,
  WorkspaceEntry,
  WorkspaceInfo,
  LanguageInfo,
  ShellTexts,
} from "./types";

/**
 * The only door between the workbench UI and the kernel (kernel-design §2.3, §12).
 * Methods are grouped like the protocol: workspace.*, tree.*, resource.*, params.*, plugin.*,
 * run.*, page.*, search.*, audit.*, command.*, ui.*, events.
 *
 * UI code receives a ProtocolClient through React context and must not import an implementation.
 * Stage 0 ships `createMockClient()`; the real one will forward to the worker process.
 */
export interface ProtocolClient {
  /** Protocol version; both ends compare it when connecting (§12). */
  readonly version: string;

  /**
   * Present on the mixed client (D265): says which trees and targets are still demo data, so the
   * shell can mark them. Absent: all kernel (never in week 1) or all mock (the badge is global).
   */
  /** Things only the window around the interface can do. Absent in a plain browser. */
  /** Installing and removing plugin packages (main process). Absent in pure demo mode. */
  readonly app?: {
    inspectPlugin(folder: string): Promise<InstallPreview>;
    /** `id`, `version` and `fingerprint` are what the user saw in the confirmation; the main process refuses if the package is no longer that (D312), and records the confirmation itself.
     * The files are installed when this resolves; `warning` says the automatic switch to the new version failed. */
    installPlugin(folder: string, id: string, version: string, fingerprint: string): Promise<PluginVersionParams & { warning?: ProtocolError }>;
    removePlugin(plugin: string, version: string): Promise<void>;
  };

  /** Secrets live in the system keychain; the interface can only list names and write values. Absent in pure demo mode. */
  readonly secrets?: {
    list(): Promise<SecretInfo[]>;
    set(name: string, value: string): Promise<void>;
    delete(name: string): Promise<void>;
  };

  /** Languages from language plugins (D379). Absent: only the built-in English (and the demo's own). */
  readonly i18n?: {
    languages(): Promise<LanguageInfo[]>;
    shell(locale: string): Promise<ShellTexts>;
  };

  readonly platform?: { /** Opens an address in the system browser; the main process checks the protocol again (D380). Absent in a plain browser. */ openExternal?: (url: string) => Promise<void>; pickFolder?: () => Promise<string | null>; pickSaveFile?: (name?: string) => Promise<string | null> };

  readonly demo?: { tree(id: string): boolean; target(target: string): boolean };

  workspace: {
    info(): Promise<WorkspaceInfo>;
    /** The workspaces, newest first (`app.workspaces`, D400); refresh on the `app.workspacesChanged` event. */
    list(): Promise<WorkspaceEntry[]>;
    /** A new empty workspace with this one's settings; does not switch. `invalidParams` for a name that is empty or over 100 characters. */
    create(name: string): Promise<WorkspaceEntry>;
    /** Binds this connection to the workspace. The caller reloads the interface afterwards. */
    switchTo(id: string): Promise<WorkspaceEntry>;
    rename(id: string, name: string): Promise<void>;
    /** Moves the workspace to the data directory's `trash/`. `conflict/inUse` for one a connection uses. */
    remove(id: string): Promise<void>;
    /** Targets to open the first time this client connects (the welcome set, D196). */
    startTargets(): Promise<string[]>;
    /** Workspace-level configuration parameter by name (§6.2), e.g. `ui.language`. */
    getConfig(name: string): Promise<string | null>;
    setConfig(name: string, value: string): Promise<void>;
    /** Writes the workspace as readable JSON into an empty folder (§3.5). `denied/noExport` when protection forbids it. */
    export(folder: string): Promise<ExportResult>;
    /** Reads an export folder and says what an import would do; changes nothing. */
    importPreview(folder: string): Promise<ImportPreview>;
    /** `fingerprint` is the one the preview gave; the kernel refuses if the export changed since. */
    import(folder: string, fingerprint: string, parent?: string): Promise<ImportResult>;
  };

  refs: {
    /** What this resource refers to, in field order (§10). */
    outgoing(id: string): Promise<RefInfo[]>;
    /** Who refers to this resource (deleted sources are not listed). */
    incoming(id: string): Promise<RefInfo[]>;
  };

  tree: {
    list(): Promise<TreeInfo[]>;
    /** One batch of children (≤ 200); `parentKey` null = top level; `offset` from the previous `next` (§5). Use `loadChildren` to get them all. */
    children(tree: string, parentKey: string | null, offset?: number, locale?: string): Promise<TreePage>;
    /** Keys from the root down to the node (for "reveal in tree"). */
    path(tree: string, key: string): Promise<string[]>;
    /** Moves a node; a plugin that handled the drop itself (D390) answers with an optional `message` to show instead. */
    move(tree: string, key: string, targetKey: string | null, position: DropPosition, locale?: string): Promise<TreeMoveResult | void>;
    createGroup(tree: string, parentKey: string | null, name: string): Promise<TreeNode>;
    rename(tree: string, key: string, name: string): Promise<void>;
  };

  resource: {
    get(id: string): Promise<Resource | null>;
    /** Favorite flag (local data, no history). */
    setFavorite(id: string, favorite: boolean): Promise<void>;
    /** Marks the resource (a group with its descendants) deleted (§3.4). */
    delete(id: string): Promise<void>;
    history(id: string): Promise<HistoryEntry[]>;
    /** Puts the field back to the value before this entry; recorded as a new entry (I.4). */
    restore(id: string, entryId: string): Promise<void>;
    listDeleted(): Promise<Resource[]>;
    undelete(id: string): Promise<void>;
    purge(id: string): Promise<void>;
  };

  params: {
    /** The environment page: every parameter with its source layer (I.4). */
    env(envId: string): Promise<EnvView | null>;
    envOptions(): Promise<EnvOption[]>;
    resolve(envId: string | null, name: string): Promise<ResolvedParam>;
    /** Set (or override) a value in this environment. */
    /** `basis` = `EnvView.rev` the page was drawn from; a newer change to the same parameter is a `conflict`. */
    set(envId: string, name: string, value: string, basis?: string): Promise<void>;
    /** Remove this environment's own value so the inherited one applies again. */
    unset(envId: string, name: string, basis?: string): Promise<void>;
    /** Accept the parent's new value as the basis of this override (clears "changed upstream"). */
    acknowledge(envId: string, name: string, basis?: string): Promise<void>;
    /** Parameters the kernel itself interprets: the pages offer these by name (§6.3). */
    known(): Promise<KnownParam[]>;
  };

  plugin: {
    /** Folders the plugin's `files` capability may use (D184). */
    grants(plugin: string): Promise<PluginGrants>;
    grantFolder(plugin: string, path: string): Promise<PluginGrants>;
    revokeFolder(plugin: string, path: string): Promise<PluginGrants>;
    get(id: string): Promise<PluginDetail | null>;
    setEnabled(id: string, enabled: boolean): Promise<void>;
    activateVersion(id: string, version: string): Promise<UpgradeResult>;
    setPinned(id: string, version: string, pinned: boolean): Promise<void>;
    setSetting(id: string, name: string, value: string): Promise<void>;
    setPermission(id: string, permission: string, granted: boolean): Promise<void>;
    /** Reverts an upgrade batch; resources changed since are listed in `modified` and reverted only when named in `also`. */
    undoUpgrade(batch: string, also?: string[]): Promise<UndoUpgradeResult>;
    /** The user confirmed this version's permissions. */
    confirmPermissions(id: string, version: string, fingerprint: string): Promise<void>;
    reload(id: string): Promise<void>;
    /** Plugins' requests to install a package, oldest first (round 7). Absent in demo mode. */
    installRequests?(): Promise<InstallRequest[]>;
    /** Tells the kernel how a request ended; it hands the result back to the waiting plugin. */
    answerInstallRequest?(answer: InstallAnswer): Promise<void>;
  };

  page: {
    /** Target → title, icon, breadcrumb, page, actions, result tabs (§9.1). */
    resolve(target: string, context?: PageContext): Promise<PageDescriptor>;
    /**
     * The only way bound fields are written (D259). `resource:<id>` and `new:<kind>` targets go to the
     * kernel; `changes` keys are bind paths. For `new:` the result's `target` is the new resource.
     * When `basis` is behind, the kernel saves if what changed elsewhere does not touch `changes`, else answers
     * `conflict` / `stale` with `params.fields` (comma separated bind paths) and `params.rev`; the bind paths in
     * `overwrite` (the user chose "keep mine", D374) are not counted as conflicts.
     */
    save(target: string, changes: Record<string, unknown>, basis?: string, context?: PageContext, overwrite?: string[]): Promise<PageSaveResult>;
    /** A page event with the current unsaved content (§9.3). */
    event(target: string, event: string, context: PageContext): Promise<PageEventResult>;
  };

  run: {
    /** Returns at once with the run id; progress and the end arrive as events (§8). */
    start(request: RunRequest): Promise<string>;
    get(id: string): Promise<Run | null>;
    cancel(id: string): Promise<void>;
    /** Runs of one resource, newest first (history tab). */
    listFor(resourceId: string): Promise<Run[]>;
    /** Running and just-finished runs for the task panel. */
    tasks(): Promise<Run[]>;
    clearFinished(): Promise<void>;
    /** A plugin-declared result tab drawn for a run (§9.5). */
    render(id: string, tabId: string): Promise<ViewNode[]>;
    setKept(id: string, kept: boolean): Promise<void>;
    /** Writes a finished run's table to a new file as CSV (§9.5). */
    export(id: string, path: string): Promise<RunExportResult>;
  };

  search: {
    query(text: string, limit?: number): Promise<SearchHit[]>;
  };

  audit: {
    list(filter: AuditFilter): Promise<AuditRow[]>;
    facets(): Promise<AuditFacets>;
  };

  command: {
    /** Kernel and plugin commands for the palette (the shell adds its own). */
    palette(): Promise<PaletteCommand[]>;
    /** Entries of the top bar's "New" menu. */
    newItems(): Promise<NewItem[]>;
    execute(id: string, context: CommandContext): Promise<CommandEffect[]>;
  };

  /** Per-client interface state (tabs, layout); never versioned (§9.2, D159). */
  ui: {
    get<T>(key: string): Promise<T | null>;
    set(key: string, value: unknown): Promise<void>;
  };

  events: {
    subscribe(topic: string, handler: EventHandler): () => void;
  };
}
