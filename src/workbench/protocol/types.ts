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
  PluginDetail as KernelPluginDetail,
  PluginVersion as KernelPluginVersion,
  PluginPermission as KernelPluginPermission,
  Run as KernelRun,
  RunOutput as KernelRunOutput,
  Label,
  PageContext as KernelPageContext,
  PageDescriptor as KernelPageDescriptor,
  Resource as KernelResource,
  ViewNode as KernelViewNode,
} from "./generated";

export type {
  ActionDecl,
  ActionRole,
  AuditFacets,
  AuditFilter,
  AuditResult,
  AuditRow,
  ConfigGetParams,
  ConfigSetParams,
  EnvLayer,
  EnvOption,
  EnvParam,
  EnvView,
  HistoryEntry,
  InheritedValue,
  NamedRef,
  PaletteCommand,
  PluginLoad,
  PluginLoadState,
  PluginProvides,
  PluginSetting,
  InstallPreview,
  PluginFolderRef,
  PluginVersionParams,
  SecretInfo,
  UndoUpgradeResult,
  UpgradeResult,
  RunError,
  RunProgress,
  RunStatus,
  RunSummary,
  ParamType,
  ResolvedParam,
  SearchHit,
  UpstreamChange,
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
  | (Extract<KernelEffect, { type: "open" }> & { state?: { params?: Record<string, string>; envId?: string | null } })
  | { type: "set-tab-env"; envId: string }
  | { type: "show-tasks" };

export type Locale = "en-US" | "zh-CN";

/* ------------------------------------------------------------------ workspace */

/* ------------------------------------------------------------------ trees (§5) */

/* ------------------------------------------------------------------ resources (§3.3) */

/** Field paths → new values, e.g. `{ "name": "…", "body.sql": "…" }`. One write = one history entry + one audit row (§4). */
export type ResourcePatch = Record<string, unknown>;

/* ------------------------------------------------------------------ pages (§9) */

export interface PageEventResult {
  /** Bound fields the plugin wants changed; applied to the unsaved content. */
  changes?: Record<string, unknown>;
  message?: Label;
}

/* ------------------------------------------------------------------ params & environments (§6) */

/* ------------------------------------------------------------------ plugins (§7) and runs (§8) */

export type RunOutput = KernelRunOutput;
/** Table cells the grids draw; the kernel sends any JSON value, grids show it as text. */
export type OutputCell = string | number | null;
/** The kernel's permission entry plus the demo's own label (the kernel gives an id; the shell words it). */
export type PluginPermission = KernelPluginPermission & { label?: Label };
/**
 * What the version table needs beyond the generated `PluginVersion`: how many resources are bound to a
 * version, and whether its permissions were confirmed. The kernel adds these as optional fields (round 4
 * §3); until the generated type has them the shell reads them as optional.
 */
export type PluginVersion = KernelPluginVersion & { resources?: number; confirmed?: boolean };
/** UI-side `PluginDetail`: the permission superset above, the version superset, and the last upgrade (for "undo"). */
export type PluginDetail = Omit<KernelPluginDetail, "permissions" | "versions"> & {
  permissions: PluginPermission[];
  versions: PluginVersion[];
  /** The batch of the most recent upgrade and how many resources it took over. */
  lastUpgrade?: { batch: string; count: number };
};
/** UI-side superset of the generated `Run`: `input` keeps loose JSON values. */
export type Run = Omit<KernelRun, "input"> & { input: Record<string, unknown> };

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

/* ------------------------------------------------------------------ events (§12) */

/**
 * Topics: `tree:<treeId>`, `resource:<id>`, `runs` (any run changed), `run:<id>`, `plugins`,
 * `config` (workspace configuration changed), `audit`, `connection` (re-subscribe and refresh).
 */
export type EventHandler = (topic: string, payload?: unknown) => void;
