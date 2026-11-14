/**
 * OneDesk public plugin API — TypeScript contracts (apiVersion "1").
 * Plugins import ONLY from `@onedesk/plugin-api`. Frozen for milestone 1.
 */
import type { z } from "zod";
import type {
  ActionInputSpecSchema,
  ActionOutputSchema,
  ActionOutputTypeSchema,
  FieldDefSchema,
  FieldTypeSchema,
  InvocationSourceSchema,
  LinkNodeSchema,
  FormNodeSchema,
  ManifestSchema,
  NotifySchema,
  ParameterDefSchema,
  ResourceDraftSchema,
  ResourcePatchSchema,
  ResourceSchema,
  TableNodeSchema,
  TextNodeSchema,
  ViewNodeSchema,
  ViewTreeSchema,
} from "./schemas";

// ---------------------------------------------------------------- data shapes

export type FieldType = z.infer<typeof FieldTypeSchema>;
export type FieldDef = z.infer<typeof FieldDefSchema>;
export type ParameterDef = z.infer<typeof ParameterDefSchema>;
/** Manifest after validation (defaults applied). */
export type Manifest = z.infer<typeof ManifestSchema>;
/** Manifest as authored in manifest.json. */
export type ManifestInput = z.input<typeof ManifestSchema>;
export type Resource = z.infer<typeof ResourceSchema>;
export type ResourceDraft = z.input<typeof ResourceDraftSchema>;
export type ResourcePatch = z.infer<typeof ResourcePatchSchema>;
export type ViewNode = z.infer<typeof ViewNodeSchema>;
export type FormNode = z.infer<typeof FormNodeSchema>;
export type TableNode = z.infer<typeof TableNodeSchema>;
export type TextNode = z.input<typeof TextNodeSchema>;
export type LinkNode = z.infer<typeof LinkNodeSchema>;
export type ViewTree = z.input<typeof ViewTreeSchema>;
export type ActionOutput = z.infer<typeof ActionOutputSchema>;
export type ActionOutputType = z.infer<typeof ActionOutputTypeSchema>;
export type ActionInputSpec = z.infer<typeof ActionInputSpecSchema>;
export type InvocationSource = z.infer<typeof InvocationSourceSchema>;
export type NotifyMessage = z.input<typeof NotifySchema>;

// ---------------------------------------------------------------- capabilities a plugin registers

export interface KindDefinition {
  /** Global kind id, must be in manifest.provides.kinds. */
  id: string;
  name: string;
  /** lucide icon name. */
  icon?: string;
  schema: FieldDef[];
  /** Local action id run when the menu item is activated with the primary action. */
  defaultAction?: string;
  /** Local view ids; first one is the default view. Host always adds the generic “编辑” view (D12). */
  views: string[];
  /** Summary for AI consumers (not shown as UI). */
  describe(resource: Resource): { summary: string; usage: string };
  /** Optional extra body validation; return error messages keyed by field name. */
  validate?(body: Record<string, unknown>): Record<string, string>;
}

export interface ActionContext {
  /** The resource the action runs on (if any). */
  resource?: Resource;
  workspace: { id: string; name: string };
  user: { id: string; name: string };
  source: InvocationSource;
  /** Aborted when the user cancels or the plugin is disabled mid-run. */
  signal: AbortSignal;
}

export interface ActionDefinition {
  /** Local id, must be in manifest.provides.actions. */
  id: string;
  label: string;
  icon?: string;
  /** Kinds this action appears on (D06). Empty = global action (command palette only). */
  kinds?: string[];
  input?: ActionInputSpec;
  output: ActionOutputType;
  run(context: ActionContext, input: Record<string, unknown>): Promise<ActionOutput> | ActionOutput;
}

export interface ActionResult {
  status: "success" | "error";
  output?: ActionOutput;
  error?: { message: string; hint?: string };
  durationMs: number;
  /** Global action key `pluginId/actionId`. */
  action: string;
  resourceId?: string;
  finishedAt: string;
}

export interface ViewState {
  /** Increments whenever the resource or its last action result changes. */
  revision: number;
  lastResult?: ActionResult;
}

export interface ViewDefinition {
  /** Local id, must be in manifest.provides.views. */
  id: string;
  label: string;
  icon?: string;
  kinds: string[];
  render(resource: Resource, state: ViewState): ViewTree | Promise<ViewTree>;
}

export interface MenuItemDefinition {
  id: string;
  label: string;
  icon?: string;
  /** Local action id to run when chosen (no resource context). */
  action: string;
}

// ---------------------------------------------------------------- host API

export type Unsubscribe = () => void;

export type HostEvent =
  | { type: "resource.created"; resource: Resource }
  | { type: "resource.updated"; resource: Resource }
  | { type: "resource.deleted"; id: string; kind: string }
  | { type: "action.completed"; result: ActionResult };

export interface ResourceQuery {
  kind?: string;
  tag?: string;
  collectionId?: string;
  text?: string;
  limit?: number;
}

export interface Collection {
  id: string;
  name: string;
  rule: { type: "tag" | "kind"; value: string };
  createdAt: string;
}

export interface HostApi {
  readonly pluginId: string;

  /** Only resources of kinds registered by this plugin (D10). */
  resources: {
    registerKind(kind: KindDefinition): void;
    get(id: string): Promise<Resource | null>;
    list(query?: ResourceQuery): Promise<Resource[]>;
    create(draft: ResourceDraft): Promise<Resource>;
    update(id: string, patch: ResourcePatch): Promise<Resource>;
    delete(id: string): Promise<void>;
  };
  collections: {
    list(): Promise<Collection[]>;
    get(id: string): Promise<Collection | null>;
    create(input: { name: string; rule: Collection["rule"] }): Promise<Collection>;
  };
  actions: {
    register(action: ActionDefinition): void;
    /** Run any registered action by global key `pluginId/actionId`. */
    run(key: string, args: { resourceId?: string; input?: Record<string, unknown> }): Promise<ActionResult>;
  };
  events: {
    on<T extends HostEvent["type"]>(type: T, handler: (event: Extract<HostEvent, { type: T }>) => void): Unsubscribe;
  };
  ui: {
    registerView(view: ViewDefinition): void;
    registerMenuItem(item: MenuItemDefinition): void;
    /** Open in the system browser (D09). `profile` is reserved, ignored in milestone 1. */
    openExternal(url: string, options?: { profile?: string }): Promise<void>;
    copyText(text: string): Promise<void>;
  };
  /** Per-plugin key-value store, JSON values. */
  storage: {
    get<T = unknown>(key: string): Promise<T | undefined>;
    set(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
    keys(): Promise<string[]>;
  };
  /** Read-only settings values for this plugin (from manifest.settings). */
  settings: {
    get<T = unknown>(name: string): Promise<T | undefined>;
  };
  /** Keychain-backed, only names declared in manifest.requires.secrets (D14). */
  secrets: {
    get(name: string): Promise<string | undefined>;
  };
  /** Only hosts declared in manifest.requires.network (D13). */
  network: {
    fetch(url: string, init?: NetworkRequestInit): Promise<NetworkResponse>;
  };
  notify(message: NotifyMessage): void;
  context: {
    workspace: { id: string; name: string };
    user: { id: string; name: string };
  };
}

export interface NetworkRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface NetworkResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  durationMs: number;
}

// ---------------------------------------------------------------- plugin module

export interface PluginModule {
  activate(host: HostApi): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}
