import { useEffect, useMemo, useState } from "react";
import { Button, EmptyState, ErrorState, Kbd, LoadingState, Pane } from "../../design";
import { useI18n } from "../i18n";
import { AuditPage } from "../pages/audit-page";
import { DeletedPage } from "../pages/deleted-page";
import { EnvPage } from "../pages/env-page";
import { PluginPage } from "../pages/plugin-page";
import { SECRETS_TARGET, SecretsPage } from "../pages/secrets-page";
import { ViewPage } from "../pages/view-page";
import type { PageDescriptor } from "../protocol";
import { useQuery, useWorkbench } from "../state/context";
import type { TabState } from "../state/store";
import { Frame } from "./frame";

function topicsFor(target: string): string[] {
  const topics = ["plugins", "env"];
  if (target.startsWith("resource:")) topics.push(target);
  if (target.startsWith("run:")) topics.push(target, "runs");
  return topics;
}

/**
 * A plugin's event handlers may change its own storage after the page was drawn (D336); the kernel then says so on
 * `plugin:<id>`. The plugins this page belongs to are the one named by its target, the ones its actions run, and the
 * one that owns its resource. Hearing any of them resolves the page again; the draft goes along (see `ResolvedPage`),
 * so nothing typed and not yet saved is lost.
 */
function usePluginTopics(tab: TabState, d: PageDescriptor | undefined, reload: () => void): void {
  const { client } = useWorkbench();
  const [owner, setOwner] = useState<{ resource: string; plugin: string } | null>(null);
  const resourceId = d?.resourceId;
  useEffect(() => {
    if (!resourceId) return;
    let live = true;
    client.resource.get(resourceId).then(
      (r) => live && r && setOwner({ resource: resourceId, plugin: r.kind.split(":")[0]! }),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [client, resourceId]);
  const key = useMemo(() => {
    const ids = new Set<string>();
    if (tab.target.startsWith("plugin:")) ids.add(tab.target.slice("plugin:".length));
    for (const a of d?.actions ?? []) if (a.action?.includes(":")) ids.add(a.action.split(":")[0]!);
    if (owner && owner.resource === resourceId && owner.plugin && owner.plugin !== "core") ids.add(owner.plugin);
    return [...ids].sort().join("|");
  }, [tab.target, d?.actions, owner, resourceId]);
  useEffect(() => {
    if (!key) return;
    const offs = key.split("|").map((id) => client.events.subscribe(`plugin:${id}`, reload));
    return () => offs.forEach((off) => off());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, key]);
}

/** Resolves the tab's target into a page (§9.1) and draws it. Only the active tab is mounted. */
export function PageHost({ tab }: { tab: TabState }) {
  if (tab.target === SECRETS_TARGET) return <ShellSecrets tab={tab} />;
  return <ResolvedPage tab={tab} />;
}

/** The secrets page belongs to the shell, not to a resolved target. */
function ShellSecrets({ tab }: { tab: TabState }) {
  const { actions } = useWorkbench();
  const { t } = useI18n();
  useEffect(() => actions.updateTab(tab.id, { title: t("secrets.title"), icon: "key-round" }), [tab.id, actions, t]);
  return <SecretsPage tab={tab} />;
}

function ResolvedPage({ tab }: { tab: TabState }) {
  const { store, actions } = useWorkbench();
  const { t, tx } = useI18n();
  const page = useQuery((c) => c.page.resolve(tab.target, { envId: tab.envId, draft: store.get().drafts[tab.id] }), [tab.target, tab.envId, tab.reload], topicsFor(tab.target));
  const d = page.data;
  usePluginTopics(tab, d, page.reload);

  // Keep the tab's cached name, icon and flags in step with the page.
  useEffect(() => {
    if (!d) return;
    const last = d.breadcrumb[d.breadcrumb.length - 1];
    actions.updateTab(tab.id, { title: d.title, icon: d.icon, usesEnv: d.usesEnv, basis: d.basis, missing: !d.found, node: last?.tree && last.key ? { tree: last.tree, key: last.key } : null });
  }, [d, tab.id, actions]);
  useEffect(() => {
    if (d?.usesEnv) store.set({ envTabId: tab.id });
  }, [d?.usesEnv, tab.id, store]);

  if (!d) {
    return page.error ? <ErrorState title={t("page.loadFailed")} reason={page.error} onRetry={page.reload} retryLabel={t("common.retry")} /> : <LoadingState label={t("common.loading")} />;
  }
  switch (d.page) {
    case "env":
      return <EnvPage tab={tab} descriptor={d} />;
    case "plugin":
      return <PluginPage tab={tab} descriptor={d} />;
    case "audit":
      return <AuditPage tab={tab} descriptor={d} />;
    case "deleted":
      return <DeletedPage tab={tab} descriptor={d} />;
    case "missing":
      return (
        <Frame tab={tab} descriptor={d}>
          <ErrorState
            title={t("page.missingTitle")}
            reason={d.stateReason ? tx(d.stateReason) : t("page.missingReason")}
            actions={
              <Button size="sm" onClick={() => actions.forceClose([tab.id])}>
                {t("tabs.close")}
              </Button>
            }
          />
        </Frame>
      );
    default:
      return <ViewPage tab={tab} descriptor={d} />;
  }
}

/** Shown when no tab is open: one sentence about what to do next, no illustration (ui-spec §7). */
export function NoTabs({ onNew, label }: { onNew: () => void; label?: string }) {
  const { store } = useWorkbench();
  const { t } = useI18n();
  return (
    <Pane grow align="center" justify="center">
      <EmptyState
        icon="panels-top-left"
        message={t("empty.message")}
        action={
          <Pane direction="row" gap="sm" align="center">
            <Button variant="primary" icon="plus" onClick={onNew}>
              {label ?? t("empty.new")}
            </Button>
            <Button icon="search" onClick={() => store.set((s) => ({ searchFocus: s.searchFocus + 1 }))}>
              {t("empty.search")}
            </Button>
            <Kbd keys={["⌘", "K"]} />
          </Pane>
        }
      />
    </Pane>
  );
}
