import type { ReactNode } from "react";
import { ActionBar, Badge, Banner, Breadcrumb, IconButton, PageFrame, PageTitleBar, Pane, Select, Sized, Splitter, TitleBarSlot, type ActionBarItem, type Tone } from "../../design";
import { useI18n } from "../i18n";
import type { NodeState, PageDescriptor } from "../protocol";
import { useQuery, useUi, useWorkbench } from "../state/context";
import type { TabState } from "../state/store";
import { useResize } from "./hooks";
import { InfoPanelPart } from "./info-panel";

const STATE_TONE: Record<NodeState, Tone> = { ok: "neutral", disabled: "neutral", "missing-plugin": "warning", broken: "danger", conflict: "warning" };

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

/** The frame shared by every page: breadcrumb, title, actions, environment, info panel, result area (§9). */
export function Frame({ tab, descriptor, meta, actions, children, panel }: FrameProps) {
  const { store, actions: wb } = useWorkbench();
  const { t, tx } = useI18n();
  const infoOpen = useUi((s) => s.infoOpen);
  const infoWidth = useUi((s) => s.infoWidth);
  const panelOpen = useUi((s) => s.panelOpen);
  const panelHeight = useUi((s) => s.panelHeight);
  const dirty = useUi((s) => Object.keys(s.drafts[tab.id] ?? {}).length > 0);
  const envs = useQuery((c) => (descriptor.usesEnv ? c.params.envOptions() : Promise.resolve([])), [descriptor.usesEnv], ["env", "tree:environments"]);
  const infoResize = useResize("infoWidth", 1);
  const panelResize = useResize("panelHeight", -1);
  const stateName: Record<NodeState, string> = {
    ok: "",
    disabled: t("state.disabled"),
    "missing-plugin": t("state.missingPlugin"),
    broken: t("state.broken"),
    conflict: t("state.conflict"),
  };

  const crumbs = descriptor.breadcrumb.map((c, i) => ({
    key: `${i}-${c.label}`,
    label: c.label,
    icon: c.icon,
    onClick: c.target ? () => wb.open(c.target!) : c.tree && c.key ? () => void wb.reveal(c.tree!, c.key!) : undefined,
  }));

  const showInfo = descriptor.hasInfo && Boolean(descriptor.resourceId);
  const envMissing = descriptor.usesEnv && tab.envId !== null && envs.data !== undefined && !envs.data.some((e) => e.id === tab.envId);

  return (
    <PageFrame
      breadcrumb={<Breadcrumb label={t("page.breadcrumb")} items={crumbs} />}
      header={
        <PageTitleBar
          icon={descriptor.icon}
          title={descriptor.title}
          meta={
            <>
              {descriptor.kindLabel && <Badge>{tx(descriptor.kindLabel)}</Badge>}
              {descriptor.state !== "ok" && <Badge tone={STATE_TONE[descriptor.state]}>{stateName[descriptor.state]}</Badge>}
              {dirty && <Badge tone="warning" dot>{t("page.unsaved")}</Badge>}
              {meta}
            </>
          }
          actions={actions && actions.length > 0 ? <ActionBar items={actions} moreLabel={t("page.more")} label={t("page.actions")} /> : undefined}
          aside={
            descriptor.usesEnv || showInfo ? (
              <>
                {descriptor.usesEnv && (
                  <TitleBarSlot>
                    <Select
                      size="sm"
                      aria-label={t("page.environment")}
                      placeholder={t("page.pickEnvironment")}
                      invalid={envMissing || !tab.envId}
                      value={envMissing ? undefined : (tab.envId ?? undefined)}
                      onValueChange={(envId) => wb.updateTab(tab.id, { envId })}
                      options={(envs.data ?? []).map((e) => ({ value: e.id, label: `${" ".repeat(e.depth)}${e.name}`, icon: "layers" }))}
                    />
                  </TitleBarSlot>
                )}
                {showInfo && (
                  <IconButton icon={infoOpen ? "panel-left-close" : "panel-left-open"} size="sm" label={infoOpen ? t("info.hide") : t("info.show")} aria-pressed={infoOpen} onClick={() => store.set({ infoOpen: !infoOpen })} />
                )}
              </>
            ) : undefined
          }
        />
      }
      notice={
        descriptor.state !== "ok" && descriptor.stateReason ? (
          <Banner tone={descriptor.state === "broken" ? "danger" : descriptor.state === "disabled" ? "info" : "warning"} title={stateName[descriptor.state]}>
            {tx(descriptor.stateReason)}
          </Banner>
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
      {showInfo && infoOpen && (
        <>
          <Sized axis="x" size={infoWidth}>
            <InfoPanelPart resourceId={descriptor.resourceId!} />
          </Sized>
          <Splitter axis="x" label={t("info.resize")} {...infoResize} />
        </>
      )}
      <Pane grow>{children}</Pane>
    </PageFrame>
  );
}
