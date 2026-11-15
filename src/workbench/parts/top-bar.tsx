import { useEffect, useRef, useState } from "react";
import { Button, DropdownMenu, IconButton, SearchBox, TopBar, useToast, type MenuEntry, type OptionListItem } from "../../design";
import { useI18n } from "../i18n";
import type { SearchHit } from "../protocol";
import { useQuery, useUi, useWorkbench } from "../state/context";

export function TopBarPart({ onSettings }: { onSettings: () => void }) {
  const { client, store, actions } = useWorkbench();
  const { t, tx } = useI18n();
  const { toast } = useToast();
  const workspaces = useQuery((c) => c.workspace.list(), []);
  const newItems = useQuery((c) => c.command.newItems(), []);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const focusTick = useUi((s) => s.searchFocus);
  const selectedNode = useUi((s) => s.selected[s.activity] ?? null);
  const activity = useUi((s) => s.activity);

  useEffect(() => {
    if (focusTick > 0) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [focusTick]);

  useEffect(() => {
    const text = query.trim();
    if (!text) {
      setHits([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      client.search.query(text, 12).then((result) => !cancelled && setHits(result), actions.fail);
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, client, actions]);

  const current = workspaces.data?.find((w) => w.current);
  const notInPrototype = () => toast({ tone: "warning", title: t("common.notInPrototype") });
  const workspaceMenu: MenuEntry[] = [
    { type: "label", key: "label", label: t("topbar.workspaces") },
    ...(workspaces.data ?? []).map(
      (w): MenuEntry => ({ key: w.id, label: w.name, icon: w.current ? "check" : "box", onSelect: w.current ? () => undefined : notInPrototype }),
    ),
    { type: "separator", key: "sep" },
    { key: "new", label: t("topbar.newWorkspace"), icon: "plus", onSelect: notInPrototype },
    { key: "window", label: t("topbar.openInNewWindow"), icon: "app-window", onSelect: notInPrototype },
  ];

  const newMenu: MenuEntry[] = (newItems.data ?? []).flatMap((item): MenuEntry[] => [
    ...(item.separatorBefore ? [{ type: "separator", key: `sep-${item.id}` } as MenuEntry] : []),
    { key: item.id, label: tx(item.label), icon: item.icon, disabled: item.disabled, onSelect: () => void actions.command(item.id, { tree: activity, nodeKey: selectedNode }) },
  ]);

  const results: OptionListItem[] = hits.map((hit) => ({
    key: hit.target,
    label: hit.title,
    description: hit.subtitle,
    icon: hit.icon,
    muted: hit.state !== "ok",
    onSelect: () => {
      actions.open(hit.target);
      setQuery("");
    },
  }));

  return (
    <TopBar
      start={
        <DropdownMenu
          items={workspaceMenu}
          trigger={
            <Button variant="ghost" icon="box" trailingIcon="chevrons-up-down">
              {current?.name ?? "…"}
            </Button>
          }
        />
      }
      center={
        <SearchBox
          ref={inputRef}
          value={query}
          onValueChange={setQuery}
          placeholder={t("topbar.searchPlaceholder")}
          label={t("topbar.search")}
          shortcut={["⌘", "K"]}
          results={results}
          resultsLabel={t("topbar.searchResults")}
          emptyText={t("topbar.searchEmpty", { query: query.trim() })}
        />
      }
      end={
        <>
          <DropdownMenu
            align="end"
            items={newMenu}
            trigger={
              <Button variant="primary" icon="plus" trailingIcon="chevron-down">
                {t("topbar.new")}
              </Button>
            }
          />
          <IconButton icon="square-terminal" label={t("topbar.commandPalette")} shortcut={["⌘", "⇧", "P"]} tooltipSide="bottom" onClick={() => store.set({ paletteOpen: true })} />
          <IconButton icon="settings" label={t("topbar.settings")} shortcut={["⌘", ","]} tooltipSide="bottom" onClick={onSettings} />
        </>
      }
    />
  );
}
