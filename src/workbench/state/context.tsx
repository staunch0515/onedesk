import { createContext, useContext, useEffect, useMemo, useRef, useState, type DependencyList, type ReactNode } from "react";
import { useToast } from "../../design";
import { useI18n } from "../i18n";
import type { MessageKey } from "../i18n/en-US";
import { useClient, type CommandContext, type CommandEffect, type ProtocolClient } from "../protocol";
import { saveTab } from "./save";
import { useStore, type Store, type TabState, type UiState } from "./store";

export interface OpenOptions {
  params?: Record<string, string>;
  envId?: string | null;
}

export interface Actions {
  open: (target: string, options?: OpenOptions) => void;
  activate: (tabId: string) => void;
  /** Asks first when a tab has unsaved changes. */
  close: (tabIds: string[]) => void;
  /** Closes without asking and drops unsaved changes. */
  forceClose: (tabIds: string[]) => void;
  updateTab: (tabId: string, patch: Partial<TabState>) => void;
  /** Sets (or, when equal to `saved`, clears) one unsaved bound value. */
  setDraft: (tabId: string, bind: string, value: unknown, saved: unknown) => void;
  clearDraft: (tabId: string, binds?: string[]) => void;
  /** Writes a tab's unsaved bound values. Returns false when it failed. */
  save: (tabId: string) => Promise<boolean>;
  command: (id: string, context?: CommandContext) => Promise<void>;
  /** Runs effects the kernel pushed (a plugin's `host.ui.open/notify/copy`). */
  runEffects: (effects: CommandEffect[]) => Promise<void>;
  reveal: (tree: string, key: string) => Promise<void>;
  /** Gives a plugin access to a folder (the user chose it in a dialog). */
  grantFolder: (plugin: string, path: string) => Promise<void>;
  setExpanded: (tree: string, keys: string[]) => void;
  /** Shows a failed protocol call as a toast. */
  fail: (error: unknown) => void;
}

interface Workbench {
  client: ProtocolClient;
  store: Store;
  actions: Actions;
}

const WorkbenchContext = createContext<Workbench | null>(null);

/** Commands that create a named thing: the shell supplies the default name in the interface language (the kernel's is only a fallback). */
const DEFAULT_NAME_KEY: Record<string, MessageKey> = { "env.newChild": "default.newEnv", "config.newChild": "default.newConfig", "node.newGroup": "default.newGroup" };

let tabSeq = 0;
const newTabId = () => `t${Date.now().toString(36)}${(tabSeq++).toString(36)}`;

export function WorkbenchProvider({ store, children }: { store: Store; children: ReactNode }) {
  const client = useClient();
  const { toast } = useToast();
  const i18n = useI18n();
  const live = useRef({ toast, i18n });
  live.current = { toast, i18n };

  const actions = useMemo<Actions>(() => {
    const fail = (error: unknown) => {
      const { toast: show, i18n: i } = live.current;
      show({ tone: "danger", title: i.t("error.title"), description: i.error(error) });
    };

    const forceClose = (tabIds: string[]) => {
      store.set((s) => {
        const tabs = s.tabs.filter((t) => !tabIds.includes(t.id));
        let activeTabId = s.activeTabId;
        if (activeTabId && tabIds.includes(activeTabId)) {
          const index = s.tabs.findIndex((t) => t.id === activeTabId);
          const after = s.tabs.slice(index + 1).find((t) => !tabIds.includes(t.id));
          const before = [...s.tabs.slice(0, index)].reverse().find((t) => !tabIds.includes(t.id));
          activeTabId = (after ?? before)?.id ?? null;
        }
        const drafts = { ...s.drafts };
        for (const id of tabIds) delete drafts[id];
        return { tabs, activeTabId, drafts, confirmClose: null };
      });
    };

    const open: Actions["open"] = (target, options) => {
      store.set((s) => {
        const existing = s.tabs.find((t) => t.target === target);
        if (existing) {
          const patch: Partial<TabState> = {};
          if (options?.params) patch.params = { ...existing.params, ...options.params };
          if (options?.envId) patch.envId = options.envId;
          return { activeTabId: existing.id, tabs: s.tabs.map((t) => (t.id === existing.id ? { ...t, ...patch } : t)) };
        }
        const tab: TabState = { id: newTabId(), target, title: "", icon: "loader", pinned: false, envId: options?.envId ?? s.lastEnvId, params: options?.params ?? {} };
        return { tabs: [...s.tabs, tab], activeTabId: tab.id };
      });
    };

    const save: Actions["save"] = async (tabId) => {
      const s = store.get();
      const tab = s.tabs.find((t) => t.id === tabId);
      const draft = s.drafts[tabId];
      if (!tab || !draft || Object.keys(draft).length === 0) return true;
      try {
        const created = await saveTab(client, store, tabId);
        // A new resource: show it in its tree.
        if (created) {
          const res = await client.resource.get(created);
          if (res) void actions.reveal(res.tree, res.id);
        }
        return true;
      } catch (error) {
        fail(error);
        return false;
      }
    };

    const reveal: Actions["reveal"] = async (tree, key) => {
      try {
        const path = await client.tree.path(tree, key);
        store.set((s) => ({
          activity: tree,
          sideOpen: true,
          expanded: { ...s.expanded, [tree]: [...new Set([...(s.expanded[tree] ?? []), ...path.slice(0, -1)])] },
          selected: { ...s.selected, [tree]: key },
        }));
      } catch (error) {
        fail(error);
      }
    };

    const grantFolder: Actions["grantFolder"] = async (plugin, path) => {
      try {
        const grants = await client.plugin.grantFolder(plugin, path);
        live.current.toast({ tone: "success", title: live.current.i18n.t("folder.granted", { path: grants.folders[grants.folders.length - 1] ?? path }) });
      } catch (error) {
        fail(error);
      }
    };

    const applyEffects = async (effects: CommandEffect[], context: CommandContext = {}) => {
      const { toast: show, i18n: i } = live.current;
      for (const effect of effects) {
        switch (effect.type) {
          case "open":
            // The kernel names the initial page state `params` / `envId`; the demo's effects carry it under `state`.
            open(effect.target, { params: effect.params ?? effect.state?.params, envId: effect.envId ?? effect.state?.envId });
            break;
          case "toast":
            show({ tone: effect.tone ?? "neutral", title: i.tx(effect.message) });
            break;
          case "reveal":
            await reveal(effect.tree, effect.key);
            break;
          case "rename":
            await reveal(effect.tree, effect.key);
            store.set({ renaming: { tree: effect.tree, key: effect.key } });
            break;
          case "set-tab-env": {
            const s = store.get();
            const active = s.tabs.find((t) => t.id === s.activeTabId);
            const tab = active?.usesEnv ? active : s.tabs.find((t) => t.id === s.envTabId && t.usesEnv);
            if (!tab) {
              show({ tone: "warning", title: i.t("env.noTabToUse") });
              break;
            }
            store.set((st) => ({ lastEnvId: effect.envId, tabs: st.tabs.map((t) => (t.id === tab.id ? { ...t, envId: effect.envId } : t)) }));
            show({ tone: "success", title: i.t("env.usedInTab", { tab: tab.title }) });
            break;
          }
          case "close-target":
            forceClose(store.get().tabs.filter((t) => t.target === effect.target).map((t) => t.id));
            break;
          case "show-tasks":
            store.set({ tasksOpen: true });
            break;
          case "reload":
            window.location.reload();
            break;
          case "pick-folder": {
            const pick = client.platform?.pickFolder;
            if (!pick) {
              store.set({ folderPrompt: { plugin: effect.plugin } });
              break;
            }
            const path = await pick();
            if (path) await grantFolder(effect.plugin, path);
            break;
          }
          case "confirm":
            store.set({ confirmCommand: { message: effect.message, command: effect.command, danger: effect.danger ?? false, context } });
            break;
          case "copy":
            try {
              await navigator.clipboard.writeText(effect.text);
              show({ tone: "success", title: i.t("copy.done") });
            } catch (error) {
              fail(error);
            }
            break;
        }
      }
    };

    return {
      fail,
      open,
      forceClose,
      save,
      reveal,
      grantFolder,
      runEffects: (effects) => applyEffects(effects).catch(fail),
      activate: (tabId) => store.set({ activeTabId: tabId }),
      close: (tabIds) => {
        const s = store.get();
        const ids = tabIds.filter((id) => s.tabs.some((t) => t.id === id));
        if (ids.length === 0) return;
        const dirty = ids.filter((id) => Object.keys(s.drafts[id] ?? {}).length > 0);
        if (dirty.length > 0) store.set({ confirmClose: ids });
        else forceClose(ids);
      },
      updateTab: (tabId, patch) =>
        store.set((s) => {
          const tab = s.tabs.find((t) => t.id === tabId);
          if (!tab || (Object.keys(patch) as Array<keyof TabState>).every((k) => JSON.stringify(tab[k]) === JSON.stringify(patch[k]))) return {};
          return { tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, ...patch } : t)), ...(patch.envId ? { lastEnvId: patch.envId } : {}) };
        }),
      setDraft: (tabId, bind, value, saved) =>
        store.set((s) => {
          const draft = { ...(s.drafts[tabId] ?? {}) };
          if (value === saved) delete draft[bind];
          else draft[bind] = value;
          return { drafts: { ...s.drafts, [tabId]: draft } };
        }),
      clearDraft: (tabId, binds) =>
        store.set((s) => {
          const draft = { ...(s.drafts[tabId] ?? {}) };
          for (const k of binds ?? Object.keys(draft)) delete draft[k];
          return { drafts: { ...s.drafts, [tabId]: draft } };
        }),
      command: async (id, context = {}) => {
        try {
          const s = store.get();
          const active = s.tabs.find((t) => t.id === s.activeTabId);
          const defaultName = DEFAULT_NAME_KEY[id];
          const args = defaultName && !context.args?.name ? { ...context.args, name: live.current.i18n.t(defaultName) } : context.args;
          const full = { tabId: active?.id, ...context, ...(args ? { args } : {}) };
          // The kernel deletes at once (it can be undone); when other items refer to this one the shell asks first and says how many (§10).
          // (Pure demo mode and demo trees keep deleting at once: their seeded references are only illustration.)
          const real = client.demo !== undefined && !client.demo.tree(context.tree ?? "");
          if (id === "node.delete" && real && !context.args?.confirmed) {
            const subject = context.target?.startsWith("resource:") ? context.target.slice(9) : context.nodeKey;
            const refs = subject ? await client.refs.incoming(subject).catch(() => []) : [];
            const count = new Set(refs.map((r) => r.source.id)).size;
            if (count > 0) {
              const text = live.current.i18n.t("delete.refs", { count });
              store.set({ confirmCommand: { message: { "en-US": text, "zh-CN": text }, command: id, danger: true, context: full } });
              return;
            }
          }
          await applyEffects(await client.command.execute(id, full), full);
        } catch (error) {
          fail(error);
        }
      },
      setExpanded: (tree, keys) => store.set((s) => ({ expanded: { ...s.expanded, [tree]: keys } })),
    };
  }, [client, store]);

  // A plugin asked the interface to do something (`ui` event). The main process only sends it to the
  // client that made the call (or to everyone when no client is named).
  useEffect(
    () =>
      client.events.subscribe("ui", (_topic, payload) => {
        if (payload && typeof payload === "object" && "type" in payload) void actions.runEffects([payload as CommandEffect]);
      }),
    [client, actions],
  );

  const value = useMemo(() => ({ client, store, actions }), [client, store, actions]);
  return <WorkbenchContext.Provider value={value}>{children}</WorkbenchContext.Provider>;
}

export function useWorkbench(): Workbench {
  const value = useContext(WorkbenchContext);
  if (!value) throw new Error("useWorkbench must be used inside WorkbenchProvider");
  return value;
}

export function useUi<T>(selector: (state: UiState) => T): T {
  return useStore(useWorkbench().store, selector);
}

export interface Query<T> {
  data: T | undefined;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/**
 * Reads through the protocol and re-reads when one of the topics fires (§12 events). The previous
 * data stays on screen while a refresh is in flight, so nothing flickers.
 */
export function useQuery<T>(fn: (client: ProtocolClient) => Promise<T>, deps: DependencyList, topics: string[] = []): Query<T> {
  const client = useClient();
  const i18n = useI18n();
  const i18nRef = useRef(i18n);
  i18nRef.current = i18n;
  const [state, setState] = useState<{ data: T | undefined; loading: boolean; error: string | null }>({ data: undefined, loading: true, error: null });
  const [tick, setTick] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const lastDeps = useRef<DependencyList | null>(null);

  useEffect(() => {
    let cancelled = false;
    // New inputs: drop the old data. Event refresh with the same inputs: keep it on screen.
    const prev = lastDeps.current;
    const fresh = !prev || prev.length !== deps.length || deps.some((d, i) => d !== prev[i]);
    lastDeps.current = deps;
    setState((s) => ({ data: fresh ? undefined : s.data, loading: true, error: null }));
    fnRef.current(client).then(
      (data) => !cancelled && setState({ data, loading: false, error: null }),
      (error: unknown) => !cancelled && setState((s) => ({ data: s.data, loading: false, error: i18nRef.current.error(error) })),
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, tick, ...deps]);

  const topicKey = topics.join("|");
  useEffect(() => {
    if (!topicKey) return;
    const bump = () => setTick((t) => t + 1);
    const offs = [...topicKey.split("|"), "connection"].map((topic) => client.events.subscribe(topic, bump));
    return () => offs.forEach((off) => off());
  }, [client, topicKey]);

  return { ...state, reload: () => setTick((t) => t + 1) };
}
