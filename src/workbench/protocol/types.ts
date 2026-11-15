/**
 * Protocol types between the workbench UI and the kernel (kernel-design §12).
 * Stage 0: hand-written and served by the mock. Later these are generated from the Rust types.
 * The UI knows no resource kind: it draws what these shapes describe.
 */

export type Locale = "en-US" | "zh-CN";

/** Text supplied by a plugin manifest or the kernel: one string per language, English as fallback (§11). */
export type Label = string | { "en-US": string; "zh-CN"?: string };

export type NodeState = "ok" | "disabled" | "missing-plugin" | "broken" | "conflict";

/* ------------------------------------------------------------------ workspace */

export interface WorkspaceInfo {
  id: string;
  name: string;
  current: boolean;
}

/* ------------------------------------------------------------------ trees (§5) */

export interface TreeInfo {
  id: string;
  title: Label;
  icon: string;
  /** stored: nodes are resources and can be moved. provided: nodes come from a plugin or the kernel. */
  source: "stored" | "provided";
  /** Whether "new group" applies to this tree. */
  groups: boolean;
  /** Right-click menu of the empty area. */
  menu: MenuCommand[];
}

export interface MenuCommand {
  /** Command id, executed with `command.execute`. */
  id: string;
  label: Label;
  icon?: string;
  danger?: boolean;
  disabled?: boolean;
  shortcut?: string[];
  separatorBefore?: boolean;
}

export interface TreeNode {
  key: string;
  tree: string;
  parentKey: string | null;
  label: string;
  icon: string;
  kind: string;
  expandable: boolean;
  state: NodeState;
  /** Why the node is not in the normal state. */
  stateReason?: Label;
  badge?: string;
  /** Open target (§9.1); absent for pure containers. */
  target?: string;
  menu: MenuCommand[];
  draggable: boolean;
  /** Kinds this node accepts as children ("*" = any kind of this tree). Empty = nothing can be dropped in. */
  accepts: string[];
}

export type DropPosition = "before" | "inside" | "after";

/* ------------------------------------------------------------------ resources (§3.3) */

export interface Resource {
  id: string;
  kind: string;
  kindLabel: Label;
  icon: string;
  tree: string;
  parentId: string | null;
  name: string;
  description: string;
  tags: string[];
  body: Record<string, unknown>;
  state: NodeState;
  stateReason?: Label;
  origin: "original" | "subscribed" | "copied";
  originRef?: string;
  /** Names of the ancestors, root first. */
  location: string[];
  favorite: boolean;
  deleted: boolean;
  readOnly: boolean;
  rev: number;
  pluginVersion?: string;
  createdAt: number;
  createdBy: string;
  updatedAt: number;
  updatedBy: string;
}

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

export type FieldKind = "text" | "longtext" | "code" | "number" | "boolean" | "date" | "datetime" | "enum" | "secret";

export interface FieldOption {
  value: string;
  label: Label;
}

export interface ViewField {
  name: string;
  label: Label;
  kind: FieldKind;
  /** Edits this field of the resource (unsaved until Save). */
  bind?: string;
  /** A run parameter: the value lives in the tab's page state, never in the resource (I.4). */
  param?: boolean;
  options?: FieldOption[];
  /** Quick values for date / datetime fields ("today 00:00"). */
  presets?: Array<{ label: Label; value: string }>;
  /** code / longtext: take all remaining height (I.7). */
  fill?: boolean;
  /** Language for colouring a code field. */
  language?: string;
  hint?: Label;
  placeholder?: Label;
  /** Value supplied by the tab's environment, shown until the user types one. */
  envValue?: string;
  /** Name of the environment layer that supplies `envValue`. */
  envSource?: string;
  readOnly?: boolean;
}

export type ViewNode =
  | { type: "form"; id: string; layout: "strip" | "stack"; label: Label; fields: ViewField[] }
  | { type: "text"; id: string; text: string; mono?: boolean; language?: string; tone?: "default" | "muted" | "danger" }
  | { type: "table"; id: string; columns: OutputColumn[]; rows: OutputCell[][]; rowTargets?: string[] }
  | { type: "link"; id: string; label: Label; target: string }
  | { type: "placeholder"; id: string; icon: string; message: Label; action?: { label: Label; disabled?: boolean } };

export interface ActionDecl {
  id: string;
  label: Label;
  icon?: string;
  primary?: boolean;
  danger?: boolean;
  shortcut?: string[];
  /**
   * run: start a run with what is on screen. save: write bound fields. save-run: both.
   * event: send a page event (the plugin may change unsaved fields). command: execute a command.
   */
  role: "run" | "save" | "save-run" | "event" | "command";
  disabled?: boolean;
}

export interface ResultTabDecl {
  id: string;
  label: Label;
  icon?: string;
  /** output: drawn by the frame from the run's output. history: the resource's runs. view: rendered by the plugin for a run. */
  type: "output" | "history" | "view";
}

export interface Crumb {
  label: string;
  icon?: string;
  /** Tree and node to reveal when clicked. */
  tree?: string;
  key?: string;
  target?: string;
}

export interface PageDescriptor {
  target: string;
  title: string;
  icon: string;
  kindLabel?: Label;
  /** False when the target no longer resolves (deleted, unknown). */
  found: boolean;
  state: NodeState;
  stateReason?: Label;
  breadcrumb: Crumb[];
  /**
   * view: plugin page drawn from `view`. Others are shell pages that read the protocol directly
   * (§9.1: environment, config, plugin, audit, deleted).
   */
  page: "view" | "env" | "plugin" | "audit" | "deleted" | "missing";
  view: ViewNode[];
  actions: ActionDecl[];
  resultTabs: ResultTabDecl[];
  resourceId?: string;
  /** The page shows this past run (run:<id> targets): input is read-only. */
  runId?: string;
  /** Whether the tab has an environment selector. */
  usesEnv: boolean;
  hasInfo: boolean;
  readOnly: boolean;
  /** Re-resolve ~300 ms after bound content stops changing (§9.3). */
  recompute: boolean;
  /** Saved values of the bound fields, by bind path. For run pages: the input snapshot. */
  values: Record<string, unknown>;
  /** Bound fields are written as soon as they change (configuration pages). */
  autosave: boolean;
}

export interface PageContext {
  envId?: string | null;
  /** Unsaved bound values by bind path. */
  draft?: Record<string, unknown>;
}

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
   * Present when an ancestor defines this parameter: every ancestor from the root down to the parent with the
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

export interface OutputColumn {
  key: string;
  label: string;
  numeric?: boolean;
}

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

export interface CommandContext {
  tree?: string;
  nodeKey?: string | null;
  target?: string;
  tabId?: string;
}

/** What the shell should do after a command ran. */
export type CommandEffect =
  | { type: "open"; target: string; state?: { params?: Record<string, string>; envId?: string | null } }
  | { type: "toast"; message: Label; tone?: "success" | "info" | "warning" | "danger" }
  | { type: "rename"; tree: string; key: string }
  | { type: "reveal"; tree: string; key: string }
  | { type: "set-tab-env"; envId: string }
  | { type: "close-target"; target: string }
  | { type: "show-tasks" }
  | { type: "reload" };

export interface PaletteCommand {
  id: string;
  label: Label;
  icon?: string;
  group: Label;
  shortcut?: string[];
  keywords?: string[];
}

export interface NewItem {
  /** Command to execute. */
  id: string;
  label: Label;
  icon: string;
  separatorBefore?: boolean;
  disabled?: boolean;
}

/* ------------------------------------------------------------------ events (§12) */

/**
 * Topics: `tree:<treeId>`, `resource:<id>`, `runs` (any run changed), `run:<id>`, `plugins`,
 * `config` (workspace configuration changed), `audit`, `connection` (re-subscribe and refresh).
 */
export type EventHandler = (topic: string) => void;
