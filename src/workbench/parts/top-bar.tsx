import { useEffect, useRef, useState } from "react";
import { Button, DropdownMenu, IconButton, SearchBox, TopBar, useToast, type MenuEntry, type OptionListItem } from "../../design";
import { useI18n } from "../i18n";
import { AI_SETTINGS_TARGET } from "../pages/ai-settings-page";
import { IDENTITY_TARGET } from "../pages/identity-page";
import { SECRETS_TARGET } from "../pages/secrets-page";
import { startExport, startImport, startPackageImport } from "./transfer-dialogs";
import type { SearchHit } from "../protocol";
import { useQuery, useUi, useWorkbench } from "../state/context";
import { switchWorkspace, WorkspaceDialogs, type WorkspaceDialog } from "./workspace-dialogs";

export function TopBarPart({ onSettings }: { onSettings: () => void }) {
  const { client, store, actions } = useWorkbench();
  const { t, tx } = useI18n();
  const { toast } = useToast();
  const workspaces = useQuery((c) => c.workspace.list(), [], ["app.workspacesChanged"]);
  const [workspaceDialog, setWorkspaceDialog] = useState<WorkspaceDialog>(null);
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
  const workspaceMenu: MenuEntry[] = [
    { type: "label", key: "label", label: t("topbar.workspaces") },
    ...(workspaces.data ?? []).map((w): MenuEntry => ({ key: w.id, label: w.name, icon: w.current ? "check" : undefined, onSelect: () => (w.current ? undefined : void switchWorkspace(client, w.id).catch(actions.fail)) })),
    { type: "separator", key: "sep-workspaces" },
    { key: "new-workspace", label: t("topbar.newWorkspace"), icon: "plus", onSelect: () => setWorkspaceDialog({ kind: "create" }) },
    { key: "new-window", label: t("topbar.openInNewWindow"), icon: "app-window", onSelect: () => setWorkspaceDialog({ kind: "manage" }) },
    { key: "manage-workspaces", label: t("topbar.manageWorkspaces"), icon: "settings", onSelect: () => setWorkspaceDialog({ kind: "manage" }) },
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
    <>
      <WorkspaceDialogs dialog={workspaceDialog} setDialog={setWorkspaceDialog} />
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
            <DropdownMenu
              align="end"
              items={[
                { key: "settings", label: t("topbar.settings"), icon: "settings", shortcut: ["⌘", ","], onSelect: onSettings },
                // Connected to a kernel: settings has more than one page (D298 §6: the secrets page lives under settings).
                ...(client.secrets ? [{ key: "secrets", label: t("secrets.title"), icon: "key-round", onSelect: () => actions.open(SECRETS_TARGET) }] : []),
                { key: "ai-settings", label: t("ai.title"), icon: "bot", onSelect: () => actions.open(AI_SETTINGS_TARGET) },
                ...(client.identity ? [{ key: "identity", label: t("identity.title"), icon: "fingerprint", onSelect: () => actions.open(IDENTITY_TARGET) }] : []),
                { type: "separator", key: "sep-transfer" } as MenuEntry,
                { key: "export", label: t("transfer.export"), icon: "folder-output", onSelect: () => void startExport(client, store, actions, (resources, folder) => toast({ tone: "success", title: t("transfer.exportDone", { resources, folder }) })) },
                { key: "import", label: t("transfer.import"), icon: "folder-input", onSelect: () => void startImport(client, store, actions) },
                ...(client.workspace.packageImport ? [{ key: "package", label: t("package.import"), icon: "package-open", onSelect: () => void startPackageImport(client, store, actions) }] : []),
              ]}
              trigger={<IconButton icon="settings" label={t("topbar.settings")} tooltipSide="bottom" />}
            />
          </>
        }
      />
    </>
  );
}
