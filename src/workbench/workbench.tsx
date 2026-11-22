import { useEffect, useMemo, useRef } from "react";
import { ActivityBar, Button, CommandPalette, Dialog, Sized, Splitter, WorkbenchFrame, WorkbenchMain, useTheme, useToast, type CommandGroup } from "../design";
import { useI18n } from "./i18n";
import { loadChildren, type LanguageInfo } from "./protocol";
import { CommandDialogs } from "./parts/command-dialogs";
import { InstallDialogs, startInstall } from "./parts/install-dialogs";
import { startExport, startImport, TransferDialogs } from "./parts/transfer-dialogs";
import { AI_SETTINGS_TARGET } from "./pages/ai-settings-page";
import { SECRETS_TARGET } from "./pages/secrets-page";
import { NoTabs, PageHost } from "./parts/page-host";
import { TreePanel } from "./parts/side-panel";
import { StatusBarPart, type Settings } from "./parts/status-bar";
import { TabsPart } from "./parts/tabs";
import { NoticePanel } from "./parts/notice-panel";
import { TaskPanel } from "./parts/task-panel";
import { TopBarPart } from "./parts/top-bar";
import { useResize } from "./parts/hooks";
import { useQuery, useUi, useWorkbench } from "./state/context";
import { isSelfNamed, tabFieldsFromPage } from "./state/tab-fields";

export interface WorkbenchProps {
  settings: Settings;
  /** `i18n.languages`: what the language picker lists (D379). */
  languages: LanguageInfo[];
  /** Rejects when the workspace refused to store the setting. */
  onSetting: (name: "ui.language" | "ui.theme" | "ui.density", value: string) => Promise<void>;
}

/** The whole window: top bar, activity bar, side panel, tabs + page, status bar (I.8). */
export function Workbench({ settings, languages, onSetting: storeSetting }: WorkbenchProps) {
  const { client, store, actions } = useWorkbench();
  // A refused write shows as a toast; the shell has already read the stored value back.
  const onSetting = useMemo(() => (name: "ui.language" | "ui.theme" | "ui.density", value: string) => void storeSetting(name, value).catch(actions.fail), [storeSetting, actions]);
  const { t, tx, locale } = useI18n();
  const { toast } = useToast();
  const { resolvedTheme } = useTheme();
  const trees = useQuery((c) => c.tree.list(), []);
  const palette = useQuery((c) => c.command.palette(), []);
  const newItems = useQuery((c) => c.command.newItems(), []);
  const activity = useUi((s) => s.activity);
  const sideOpen = useUi((s) => s.sideOpen);
  const sideWidth = useUi((s) => s.sideWidth);
  const tasksOpen = useUi((s) => s.tasksOpen);
  const noticesOpen = useUi((s) => s.noticesOpen);
  const paletteOpen = useUi((s) => s.paletteOpen);
  const confirmClose = useUi((s) => s.confirmClose);
  const tabs = useUi((s) => s.tabs);
  const activeTab = useUi((s) => s.tabs.find((x) => x.id === s.activeTabId) ?? null);
  const running = useQuery((c) => c.run.tasks(), [], ["runs"]);
  const sideResize = useResize("sideWidth", 1);

  const tree = trees.data?.find((x) => x.id === activity) ?? trees.data?.[0];
  // The default "new": the first thing that is not a group or a core folder-like entry (groups come first with a real kernel).
  const usable = newItems.data?.filter((i) => !i.disabled) ?? [];
  const firstItem = usable.find((i) => !/^(node|env|config)\./.test(i.id)) ?? usable[0];
  const firstNew = firstItem?.id;
  const newDefault = () => {
    if (firstNew) void actions.command(firstNew, { tree: activity, nodeKey: store.get().selected[activity] ?? null });
  };

  const openSettings = async () => {
    store.set({ activity: "config", sideOpen: true });
    try {
      const nodes = await loadChildren(client, "config", null, locale);
      const preferred = nodes.find((n) => n.key.includes("appearance")) ?? nodes.find((n) => n.target);
      if (preferred?.target) actions.open(preferred.target);
    } catch (error) {
      actions.fail(error);
    }
  };

  // Restored tabs get their name and icon without having to be activated first.
  useEffect(() => {
    for (const tab of store.get().tabs) {
      if (tab.title || tab.target === SECRETS_TARGET || tab.target === AI_SETTINGS_TARGET) continue;
      // A tab without a name yet takes the page's own (the plugin page replaces it with the plugin's name once it is shown).
      client.page.resolve(tab.target, { envId: tab.envId, locale }).then((d) => actions.updateTab(tab.id, { ...tabFieldsFromPage(d), title: d.title }), () => undefined);
    }
  }, [client, store, actions, tabs.length]);

  // Switching the interface language renames the tabs in the background too (they keep the old language until activated otherwise).
  const firstLocale = useRef(locale);
  useEffect(() => {
    if (firstLocale.current === locale) return;
    firstLocale.current = locale;
    for (const tab of store.get().tabs) {
      if (tab.id === store.get().activeTabId) continue;
      // The secrets page names itself; the plugin page too (it shows the plugin's name): they are not asked.
      if (tab.target === SECRETS_TARGET) actions.updateTab(tab.id, { title: t("secrets.title") });
      else if (tab.target === AI_SETTINGS_TARGET) actions.updateTab(tab.id, { title: t("ai.title") });
      else if (!isSelfNamed(tab.target)) client.page.resolve(tab.target, { envId: tab.envId, locale }).then((d) => actions.updateTab(tab.id, tabFieldsFromPage(d)), () => undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, store, actions, locale]);

  // Tabs in the background follow renames and deletions of their resource.
  const resourceTargets = tabs.filter((x) => x.target.startsWith("resource:")).map((x) => x.target).join("|");
  useEffect(() => {
    if (!resourceTargets) return;
    const offs = resourceTargets.split("|").map((target) =>
      client.events.subscribe(target, () => {
        const tab = store.get().tabs.find((x) => x.target === target);
        if (!tab || tab.id === store.get().activeTabId) return;
        client.page.resolve(target, { envId: tab.envId, locale }).then((d) => actions.updateTab(tab.id, tabFieldsFromPage(d)), () => undefined);
      }),
    );
    return () => offs.forEach((off) => off());
  }, [client, store, actions, resourceTargets, locale]);

  // Global shortcuts (ui-spec §6).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const s = store.get();
      if (e.ctrlKey && e.key === "Tab") {
        const index = s.tabs.findIndex((x) => x.id === s.activeTabId);
        const next = s.tabs[(index + (e.shiftKey ? -1 : 1) + s.tabs.length) % Math.max(1, s.tabs.length)];
        if (next) actions.activate(next.id);
        e.preventDefault();
        return;
      }
      if (!mod || e.altKey) return;
      const key = e.key.toLowerCase();
      if (e.shiftKey && key === "p") store.set({ paletteOpen: true });
      else if (e.shiftKey && key === "w") actions.close(s.tabs.filter((x) => !x.pinned).map((x) => x.id));
      else if (e.shiftKey) return;
      else if (key === "s") {
        // Pages handle saving themselves; this only keeps the browser's own "save page" away.
      } else if (key === "k") store.set({ searchFocus: s.searchFocus + 1 });
      else if (key === "w") {
        const tab = s.tabs.find((x) => x.id === s.activeTabId);
        if (tab && !tab.pinned) actions.close([tab.id]);
      } else if (key === "n") newDefault();
      else if (key === "b") store.set({ sideOpen: !s.sideOpen });
      else if (key === "j") store.set({ panelOpen: !s.panelOpen });
      else if (key === ",") void openSettings();
      else if (/^[1-9]$/.test(key) && trees.data?.[Number(key) - 1]) store.set({ activity: trees.data[Number(key) - 1]!.id, sideOpen: true });
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, actions, trees.data, firstNew]);

  const groups = useMemo<CommandGroup[]>(() => {
    const byGroup = new Map<string, CommandGroup>();
    for (const c of palette.data ?? []) {
      const heading = tx(c.group);
      const group = byGroup.get(heading) ?? { id: heading, heading, items: [] };
      byGroup.set(heading, group);
      group.items.push({ id: c.id, label: tx(c.label), icon: c.icon, shortcut: c.shortcut, keywords: c.keywords, onSelect: () => void actions.command(c.id, { tree: store.get().activity, nodeKey: store.get().selected[store.get().activity] ?? null }) });
    }
    const s = store.get();
    return [
      ...byGroup.values(),
      {
        id: "view",
        heading: t("palette.view"),
        items: [
          ...(client.secrets ? [{ id: "secrets", label: t("secrets.title"), icon: "key-round", onSelect: () => actions.open(SECRETS_TARGET) }] : []),
          { id: "ai-settings", label: t("ai.title"), icon: "bot", keywords: ["mcp", "claude"], onSelect: () => actions.open(AI_SETTINGS_TARGET) },
          { id: "workspace.export", label: t("transfer.export"), icon: "folder-output", onSelect: () => void startExport(client, store, actions, (resources, folder) => toast({ tone: "success", title: t("transfer.exportDone", { resources, folder }) })) },
          { id: "workspace.import", label: t("transfer.import"), icon: "folder-input", onSelect: () => void startImport(client, store, actions) },
          ...(client.app ? [{ id: "install", label: t("install.action"), icon: "package-plus", onSelect: () => void startInstall(client, store, actions) }] : []),
          { id: "view.side", label: t("palette.toggleSide"), icon: "panel-left", shortcut: ["⌘", "B"], onSelect: () => store.set((x) => ({ sideOpen: !x.sideOpen })) },
          { id: "view.panel", label: t("palette.togglePanel"), icon: "panel-bottom", shortcut: ["⌘", "J"], onSelect: () => store.set((x) => ({ panelOpen: !x.panelOpen })) },
          { id: "view.info", label: t("palette.toggleInfo"), icon: "panel-right", onSelect: () => store.set((x) => ({ infoOpen: !x.infoOpen })) },
          { id: "view.tasks", label: t("palette.toggleTasks"), icon: "list-checks", onSelect: () => store.set((x) => ({ tasksOpen: !x.tasksOpen })) },
          { id: "view.tabs", label: t("palette.toggleTabs"), icon: "chevrons-up", onSelect: () => store.set((x) => ({ tabStripCollapsed: !x.tabStripCollapsed })) },
          { id: "view.closeAll", label: t("tabs.closeAll"), icon: "copy-x", shortcut: ["⌘", "⇧", "W"], onSelect: () => actions.close(s.tabs.filter((x) => !x.pinned).map((x) => x.id)) },
        ],
      },
      {
        id: "trees",
        heading: t("palette.show"),
        items: (trees.data ?? []).map((x, i) => ({ id: `tree.${x.id}`, label: tx(x.title), icon: x.icon, shortcut: i < 9 ? ["⌘", String(i + 1)] : undefined, onSelect: () => store.set({ activity: x.id, sideOpen: true }) })),
      },
      {
        id: "appearance",
        heading: t("palette.appearance"),
        items: [
          { id: "theme.light", label: t("palette.themeLight"), icon: "sun", onSelect: () => onSetting("ui.theme", "light") },
          { id: "theme.dark", label: t("palette.themeDark"), icon: "moon", onSelect: () => onSetting("ui.theme", "dark") },
          { id: "theme.system", label: t("palette.themeSystem"), icon: "monitor", onSelect: () => onSetting("ui.theme", "system") },
          { id: "density.comfortable", label: t("palette.densityComfortable"), icon: "rows-3", onSelect: () => onSetting("ui.density", "comfortable") },
          { id: "density.compact", label: t("palette.densityCompact"), icon: "rows-4", onSelect: () => onSetting("ui.density", "compact") },
          ...languages.map((l) => ({ id: `lang.${l.locale}`, label: `${t("status.language")}: ${l.name}`, icon: "languages", keywords: ["language", "语言"], onSelect: () => onSetting("ui.language", l.locale) })),
        ],
      },
      {
        id: "tabs",
        heading: t("palette.openTabs"),
        items: s.tabs.map((x) => ({ id: `tab.${x.id}`, label: x.title || "…", icon: x.icon, onSelect: () => actions.activate(x.id) })),
      },
    ].filter((g) => g.items.length > 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [palette.data, trees.data, tabs, t, tx, actions, store, onSetting]);

  const dirtyTabs = (confirmClose ?? []).map((id) => tabs.find((x) => x.id === id)).filter((x) => x && Object.keys(store.get().drafts[x.id] ?? {}).length > 0);
  const runningCount = (running.data ?? []).filter((r) => r.status === "running").length;

  return (
    <WorkbenchFrame
      topbar={<TopBarPart onSettings={() => void openSettings()} />}
      statusBar={<StatusBarPart settings={settings} languages={languages} onSetting={onSetting} resolvedTheme={resolvedTheme} />}
      floating={noticesOpen ? <NoticePanel /> : tasksOpen ? <TaskPanel /> : undefined}
    >
      <ActivityBar
        label={t("activity.label")}
        activeKey={sideOpen ? (tree?.id ?? null) : null}
        items={(trees.data ?? []).map((x, i) => ({ key: x.id, icon: x.icon, label: tx(x.title), shortcut: i < 9 ? ["⌘", String(i + 1)] : undefined, badge: x.id === "runs" ? runningCount : undefined }))}
        footer={[{ key: "__settings", icon: "settings", label: t("topbar.settings"), shortcut: ["⌘", ","] }]}
        onSelect={(key) => {
          if (key === "__settings") void openSettings();
          else if (key === activity && sideOpen) store.set({ sideOpen: false });
          else store.set({ activity: key, sideOpen: true });
        }}
      />
      {sideOpen && tree && (
        <>
          <Sized axis="x" size={sideWidth}>
            <TreePanel key={tree.id} tree={tree} />
          </Sized>
          <Splitter axis="x" label={t("side.resize")} {...sideResize} />
        </>
      )}
      <WorkbenchMain label={t("main.label")} tabs={<TabsPart />}>
        {activeTab ? <PageHost key={activeTab.id} tab={activeTab} /> : <NoTabs onNew={newDefault} label={client.secrets && firstItem ? tx(firstItem.label) : undefined} />}
      </WorkbenchMain>

      <CommandPalette
        open={paletteOpen}
        onOpenChange={(open) => store.set({ paletteOpen: open })}
        groups={groups}
        label={t("topbar.commandPalette")}
        placeholder={t("palette.placeholder")}
        emptyText={t("palette.empty")}
      />

      <Dialog
        open={confirmClose !== null}
        onOpenChange={(open) => !open && store.set({ confirmClose: null })}
        size="sm"
        title={t("close.title", { count: dirtyTabs.length })}
        description={t("close.body", { names: dirtyTabs.map((x) => `“${x!.title}”`).join(", ") })}
        footer={
          <>
            <Button onClick={() => store.set({ confirmClose: null })}>{t("common.cancel")}</Button>
            <Button variant="danger" onClick={() => actions.forceClose(confirmClose ?? [])}>
              {t("close.discard")}
            </Button>
            <Button
              variant="primary"
              onClick={async () => {
                const ids = confirmClose ?? [];
                for (const id of ids) if (!(await actions.save(id))) return;
                actions.forceClose(ids);
              }}
            >
              {t("close.save")}
            </Button>
          </>
        }
      />
      <CommandDialogs />
      <InstallDialogs />
      <TransferDialogs />
    </WorkbenchFrame>
  );
}
