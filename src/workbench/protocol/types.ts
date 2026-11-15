/**
 * Protocol types between the workbench UI and the kernel (kernel-design §12).
 * The types the kernel speaks are generated from `crates/protocol` (never edited here) and
 * re-exported below. Everything after them is DEMO ONLY ("演示，未进协议"): types for the
 * parts still served by the mock (environments, runs, plugin pages, audit, search).
 * The UI knows no resource kind: it draws what these shapes describe.
 */
import type {
  CommandContext as KernelCommandContext,
  CommandEffect as KernelEffect,
  FieldOption,
  Label,
  NodeState,
  OutputColumn,
  PageContext as KernelPageContext,
  PageDescriptor as KernelPageDescriptor,
  Resource as KernelResource,
  ViewNode as KernelViewNode,
} from "./generated";

export type {
  ActionDecl,
  ActionRole,
  CommandExecuteParams,
  ConnectionState,
  Crumb,
  DropPosition,
  ErrorCode,
  FieldKind,
  FieldOption,
  FormLayout,
  HelloResult,
  Label,
  MenuCommand,
  NewItem,
  NodeState,
  OutputColumn,
  PageKind,
  PluginGrants,
  ProtocolError,
  ResultTabDecl,
  ToastTone,
  Tone,
  TreeInfo,
  TreeNode,
  TreePage,
  ViewField,
  WorkspaceInfo,
} from "./generated";

/**
 * The UI-side shapes below are supersets of the generated ones (the UI keeps `null` and loose
 * JSON values); the real client converts when it sends and the mock never needed to.
 */
export type CommandContext = Omit<KernelCommandContext, "nodeKey" | "args"> & { nodeKey?: string | null; args?: Record<string, unknown> };
export type PageContext = Omit<KernelPageContext, "envId" | "draft"> & { envId?: string | null; draft?: Record<string, unknown> };
export type Resource = Omit<KernelResource, "body"> & { body: Record<string, unknown> };
export type PageDescriptor = Omit<KernelPageDescriptor, "view" | "values"> & { view: ViewNode[]; values: Record<string, unknown> };

export type PageSaveResult = { page: PageDescriptor };

/** Demo only: the workspace switcher list (the kernel has one workspace in week 1). */
export interface WorkspaceEntry {
  id: string;
  name: string;
  current: boolean;
}

/** Demo only: tells the user a demo page is not built yet. Never produced by the kernel. */
export type PlaceholderNode = { type: "placeholder"; id: string; icon: string; message: Label; action?: { label: Label; disabled?: boolean } };

/** The four kernel nodes plus the demo-only placeholder. */
export type ViewNode = KernelViewNode | PlaceholderNode;

/**
 * What the shell does after a command: the kernel's effects plus two demo-only ones
 * (`set-tab-env`, `show-tasks`); `open` may also carry demo tab state.
 */
export type CommandEffect =
  | Exclude<KernelEffect, { type: "open" }>
  | { type: "open"; target: string; state?: { params?: Record<string, string>; envId?: string | null } }
  | { type: "set-tab-env"; envId: string }
  | { type: "show-tasks" };

export type Locale = "en-US" | "zh-CN";

/* ------------------------------------------------------------------ workspace */

/* ------------------------------------------------------------------ trees (§5) */

/* ------------------------------------------------------------------ resources (§3.3) */

/** Field paths → new values, e.g. `{ "name": "…", "body.sql": "…" }`. One write = one history entry + one audit row (§4). */
export type ResourcePatch = Record<string, unknown>;

export interface HistoryEntry {
  id: string;
  at: number;
  actor: string;
  /** Field path that changed. */
  field: string;
  before: string;
  after: string;
  /** Set when this entry is itself a restore. */
  restoredFrom?: string;
}

/* ------------------------------------------------------------------ pages (§9) */

export interface PageEventResult {
  /** Bound fields the plugin wants changed; applied to the unsaved content. */
  changes?: Record<string, unknown>;
  message?: Label;
}

/* ------------------------------------------------------------------ params & environments (§6) */

export type ParamType = "text" | "number" | "boolean" | "list" | "secret" | "ref";

export interface EnvParam {
  name: string;
  type: ParamType;
  /** Effective value as text. Secrets give only the keychain entry name. */
  value: string;
  /** Display text for refs (resource name). */
  display?: string;
  /** Environment that supplies the effective value. */
  sourceId: string;
  sourceName: string;
  /** Defined in this environment (not only inherited). */
  own: boolean;
  /** What the parent chain would give without this environment's value. */
  inherited?: { value: string; sourceName: string };
  /**
   * Present when an ancestor defines this parameter (the page shows the icon only when the value is inherited,
   * not when this environment sets it itself): every ancestor from the root down to the parent with the
   * value it sets itself (null = not set there). `effective` marks the layer the inherited value comes from.
   */
  layers?: Array<{ envId: string; name: string; value: string | null; effective: boolean }>;
  /** The parent's value changed after this environment overrode it (I.4). */
  changedUpstream?: { was: string; now: string };
  /** A wider value here is not in effect because an upper layer is stricter (§6.3). */
  restricted?: Label;
  /** Resources that declared this parameter (§6.2). */
  declaredBy: string[];
  description?: Label;
}

export interface EnvView {
  id: string;
  name: string;
  description: string;
  chain: Array<{ id: string; name: string }>;
  params: EnvParam[];
  /** Open tabs are the UI's business; the kernel only reports children. */
  children: Array<{ id: string; name: string }>;
}

export interface EnvOption {
  id: string;
  name: string;
  depth: number;
}

export interface ResolvedParam {
  name: string;
  found: boolean;
  value: string;
  display: string;
  sourceName: string;
}

/* ------------------------------------------------------------------ plugins (§7) */

export interface PluginVersion {
  version: string;
  installedAt: number;
  active: boolean;
  pinned: boolean;
  notes: string;
}

export interface PluginSetting {
  name: string;
  label: Label;
  kind: "text" | "number" | "boolean" | "enum";
  value: string;
  options?: FieldOption[];
  hint?: Label;
}

export interface PluginPermission {
  id: string;
  label: Label;
  detail: string;
  granted: boolean;
  required: boolean;
}

export interface PluginDetail {
  id: string;
  name: Label;
  icon: string;
  description: Label;
  author: string;
  license: string;
  homepage: string;
  enabled: boolean;
  builtin: boolean;
  versions: PluginVersion[];
  settings: PluginSetting[];
  permissions: PluginPermission[];
  provides: { kinds: Label[]; actions: Label[]; trees: Label[]; resultTabs: Label[]; other: Label[] };
  load: { state: "loaded" | "disabled" | "error" | "not-installed"; message?: string; at?: number; ms?: number };
  resourceCount: number;
}

/* ------------------------------------------------------------------ runs (§8) */

export type RunStatus = "running" | "success" | "error" | "cancelled";
export type OutputCell = string | number | null;

export type RunOutput =
  | { type: "table"; columns: OutputColumn[]; rows: OutputCell[][]; total: number; truncated: boolean }
  | { type: "text"; text: string }
  | { type: "none" };

export interface Run {
  id: string;
  /** Short running number shown to the user. */
  seq: number;
  title: string;
  icon: string;
  resourceId?: string;
  action: string;
  actionLabel: Label;
  tabId?: string;
  envId?: string;
  envName?: string;
  actor: string;
  source: "user" | "scheduled" | "ai" | "system";
  startedAt: number;
  endedAt?: number;
  status: RunStatus;
  params: Record<string, string>;
  /** What was actually used, possibly unsaved (§8 input snapshot). */
  input: Record<string, unknown>;
  progress?: { fraction?: number; message?: string };
  summary?: { rows?: number; message?: string; durationMs?: number };
  error?: { code: string; message: string; detail?: string; hint?: string };
  /** Output is carried by `run.get`; lists leave it out. */
  output?: RunOutput;
  kept: boolean;
  /** Listed in the task panel until cleared. */
  inTaskPanel: boolean;
  cancellable: boolean;
}

export interface RunRequest {
  action: string;
  resourceId?: string;
  target: string;
  tabId: string;
  envId: string | null;
  /** Bound content as on screen (unsaved included). */
  input: Record<string, unknown>;
  params: Record<string, string>;
}

/* ------------------------------------------------------------------ search, audit, commands */

export interface SearchHit {
  target: string;
  title: string;
  icon: string;
  /** Path or kind. */
  subtitle: string;
  state: NodeState;
}

export interface AuditRow {
  id: string;
  at: number;
  actor: string;
  source: "user" | "plugin" | "scheduled" | "ai" | "system";
  operation: string;
  operationLabel: Label;
  target: string;
  result: "ok" | "denied" | "error";
  detail: string;
}

export interface AuditFilter {
  sinceMs?: number;
  actor?: string;
  operation?: string;
  result?: string;
  text?: string;
}

export interface AuditFacets {
  actors: string[];
  operations: Array<{ value: string; label: Label }>;
}

export interface PaletteCommand {
  id: string;
  label: Label;
  icon?: string;
  group: Label;
  shortcut?: string[];
  keywords?: string[];
}

/* ------------------------------------------------------------------ events (§12) */

/**
 * Topics: `tree:<treeId>`, `resource:<id>`, `runs` (any run changed), `run:<id>`, `plugins`,
 * `config` (workspace configuration changed), `audit`, `connection` (re-subscribe and refresh).
 */
export type EventHandler = (topic: string, payload?: unknown) => void;
