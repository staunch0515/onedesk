/**
 * Kernel contracts: what the kernel needs from the platform (injected) and what it offers the shell.
 * Frozen for milestone 1 (lead session). The kernel must not import plugins/, shell/, design/, platform/.
 */
import type {
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
  ViewState,
} from "../plugin-api";

// ================================================================= platform (injected)

export type SqlParam = string | number | null;

export interface SqlDriver {
  select<T = Record<string, unknown>>(sql: string, params?: SqlParam[]): Promise<T[]>;
  execute(sql: string, params?: SqlParam[]): Promise<{ rowsAffected: number }>;
  /** Runs all statements in ONE transaction; rolls back on any failure. */
  batch(statements: Array<{ sql: string; params?: SqlParam[] }>): Promise<void>;
}

export interface Platform {
  db: SqlDriver;
  system: {
    openExternal(url: string): Promise<void>;
    copyText(text: string): Promise<void>;
  };
  network: {
    fetch(url: string, init?: NetworkRequestInit): Promise<NetworkResponse>;
  };
  secrets: {
    list(): Promise<string[]>;
    get(name: string): Promise<string | undefined>;
    set(name: string, value: string): Promise<void>;
    delete(name: string): Promise<void>;
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
  /** Raw manifest JSON (unvalidated). */
  manifest: unknown;
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
  output: string;
  isDefaultFor: string[];
}
export interface RegisteredView {
  /** `pluginId/viewId`, or `core/edit` for the generic edit view. */
  key: string;
  pluginId: string;
  id: string;
  label: string;
  icon?: string;
  kinds: string[];
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
  | { type: "action.started"; key: string; resourceId?: string }
  | { type: "action.completed"; result: ActionResult }
  | { type: "plugin.changed"; pluginId: string }
  | { type: "collection.changed"; id: string }
  | { type: "prefs.changed"; key: string }
  | { type: "notify"; pluginId?: string; message: NotifyMessage };

// ================================================================= export / import

export interface ExportBundle {
  manifest: { app: "onedesk"; formatVersion: 1; schemaVersion: number; exportedAt: string; counts: { resources: number; collections: number } };
  resources: Resource[];
  collections: Collection[];
}

export interface ImportPlan {
  newResources: Resource[];
  conflicts: Array<{ incoming: Resource; existing: Resource }>;
  newCollections: Collection[];
  conflictingCollections: Collection[];
}

// ================================================================= the kernel API used by the shell

export interface Kernel {
  events: {
    on<T extends KernelEvent["type"]>(type: T, handler: (e: Extract<KernelEvent, { type: T }>) => void): () => void;
    onAny(handler: (e: KernelEvent) => void): () => void;
  };

  resources: {
    get(id: string): Promise<Resource | null>;
    list(query?: ResourceQuery & { includeDisabled?: boolean }): Promise<Resource[]>;
    create(draft: ResourceDraft): Promise<Resource>;
    update(id: string, patch: ResourcePatch): Promise<Resource>;
    delete(id: string): Promise<void>;
    /** Body validation against the kind schema (+ kind.validate). Empty object = valid. */
    validate(kind: string, body: Record<string, unknown>): Record<string, string>;
    tags(): Promise<Array<{ tag: string; count: number }>>;
    groups(): Promise<string[]>;
  };

  /** Substring search over name, description, tags and body text; terms ANDed; name hits first. */
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
    /** Validate + load + activate (if enabled). Never throws for a single bad plugin; see loadErrors(). */
    load(sources: PluginSource[]): Promise<void>;
    list(): PluginInfo[];
    loadErrors(): PluginLoadError[];
    enable(id: string): Promise<void>;
    disable(id: string): Promise<void>;
    /** External only (D16). Returns secret names the plugin declared, so the UI can ask about deleting them. */
    uninstall(id: string): Promise<{ declaredSecrets: string[] }>;
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
    /** Kind views in declared order, then CORE_EDIT_VIEW. */
    viewsFor(kind: string): RegisteredView[];
    menuItems(): RegisteredMenuItem[];
  };

  actions: {
    /** Input fields for an action on a resource (resolves `{ fromField }`, D07). */
    inputFields(key: string, resource?: Resource): FieldDef[];
    run(key: string, args: { resourceId?: string; input?: Record<string, unknown>; source?: InvocationSource }): Promise<ActionResult>;
    /** Last result for a resource in this session. */
    lastResult(resourceId: string): ActionResult | undefined;
    isRunning(resourceId: string): boolean;
    cancel(resourceId: string): void;
  };

  views: {
    /** Render + validate. Throws Error with a user-facing message on render or validation failure. */
    render(key: string, resource: Resource, state: ViewState): Promise<ViewNode[]>;
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
    /** Apply: new items always, conflicts per decision. One DB transaction. */
    applyImport(plan: ImportPlan, decide: (resourceId: string) => "overwrite" | "skip"): Promise<{ created: number; overwritten: number; skipped: number }>;
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
