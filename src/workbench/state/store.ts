/**
 * Interface state of the workbench: layout, open tabs, tree expansion. It lives on the UI side
 * (§9.2 "界面状态") and is saved per client through `client.ui`. Unsaved edits (drafts) stay in
 * memory only.
 */
import { useSyncExternalStore } from "react";
import type { MergeState, Values } from "./merge";
import type { Notice } from "./notices";
import type { CommandContext, ImportPreview, InstallPreview, Label } from "../protocol/types";

export interface TabState {
  id: string;
  target: string;
  /** Cached so a restored tab has a name and icon before its page resolves. */
  title: string;
  icon: string;
  pinned: boolean;
  /** Tab context (§9.2): the environment used for parameters and policy. */
  envId: string | null;
  /** Page state: run parameters typed by the user, by name. */
  params: Record<string, string>;
  /** Selected result sub-tab. */
  resultTab?: string;
  /** The run shown in the result area. */
  runId?: string | null;
  /** Cached from the page descriptor. */
  usesEnv?: boolean;
  /** What the page's saved values are based on (`PageDescriptor.basis`); sent back with `page.save`. */
  basis?: string;
  /** Bumped after a save so the page is resolved again. */
  reload?: number;
  missing?: boolean;
  /** Where the page's object sits in a tree (last breadcrumb), so the tree can follow the active tab. */
  node?: { tree: string; key: string } | null;
}

/** Saved with `client.ui.set("layout")`. */
export interface LayoutState {
  activity: string;
  sideOpen: boolean;
  sideWidth: number;
  infoOpen: boolean;
  infoWidth: number;
  panelOpen: boolean;
  panelHeight: number;
  tabStripCollapsed: boolean;
  tabs: TabState[];
  activeTabId: string | null;
  expanded: Record<string, string[]>;
  gridWidths: Record<string, Record<string, number>>;
  lastEnvId: string | null;
}

/** The "install a plugin" flow: asking for a folder (browser mode), then the confirmation of what was found. */
/** `request` is set when a plugin asked for this install (round 7): the dialog names it and the kernel is answered at the end. */
export interface InstallRequester {
  id: string;
  plugin: string;
  name: Label;
}
export type InstallState = { stage: "path" } | { stage: "preview"; folder: string; preview: InstallPreview; request?: InstallRequester };

/** Exporting and importing a workspace: asking for a folder (browser mode), then what an import would do. */
export type TransferState = { stage: "export-path" } | { stage: "import-path" } | { stage: "import-preview"; folder: string; preview: ImportPreview };

export interface UiState extends LayoutState {
  tasksOpen: boolean;
  /** The list of this session's notices (D376): memory only. */
  notices: Notice[];
  noticesOpen: boolean;
  paletteOpen: boolean;
  /** Unsaved bound values per tab, by bind path. */
  drafts: Record<string, Record<string, unknown>>;
  /** The page's saved values the tab's draft was started from, by bind path (to tell what changed elsewhere, D374). */
  bases: Record<string, Values>;
  /** Unsaved fields whose saved value changed elsewhere, and the ones the user chose to keep (D374). Per tab. */
  merge: Record<string, MergeState>;
  selected: Record<string, string | null>;
  renaming: { tree: string; key: string } | null;
  /** Tabs waiting for the "unsaved changes" answer. */
  confirmClose: string[] | null;
  /** Browser mode only: asks for a folder path, since there is no system dialog (pick-folder effect). */
  folderPrompt: { plugin: string } | null;
  /** Installing a plugin package (round 4). */
  install: InstallState | null;
  /** Exporting / importing the workspace (round 5). */
  transfer: TransferState | null;
  /** Exporting a run's table as CSV: the run, while the file path is being asked for (browser mode). */
  exportCsv: { run: string } | null;
  /** A command that asked to be confirmed before it runs again with `confirmed: true`. */
  confirmCommand: { message: Label; command: string; danger: boolean; context: CommandContext } | null;
  /** Most recently active tab that uses an environment. */
  envTabId: string | null;
  /** Bumped to move keyboard focus to the search box. */
  searchFocus: number;
}

export const DEFAULT_LAYOUT: LayoutState = {
  activity: "resources",
  sideOpen: true,
  sideWidth: 272,
  infoOpen: true,
  infoWidth: 240,
  panelOpen: true,
  panelHeight: 280,
  tabStripCollapsed: false,
  tabs: [],
  activeTabId: null,
  expanded: {},
  gridWidths: {},
  lastEnvId: null,
};

export const LIMITS = {
  side: { min: 180, max: 560 },
  info: { min: 200, max: 480 },
  panel: { min: 120, max: 720 },
};

export const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

const LAYOUT_KEYS = Object.keys(DEFAULT_LAYOUT) as Array<keyof LayoutState>;

export interface Store {
  get: () => UiState;
  set: (update: Partial<UiState> | ((state: UiState) => Partial<UiState>)) => void;
  subscribe: (listener: () => void) => () => void;
}

export function createStore(saved: Partial<LayoutState> | null, save: (layout: LayoutState) => void): Store {
  const merged: LayoutState = { ...DEFAULT_LAYOUT, ...(saved ?? {}) };
  let state: UiState = {
    ...merged,
    sideWidth: clamp(merged.sideWidth, LIMITS.side.min, LIMITS.side.max),
    infoWidth: clamp(merged.infoWidth, LIMITS.info.min, LIMITS.info.max),
    panelHeight: clamp(merged.panelHeight, LIMITS.panel.min, LIMITS.panel.max),
    tabs: Array.isArray(merged.tabs) ? merged.tabs.filter((t) => t && typeof t.id === "string" && typeof t.target === "string" && !t.target.startsWith("new:")) : [],
    tasksOpen: false,
    notices: [],
    noticesOpen: false,
    paletteOpen: false,
    drafts: {},
    bases: {},
    merge: {},
    selected: {},
    renaming: null,
    confirmClose: null,
    folderPrompt: null,
    install: null,
    transfer: null,
    exportCsv: null,
    confirmCommand: null,
    envTabId: null,
    searchFocus: 0,
  };
  if (!state.tabs.some((t) => t.id === state.activeTabId)) state.activeTabId = state.tabs[0]?.id ?? null;
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastSaved = "";
  const scheduleSave = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const layout = Object.fromEntries(LAYOUT_KEYS.map((k) => [k, state[k]])) as unknown as LayoutState;
      const json = JSON.stringify(layout);
      if (json === lastSaved) return;
      lastSaved = json;
      save(layout);
    }, 200);
  };
  return {
    get: () => state,
    set: (update) => {
      const patch = typeof update === "function" ? update(state) : update;
      state = { ...state, ...patch };
      for (const l of [...listeners]) l();
      scheduleSave();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export function useStore<T>(store: Store, selector: (state: UiState) => T): T {
  return useSyncExternalStore(store.subscribe, () => selector(store.get()));
}
