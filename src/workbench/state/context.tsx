import { createContext, useContext, useEffect, useMemo, useRef, useState, type DependencyList, type ReactNode } from "react";
import { useToast } from "../../design";
import { useI18n } from "../i18n";
import { useClient, type CommandContext, type CommandEffect, type ProtocolClient } from "../protocol";
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
  reveal: (tree: string, key: string) => Promise<void>;
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
      show({ tone: "danger", title: i.t("error.title"), description: error instanceof Error ? error.message : String(error) });
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
        if (tab.target.startsWith("new:")) {
          const created = await client.resource.create(tab.target, draft);
          store.set((st) => {
            const drafts = { ...st.drafts };
            delete drafts[tabId];
            return { drafts, tabs: st.tabs.map((t) => (t.id === tabId ? { ...t, target: `resource:${created.id}`, title: created.name } : t)) };
          });
          void actions.reveal(created.tree, created.id);
        } else if (tab.target.startsWith("resource:")) {
          await client.resource.update(tab.target.slice(9), draft);
          // Keep what was typed while the save was in flight.
          store.set((st) => {
            const now = { ...(st.drafts[tabId] ?? {}) };
            for (const [k, v] of Object.entries(draft)) if (now[k] === v) delete now[k];
            return { drafts: { ...st.drafts, [tabId]: now } };
          });
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

    const applyEffects = async (effects: CommandEffect[]) => {
      const { toast: show, i18n: i } = live.current;
      for (const effect of effects) {
        switch (effect.type) {
          case "open":
            open(effect.target, effect.state);
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
        }
      }
    };

    return {
      fail,
      open,
      forceClose,
      save,
      reveal,
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
          await applyEffects(await client.command.execute(id, { tabId: active?.id, ...context }));
        } catch (error) {
          fail(error);
        }
      },
      setExpanded: (tree, keys) => store.set((s) => ({ expanded: { ...s.expanded, [tree]: keys } })),
    };
  }, [client, store]);

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
      (error: unknown) => !cancelled && setState((s) => ({ data: s.data, loading: false, error: error instanceof Error ? error.message : String(error) })),
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
