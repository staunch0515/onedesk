import { useMemo, useState } from "react";
import { ContextMenu, IconButton, Input, OptionList, Pane, Popover, TabStrip, type MenuEntry } from "../../design";
import { useI18n } from "../i18n";
import { useQuery, useUi, useWorkbench } from "../state/context";
import type { TabState } from "../state/store";

/** Pinned tabs always come first; pinning moves a tab to the end of the pinned run. */
function withPinned(tabs: TabState[], id: string, pinned: boolean): TabState[] {
  const tab = tabs.find((t) => t.id === id);
  if (!tab) return tabs;
  const rest = tabs.filter((t) => t.id !== id);
  const firstUnpinned = rest.findIndex((t) => !t.pinned);
  const at = firstUnpinned < 0 ? rest.length : firstUnpinned;
  return [...rest.slice(0, at), { ...tab, pinned }, ...rest.slice(at)];
}

export function TabsPart() {
  const { store, actions } = useWorkbench();
  const { t, pageTitle } = useI18n();
  const tabs = useUi((s) => s.tabs);
  const activeId = useUi((s) => s.activeTabId);
  const drafts = useUi((s) => s.drafts);
  const collapsed = useUi((s) => s.tabStripCollapsed);
  const tasks = useQuery((c) => c.run.tasks(), [], ["runs"]);
  const [menu, setMenu] = useState<{ id: string; point: { x: number; y: number } } | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const [listFilter, setListFilter] = useState("");

  const busy = useMemo(() => new Set((tasks.data ?? []).filter((r) => r.status === "running" && r.tabId).map((r) => r.tabId!)), [tasks.data]);
  const closable = tabs.filter((x) => !x.pinned).map((x) => x.id);

  const menuTab = tabs.find((x) => x.id === menu?.id);
  const menuIndex = tabs.findIndex((x) => x.id === menu?.id);
  const menuItems: MenuEntry[] = menuTab
    ? [
        { key: "close", label: t("tabs.close"), shortcut: ["⌘", "W"], disabled: menuTab.pinned, onSelect: () => actions.close([menuTab.id]) },
        { key: "others", label: t("tabs.closeOthers"), disabled: closable.filter((id) => id !== menuTab.id).length === 0, onSelect: () => actions.close(closable.filter((id) => id !== menuTab.id)) },
        {
          key: "right",
          label: t("tabs.closeRight"),
          disabled: tabs.slice(menuIndex + 1).every((x) => x.pinned),
          onSelect: () => actions.close(tabs.slice(menuIndex + 1).filter((x) => !x.pinned).map((x) => x.id)),
        },
        { key: "all", label: t("tabs.closeAll"), shortcut: ["⌘", "⇧", "W"], onSelect: () => actions.close(closable) },
        { type: "separator", key: "sep" },
        {
          key: "pin",
          label: menuTab.pinned ? t("tabs.unpin") : t("tabs.pin"),
          icon: menuTab.pinned ? "pin-off" : "pin",
          onSelect: () => store.set((s) => ({ tabs: withPinned(s.tabs, menuTab.id, !menuTab.pinned) })),
        },
      ]
    : [];

  const needle = listFilter.trim().toLowerCase();
  const trailing = (
    <>
      <Popover
        open={listOpen}
        onOpenChange={(open) => {
          setListOpen(open);
          if (!open) setListFilter("");
        }}
        align="end"
        label={t("tabs.all")}
        trigger={<IconButton icon="list" size="sm" label={`${t("tabs.all")} (${tabs.length})`} tooltipSide="bottom" />}
      >
        <Pane gap="sm">
          <Input size="sm" icon="search" autoFocus placeholder={t("tabs.filter")} aria-label={t("tabs.filter")} value={listFilter} onChange={(e) => setListFilter(e.target.value)} />
          <OptionList
            scroll
            label={t("tabs.all")}
            empty={t("tabs.none")}
            items={tabs
              .filter((x) => !needle || pageTitle(x.title).toLowerCase().includes(needle))
              .map((x) => ({
                key: x.id,
                label: pageTitle(x.title) || "…",
                icon: x.icon,
                selected: x.id === activeId,
                meta: x.pinned ? t("tabs.pinned") : Object.keys(drafts[x.id] ?? {}).length > 0 ? t("tabs.unsaved") : undefined,
                onSelect: () => {
                  actions.activate(x.id);
                  setListOpen(false);
                },
                trailing: x.pinned ? undefined : <IconButton icon="x" size="sm" label={t("tabs.close")} onClick={() => actions.close([x.id])} />,
              }))}
          />
        </Pane>
      </Popover>
      <IconButton icon="copy-x" size="sm" label={t("tabs.closeAll")} shortcut={["⌘", "⇧", "W"]} tooltipSide="bottom" disabled={closable.length === 0} onClick={() => actions.close(closable)} />
      <IconButton
        icon={collapsed ? "chevrons-down" : "chevrons-up"}
        size="sm"
        label={collapsed ? t("tabs.expandBar") : t("tabs.collapseBar")}
        tooltipSide="bottom"
        onClick={() => store.set({ tabStripCollapsed: !collapsed })}
      />
    </>
  );

  return (
    <>
      <TabStrip
        label={t("tabs.label")}
        closeLabel={t("tabs.close")}
        dropDeniedLabel={t("tabs.cannotDrop")}
        collapsed={collapsed}
        activeId={activeId}
        tabs={tabs.map((x) => ({
          id: x.id,
          label: pageTitle(x.title) || "…",
          icon: x.icon,
          pinned: x.pinned,
          dirty: Object.keys(drafts[x.id] ?? {}).length > 0,
          muted: x.missing,
          busy: busy.has(x.id),
        }))}
        onSelect={actions.activate}
        onClose={(id) => actions.close([id])}
        canReorder={(id, beforeId) => {
          const tab = tabs.find((x) => x.id === id);
          const before = beforeId ? tabs.find((x) => x.id === beforeId) : undefined;
          if (!tab) return false;
          const firstUnpinned = tabs.find((x) => !x.pinned && x.id !== id);
          return tab.pinned ? Boolean(before?.pinned) || beforeId === (firstUnpinned?.id ?? null) : !before || !before.pinned;
        }}
        onReorder={(id, beforeId) =>
          store.set((s) => {
            const tab = s.tabs.find((x) => x.id === id);
            if (!tab) return {};
            const rest = s.tabs.filter((x) => x.id !== id);
            const at = beforeId ? rest.findIndex((x) => x.id === beforeId) : rest.length;
            return { tabs: [...rest.slice(0, at < 0 ? rest.length : at), tab, ...rest.slice(at < 0 ? rest.length : at)] };
          })
        }
        onContextMenu={(id, point) => setMenu({ id, point })}
        trailing={trailing}
      />
      <ContextMenu point={menu?.point ?? null} items={menuItems} onClose={() => setMenu(null)} />
    </>
  );
}
