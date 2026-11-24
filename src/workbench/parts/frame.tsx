import type { ReactNode } from "react";
import { ActionBar, Badge, Banner, IconButton, PageFrame, PageTitleBar, Pane, Select, Sized, Splitter, TitleBarSlot, type ActionBarItem, type Tone } from "../../design";
import { useI18n } from "../i18n";
import { isSourceMissing, type NodeState, type PageDescriptor } from "../protocol";
import { useQuery, useUi, useWorkbench } from "../state/context";
import type { TabState } from "../state/store";
import { useResize, useWindowAtLeast } from "./hooks";
import { InfoPanelPart } from "./info-panel";

/** From this window width up the info panel sits left of the content (near the tree); below it, on the right (D465). */
export const INFO_LEFT_MIN_WIDTH = 1600;

const STATE_TONE: Record<NodeState, Tone> = { ok: "neutral", disabled: "neutral", "missing-plugin": "warning", broken: "danger", conflict: "warning", "load-failed": "danger" };

export interface FrameProps {
  tab: TabState;
  descriptor: PageDescriptor;
  /** Extra badges after the title. */
  meta?: ReactNode;
  actions?: ActionBarItem[];
  /** Page content (fills the area right of the info panel). */
  children: ReactNode;
  /** Result area content (BottomPanel); the frame adds the splitter and the remembered height. */
  panel?: ReactNode;
}

/** The frame shared by every page (§9, D465): breadcrumb ending in the bold title, environment + actions, info panel, result area. */
export function Frame({ tab, descriptor, meta, actions, children, panel }: FrameProps) {
  const { client, store, actions: wb } = useWorkbench();
  const { t, tx, pageTitle } = useI18n();
  const infoOpen = useUi((s) => s.infoOpen);
  const infoWidth = useUi((s) => s.infoWidth);
  const panelOpen = useUi((s) => s.panelOpen);
  const panelHeight = useUi((s) => s.panelHeight);
  const dirty = useUi((s) => Object.keys(s.drafts[tab.id] ?? {}).length > 0);
  const envs = useQuery((c) => (descriptor.usesEnv ? c.params.envOptions() : Promise.resolve([])), [descriptor.usesEnv], ["env", "tree:environments"]);
  // On a wide window the info panel sits left of the content (near the tree), otherwise on the right; it changes sides live.
  const infoLeft = useWindowAtLeast(INFO_LEFT_MIN_WIDTH);
  const infoResize = useResize("infoWidth", infoLeft ? 1 : -1);
  const panelResize = useResize("panelHeight", -1);
  const stateName: Record<NodeState, string> = {
    ok: "",
    disabled: t("state.disabled"),
    "missing-plugin": t("state.missingPlugin"),
    broken: t("state.broken"),
    conflict: t("state.conflict"),
    "load-failed": t("tree.loadFailed"),
  };

  // Said when the kernel gives no reason of its own (D220: shown greyed, never hidden).
  const stateHint: Record<NodeState, string> = {
    ok: "",
    disabled: t("state.disabledHint"),
    "missing-plugin": t("state.missingPluginHint"),
    broken: t("state.brokenHint"),
    conflict: t("state.conflictHint"),
    "load-failed": t("state.brokenHint"),
  };

  const crumbs = descriptor.breadcrumb.map((c, i) => ({
    key: `${i}-${c.label}`,
    label: pageTitle(c.label),
    icon: c.icon,
    onClick: c.target ? () => wb.open(c.target!) : c.tree && c.key ? () => void wb.reveal(c.tree!, c.key!) : undefined,
  }));

  const restrictions = descriptor.restrictions ?? [];
  const showInfo = descriptor.hasInfo && Boolean(descriptor.resourceId);
  const envMissing = descriptor.usesEnv && tab.envId !== null && envs.data !== undefined && !envs.data.some((e) => e.id === tab.envId);

  const envSelect = descriptor.usesEnv ? (
    <TitleBarSlot>
      <Select
        size="sm"
        aria-label={t("page.environment")}
        placeholder={t("page.pickEnvironment")}
        invalid={envMissing || !tab.envId}
        value={envMissing ? undefined : (tab.envId ?? undefined)}
        onValueChange={(envId) => wb.updateTab(tab.id, { envId })}
        options={(envs.data ?? []).map((e) => ({ value: e.id, label: `${" ".repeat(e.depth)}${e.name}`, icon: "layers" }))}
      />
    </TitleBarSlot>
  ) : null;
  const infoToggle = showInfo ? (
    <IconButton icon={infoLeft ? (infoOpen ? "panel-left-close" : "panel-left-open") : infoOpen ? "panel-right-close" : "panel-right-open"} size="sm" label={infoOpen ? t("info.hide") : t("info.show")} aria-pressed={infoOpen} onClick={() => store.set({ infoOpen: !infoOpen })} />
  ) : null;

  return (
    <PageFrame
      header={
        <PageTitleBar
          icon={descriptor.icon}
          title={pageTitle(descriptor.title)}
          // The last crumb is the page's object itself: the title bar shows it as the bold heading.
          crumbs={crumbs.slice(0, -1)}
          crumbsLabel={t("page.breadcrumb")}
          meta={
            <>
              {descriptor.kindLabel && <Badge>{tx(descriptor.kindLabel)}</Badge>}
              {descriptor.state !== "ok" && (isSourceMissing(descriptor.state, descriptor.stateReason) ? <Badge tone="warning">{t("state.stale")}</Badge> : <Badge tone={STATE_TONE[descriptor.state]}>{stateName[descriptor.state]}</Badge>)}
              {client.demo?.target(descriptor.target) && (
                <Badge tone="warning" icon="flask-conical">
                  {t("demo.badge")}
                </Badge>
              )}
              {dirty && <Badge tone="warning" dot>{t("page.unsaved")}</Badge>}
              {meta}
            </>
          }
          actions={actions && actions.length > 0 ? <ActionBar items={actions} moreLabel={t("page.more")} label={t("page.actions")} /> : undefined}
          // The environment comes first in the actions row (the most important choice); the info toggle at its right end.
          lead={envSelect ?? undefined}
          aside={infoToggle ?? undefined}
        />
      }
      notice={
        envMissing || descriptor.state !== "ok" || restrictions.length > 0 ? (
        <>
          {restrictions.includes("readonly") && <Banner tone="info">{t("restrict.readonly")}</Banner>}
          {restrictions.includes("noExport") && <Banner tone="info">{t("restrict.noExport")}</Banner>}
          {envMissing && (
            <Banner tone="warning" title={t("page.envDeletedTitle")}>
              {t("page.envDeletedBody")}
            </Banner>
          )}
          {descriptor.state !== "ok" && isSourceMissing(descriptor.state, descriptor.stateReason) && (
            <Banner tone="warning" title={t("state.stale")}>
              {tx(descriptor.stateReason)}
            </Banner>
          )}
          {descriptor.state !== "ok" && !isSourceMissing(descriptor.state, descriptor.stateReason) && (
            <Banner tone={descriptor.state === "broken" ? "danger" : descriptor.state === "disabled" ? "info" : "warning"} title={stateName[descriptor.state]}>
              {descriptor.stateReason ? (descriptor.state === "missing-plugin" ? t("state.missingPluginNamed", { plugin: tx(descriptor.stateReason) }) : tx(descriptor.stateReason)) : stateHint[descriptor.state]}
            </Banner>
          )}
        </>
        ) : undefined
      }
      panel={
        panel ? (
          panelOpen ? (
            <>
              <Splitter axis="y" label={t("panel.resize")} {...panelResize} />
              <Sized axis="y" size={panelHeight}>
                {panel}
              </Sized>
            </>
          ) : (
            panel
          )
        ) : undefined
      }
    >
      {showInfo && infoOpen && infoLeft && (
        <>
          <Sized axis="x" size={infoWidth}>
            <InfoPanelPart resourceId={descriptor.resourceId!} />
          </Sized>
          <Splitter axis="x" label={t("info.resize")} {...infoResize} />
        </>
      )}
      <Pane grow>{children}</Pane>
      {showInfo && infoOpen && !infoLeft && (
        <>
          <Splitter axis="x" label={t("info.resize")} {...infoResize} />
          <Sized axis="x" size={infoWidth}>
            <InfoPanelPart resourceId={descriptor.resourceId!} side="right" />
          </Sized>
        </>
      )}
    </PageFrame>
  );
}
