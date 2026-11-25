/**
 * Protocol types between the workbench UI and the kernel (kernel-design §12).
 * The types the kernel speaks are generated from `crates/protocol` (never edited here) and
 * re-exported below. Everything after them is DEMO ONLY ("演示，未进协议"): types for the
 * parts still served by the mock (environments, runs, plugin pages, audit, search).
 * The UI knows no resource kind: it draws what these shapes describe.
 */
import type {
  InstallAnswerParams,
  PluginDependency,
  CommandContext as KernelCommandContext,
  CommandEffect as KernelEffect,
  PluginDetail as KernelPluginDetail,
  PluginPermission as KernelPluginPermission,
  Run as KernelRun,
  RunOutput as KernelRunOutput,
  Label,
  PageApply,
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
  McpInfo,
  McpStatus,
  SetAiVisibleResult,
  ConfigGetParams,
  ConfigSetParams,
  EnvLayer,
  EnvOption,
  EnvParam,
  InheritedEnv,
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
  InstallRequest,
  PluginDependency,
  PluginVersion,
  UpgradeBatchInfo,
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
  ExportResult,
  ImportPreview,
  ImportResult,
  ImportSkip,
  KnownParam,
  RefInfo,
  RefState,
  RunExportResult,
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
  ConfirmChoice,
  LineTone,
  TextAppearance,
  MenuCommand,
  NewItem,
  NodeState,
  OutputColumn,
  PageKind,
  PluginGrants,
  ProtocolError,
  ResultAction,
  ResultTabDecl,
  ToastTone,
  Tone,
  TreeInfo,
  TreeNode,
  TreeMoveResult,
  TreePage,
  ViewField,
  WorkspaceEntry,
  WorkspacesResult,
  WorkspaceInfo,
  LanguageInfo,
  I18nShellResult as ShellTexts,
  AssistProvider,
  EmbedActResult,
  EmbedResult,
  RefSuggestion,
  BlobInfo,
  ImageWidth,
  FieldAssist,
  PageApply,
  ConversationTurn,
} from "./generated";

/**
 * The UI-side shapes below are supersets of the generated ones (the UI keeps `null` and loose
 * JSON values); the real client converts when it sends and the mock never needed to.
 */
export type CommandContext = Omit<KernelCommandContext, "nodeKey" | "args"> & { nodeKey?: string | null; args?: Record<string, unknown> };
export type PageContext = Omit<KernelPageContext, "envId" | "draft"> & { envId?: string | null; draft?: Record<string, unknown> };
export type Resource = Omit<KernelResource, "body"> & { body: Record<string, unknown> };
/**
 * `restrictions` is added by the kernel on top of the generated type (round5-plan §6, field name fixed):
 * `readonly` and `noExport` when a protection policy is in effect for this page.
 */
export type PageDescriptor = Omit<KernelPageDescriptor, "view" | "values"> & { view: ViewNode[]; values: Record<string, unknown>; restrictions?: string[] };

export type PageSaveResult = { page: PageDescriptor };

/** A workspace whose `workspace.json` is missing is listed under `pending:<folder>`: it can be opened, not renamed or deleted (D404). */
/** `stateReason` of a resource whose source file was deleted (round 16): it is `broken` on the wire but shown as "stale", not as a fault. */
export const SOURCE_MISSING = "sourceMissing";
export const isSourceMissing = (state: string, reason: unknown): boolean => state === "broken" && reason === SOURCE_MISSING;

export const isPendingWorkspace = (w: { id: string }) => w.id.startsWith("pending:");

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

/** A BCP 47 tag. `en-US` is built in; others come from language plugins (D379). */
export type Locale = string;

/* ------------------------------------------------------------------ workspace */

/* ------------------------------------------------------------------ trees (§5) */

/* ------------------------------------------------------------------ resources (§3.3) */

/** Field paths → new values, e.g. `{ "name": "…", "body.sql": "…" }`. One write = one history entry + one audit row (§4). */
export type ResourcePatch = Record<string, unknown>;

/* ------------------------------------------------------------------ pages (§9) */

export interface PageEventResult {
  /** Bound fields the plugin wants changed; applied to the unsaved content. */
  changes?: Record<string, unknown>;
  /** Round 8 (D358): new page parameter values (merged over the tab's; "" clears). Never marks the page unsaved. */
  params?: Record<string, string>;
  message?: Label;
  /** D479: values the writing-help provider puts into another page as unsaved changes. */
  apply?: PageApply;
}

/* ------------------------------------------------------------------ params & environments (§6) */

/* ------------------------------------------------------------------ plugins (§7) and runs (§8) */

export type RunOutput = KernelRunOutput;
/** Table cells the grids draw; the kernel sends any JSON value, grids show it as text. */
export type OutputCell = string | number | null;
/** The kernel's permission entry plus the demo's own label (the kernel gives an id; the shell words it). */
export type PluginPermission = KernelPluginPermission & { label?: Label };
/**
 * UI-side `PluginDetail`: the generated one with the permission superset above (the demo gives a label).
 * `depends` and `dependents` are round 7's additions to the kernel type; optional until the generated type has them.
 */
export type PluginDetail = Omit<KernelPluginDetail, "permissions"> & { permissions: PluginPermission[]; depends?: PluginDependency[]; dependents?: string[] };

/** What the shell tells the kernel when a request ends (`plugin.answerInstallRequest`). */
export type InstallAnswer = InstallAnswerParams;
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
  /** Round 18 (X5): set when the action is a result-area action; the id of the run the user clicked on (the kernel hands it to the action as `input.runId`). */
  resultRun?: string;
}

/* ------------------------------------------------------------------ search, audit, commands */

/* ------------------------------------------------------------------ events (§12) */

/**
 * Topics: `tree:<treeId>`, `resource:<id>`, `runs` (any run changed), `run:<id>`, `plugins`,
 * `config` (workspace configuration changed), `audit`, `connection` (re-subscribe and refresh).
 */
export type EventHandler = (topic: string, payload?: unknown) => void;
