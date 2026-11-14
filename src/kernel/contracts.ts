/**
 * Kernel contracts: what the kernel needs from the platform (injected) and what it offers the shell.
 * Frozen for milestone 1 (lead session). The kernel must not import plugins/, shell/, design/, platform/.
 */
import type {
  ActionOutputType,
  ActionResult,
  Collection,
  FieldDef,
  InvocationSource,
  KindDefinition,
  Manifest,
  MenuItemDefinition,
  NetworkRequestInit,
  NetworkResponse,
  NotifyMessage,
  PluginModule,
  Resource,
  ResourceDraft,
  ResourcePatch,
  ResourceQuery,
  ViewNode,
} from "../plugin-api";

// ================================================================= platform (injected)

export type SqlParam = string | number | null;

// Shapes returned by Rust commands (see src/platform/contract.ts), defined here so the kernel stays platform-free.
export interface AppStatus {
  /** Absolute data dir, e.g. /Users/me/Library/Application Support/onedesk */
  dataDir: string;
  dbPath: string;
  schemaVersion: number;
  /** Latest migration available in this build. */
  latestSchemaVersion: number;
  /** Set when a migration failed and was rolled back; the UI must block usage (D21). */
  migrationError: string | null;
  /** Snapshot file names in backups/, newest first. */
  backups: string[];
}

export interface ScannedPlugin {
  /** Absolute folder path. */
  dir: string;
  /** Raw manifest.json text, or null if missing/unreadable. */
  manifestText: string | null;
  /** Entry module source (manifest.main, default index.js), or null if missing. */
  entrySource: string | null;
  /** File-system level problem (missing manifest, unreadable entry…), Chinese. */
  error: string | null;
}


/**
 * SQL access. Placeholders are `?`. Integral numbers bind as INTEGER, others as REAL; booleans are stored 0/1
 * by the caller. Errors reject with OneDeskError("internal") carrying a Chinese message.
 */
export interface SqlDriver {
  select<T = Record<string, unknown>>(sql: string, params?: SqlParam[]): Promise<T[]>;
  execute(sql: string, params?: SqlParam[]): Promise<{ rowsAffected: number }>;
  /** Runs all statements in ONE transaction; rolls back on any failure. Returns rowsAffected per statement. */
  batch(statements: Array<{ sql: string; params?: SqlParam[] }>): Promise<number[]>;
}

export interface Platform {
  db: SqlDriver;
  system: {
    openExternal(url: string): Promise<void>;
    copyText(text: string): Promise<void>;
  };
  network: {
    /**
     * `redirect: "manual"` → return 3xx responses as-is (with `location` header) so the host can re-check each hop
     * against the plugin's network allowlist (D13); default `"follow"`.
     */
    fetch(url: string, init?: NetworkRequestInit & { redirect?: "manual" | "follow" }): Promise<NetworkResponse>;
  };
  secrets: {
    list(): Promise<string[]>;
    get(name: string): Promise<string | undefined>;
    set(name: string, value: string): Promise<void>;
    delete(name: string): Promise<void>;
  };
  /** Used by the shell's composition root (src/shell/bootstrap.ts), not by the kernel itself. */
  app: {
    status(): Promise<AppStatus>;
  };
  plugins: {
    scan(): Promise<ScannedPlugin[]>;
  };
  files: {
    /** Native folder picker; null if cancelled. */
    pickFolder(title: string): Promise<string | null>;
    exportWrite(parentDir: string, files: Array<{ name: string; content: string }>): Promise<string>;
    importRead(dir: string): Promise<{ resources: string; collections: string; manifest: string }>;
  };
  /** Injectable for tests. */
  now?(): Date;
  randomId?(): string;
}

// ================================================================= plugin loading

/** Built-in and external plugins are both described this way (D01): same load path, different origin. */
export interface PluginSource {
  origin: "builtin" | "external";
  /** Folder path for external plugins, module path for built-ins. Used in error reports. */
  location: string;
  /** Raw manifest JSON (unvalidated); null when it could not be read. */
  manifest: unknown;
  /** File-system level problem found while scanning (missing/invalid manifest, missing entry). Reported, not loaded. */
  error?: string;
  /** Resolves the module's `default` export. */
  load(): Promise<PluginModule>;
}

export interface PluginLoadError {
  origin: PluginSource["origin"];
  location: string;
  pluginId?: string;
  /** User-facing reason, Chinese. */
  reason: string;
}

export type PluginState = "enabled" | "disabled";

export interface PluginInfo {
  manifest: Manifest;
  origin: PluginSource["origin"];
  location: string;
  state: PluginState;
  /** Set when activation failed; plugin is then treated as disabled. */
  activationError?: string;
  /** Number of stored resources of kinds this plugin provides (kept when disabled). */
  resourceCount: number;
}

// ================================================================= registry views of registered capabilities

export interface RegisteredKind extends KindDefinition {
  pluginId: string;
}
export interface RegisteredAction {
  /** `pluginId/actionId` */
  key: string;
  pluginId: string;
  id: string;
  label: string;
  icon?: string;
  kinds: string[];
  output: ActionOutputType;
  isDefaultFor: string[];
}
export interface RegisteredView {
  /** `pluginId/viewId`, or `core/edit` for the generic edit view. */
  key: string;
  pluginId: string;
  id: string;
  label: string;
  icon?: string;
}
export interface RegisteredMenuItem extends MenuItemDefinition {
  pluginId: string;
  /** Global action key. */
  actionKey: string;
}

export const CORE_EDIT_VIEW = "core/edit";

// ================================================================= events (shell-facing superset of HostEvent)

export type KernelEvent =
  | { type: "resource.created"; resource: Resource }
  | { type: "resource.updated"; resource: Resource }
  | { type: "resource.deleted"; id: string; kind: string }
  | { type: "action.started"; runId: string; key: string; resourceId?: string }
  | { type: "action.completed"; result: ActionResult }
  | { type: "plugin.changed"; pluginId: string }
  | { type: "collection.changed"; id: string }
  | { type: "prefs.changed"; key: string }
  | { type: "notify"; pluginId?: string; message: NotifyMessage };

// ================================================================= export / import

/**
 * Export folder = resources.json, collections.json, plugins.json, manifest.json, attachments/ (empty in milestone 1).
 * plugins.json (enabled state, settings, plugin storage) is export-only in milestone 1; import restores resources
 * and collections only. Secrets are never exported.
 */
export interface ExportBundle {
  manifest: { app: "onedesk"; formatVersion: 1; schemaVersion: number; exportedAt: string; counts: { resources: number; collections: number } };
  resources: Resource[];
  collections: Collection[];
  plugins: Array<{ id: string; enabled: boolean; settings: Record<string, unknown>; storage: Record<string, unknown> }>;
}

/** Imported items keep their id, version, createdAt, updatedAt, origin. Unknown kinds are imported (shown as orphaned). */
export interface ImportPlan {
  newResources: Resource[];
  conflicts: Array<{ incoming: Resource; existing: Resource }>;
  newCollections: Collection[];
  collectionConflicts: Array<{ incoming: Collection; existing: Collection }>;
}

// ================================================================= the kernel API used by the shell

export interface Kernel {
  events: {
    on<T extends KernelEvent["type"]>(type: T, handler: (e: Extract<KernelEvent, { type: T }>) => void): () => void;
    onAny(handler: (e: KernelEvent) => void): () => void;
  };

  resources: {
    get(id: string): Promise<Resource | null>;
    /** includeDisabled: also resources whose kind is not currently registered (disabled or missing plugin). */
    list(query?: ResourceQuery & { includeDisabled?: boolean }): Promise<Resource[]>;
    create(draft: ResourceDraft): Promise<Resource>;
    update(id: string, patch: ResourcePatch): Promise<Resource>;
    delete(id: string): Promise<void>;
    /** Body validation against the kind schema (+ kind.validate). Empty object = valid. */
    validate(kind: string, body: Record<string, unknown>): Record<string, string>;
    tags(): Promise<Array<{ tag: string; count: number }>>;
    groups(): Promise<string[]>;
  };

  /**
   * Substring search over name, description, tags and body strings. Query and search_text are lower-cased with
   * JS toLowerCase; matching uses SQLite instr(). Whitespace-separated terms ANDed; name hits first, then updatedAt desc.
   */
  search(text: string, options?: { kinds?: string[]; limit?: number; includeDisabled?: boolean }): Promise<Resource[]>;

  collections: {
    list(): Promise<Collection[]>;
    get(id: string): Promise<Collection | null>;
    create(input: { name: string; rule: Collection["rule"] }): Promise<Collection>;
    update(id: string, input: { name?: string; rule?: Collection["rule"] }): Promise<Collection>;
    delete(id: string): Promise<void>;
    resources(id: string): Promise<Resource[]>;
  };

  plugins: {
    /**
     * Called once at startup (rescan = restart in milestone 1). Validate + load + activate (if enabled).
     * Never throws for a single bad plugin; see loadErrors(). First sight inserts a `plugins` row:
     * built-in → enabled, external → disabled until the user enables it. Uninstalled external plugins are skipped.
     */
    load(sources: PluginSource[]): Promise<void>;
    list(): PluginInfo[];
    loadErrors(): PluginLoadError[];
    enable(id: string): Promise<void>;
    disable(id: string): Promise<void>;
    /** External only (D16). Returns secret names the plugin declared, so the UI can ask about deleting them. */
    uninstall(id: string): Promise<{ declaredSecrets: string[] }>;
    /** Uninstalled external plugins still present on disk (from the last load's sources). */
    uninstalled(): Array<{ id: string; name: string; location: string }>;
    /** Clear the uninstalled flag and load the plugin from its source (disabled until enabled, D54). */
    reinstall(id: string): Promise<void>;
    /** Stored values merged over manifest.settings defaults. */
    getSettings(id: string): Promise<Record<string, unknown>>;
    setSettings(id: string, values: Record<string, unknown>): Promise<void>;
  };

  registry: {
    kinds(): RegisteredKind[];
    kind(id: string): RegisteredKind | undefined;
    /** Plugin id providing the kind, even if currently disabled (from manifests). */
    kindOwner(id: string): string | undefined;
    actionsFor(kind: string): RegisteredAction[];
    action(key: string): RegisteredAction | undefined;
    /** KindDefinition.views in order, then CORE_EDIT_VIEW. */
    viewsFor(kind: string): RegisteredView[];
    menuItems(): RegisteredMenuItem[];
  };

  actions: {
    /** Input fields for an action on a resource (resolves `{ fromField }`, D07). */
    inputFields(key: string, resource?: Resource): FieldDef[];
    /**
     * Never throws: unknown key, disabled plugin, invalid input, plugin exception, wrong output type → error result.
     * Runs asynchronously; the UI stays responsive.
     */
    run(key: string, args: { resourceId?: string; input?: Record<string, unknown>; source?: InvocationSource }): Promise<ActionResult>;
    /** Last result for a resource in this session. */
    lastResult(resourceId: string): ActionResult | undefined;
    running(): Array<{ runId: string; key: string; resourceId?: string; startedAt: string }>;
    cancel(runId: string): void;
  };

  views: {
    /** Kernel builds ViewState, renders, validates. Throws OneDeskError on render or validation failure. */
    render(key: string, resourceId: string): Promise<ViewNode[]>;
  };

  prefs: {
    get<T = unknown>(key: string): Promise<T | undefined>;
    set(key: string, value: unknown): Promise<void>;
  };

  secrets: Platform["secrets"];

  data: {
    exportAll(): Promise<ExportBundle>;
    /** Parse + validate an import bundle and compute conflicts. Throws with a user-facing message if invalid. */
    planImport(files: { resources: unknown; collections: unknown; manifest: unknown }): Promise<ImportPlan>;
    /** Apply: new items always, conflicts per decision (keyed by id). One DB transaction. */
    applyImport(
      plan: ImportPlan,
      decide: (conflict: { type: "resource" | "collection"; id: string }) => "overwrite" | "skip",
    ): Promise<{ created: number; overwritten: number; skipped: number }>;
  };

  context: { workspace: { id: string; name: string }; user: { id: string; name: string } };
}

export interface KernelOptions {
  platform: Platform;
  /** Override workspace/user (tests). */
  context?: Kernel["context"];
}

/** Implemented in src/kernel/index.ts by the kernel session. Migrations must already be applied to the DB. */
export type CreateKernel = (options: KernelOptions) => Promise<Kernel>;
