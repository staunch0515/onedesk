import type {
  AuditFacets,
  AuditFilter,
  AuditRow,
  CommandContext,
  CommandEffect,
  DropPosition,
  EnvOption,
  EnvView,
  EventHandler,
  HistoryEntry,
  NewItem,
  PageContext,
  PageDescriptor,
  PageEventResult,
  PaletteCommand,
  PluginDetail,
  ResolvedParam,
  Resource,
  ResourcePatch,
  Run,
  RunRequest,
  SearchHit,
  TreeInfo,
  TreeNode,
  ViewNode,
  WorkspaceInfo,
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

  workspace: {
    list(): Promise<WorkspaceInfo[]>;
    /** Targets to open the first time this client connects (the welcome set, D196). */
    startTargets(): Promise<string[]>;
    /** Workspace-level configuration parameter by name (§6.2), e.g. `ui.language`. */
    getConfig(name: string): Promise<string | null>;
    setConfig(name: string, value: string): Promise<void>;
  };

  tree: {
    list(): Promise<TreeInfo[]>;
    /** Children of a node; `parentKey` null = top level. Provided trees answer in batches (§5). */
    children(tree: string, parentKey: string | null): Promise<TreeNode[]>;
    /** Keys from the root down to the node (for "reveal in tree"). */
    path(tree: string, key: string): Promise<string[]>;
    move(tree: string, key: string, targetKey: string | null, position: DropPosition): Promise<void>;
    createGroup(tree: string, parentKey: string | null, name: string): Promise<TreeNode>;
    rename(tree: string, key: string, name: string): Promise<void>;
  };

  resource: {
    get(id: string): Promise<Resource | null>;
    /** Applies a patch; with `create` the resource of a `new:` target is created first (§9.1). */
    update(id: string, patch: ResourcePatch): Promise<Resource>;
    create(newTarget: string, patch: ResourcePatch): Promise<Resource>;
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
    set(envId: string, name: string, value: string): Promise<void>;
    /** Remove this environment's own value so the inherited one applies again. */
    unset(envId: string, name: string): Promise<void>;
    /** Accept the parent's new value as the basis of this override (clears "changed upstream"). */
    acknowledge(envId: string, name: string): Promise<void>;
  };

  plugin: {
    get(id: string): Promise<PluginDetail | null>;
    setEnabled(id: string, enabled: boolean): Promise<void>;
    activateVersion(id: string, version: string): Promise<void>;
    setPinned(id: string, version: string, pinned: boolean): Promise<void>;
    setSetting(id: string, name: string, value: string): Promise<void>;
    setPermission(id: string, permission: string, granted: boolean): Promise<void>;
    reload(id: string): Promise<void>;
  };

  page: {
    /** Target → title, icon, breadcrumb, page, actions, result tabs (§9.1). */
    resolve(target: string, context?: PageContext): Promise<PageDescriptor>;
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
