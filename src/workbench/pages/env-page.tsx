import { useState } from "react";
import { Badge, BottomPanel, Button, DataGrid, EmptyState, IconButton, Input, LoadingState, Pane, Popover, Section, Switch, Text, Textarea, Tooltip, useToast, type ActionBarItem, type DataGridColumn } from "../../design";
import { useI18n } from "../i18n";
import type { EnvParam, HistoryEntry, PageDescriptor } from "../protocol";
import { useQuery, useUi, useWorkbench } from "../state/context";
import type { TabState } from "../state/store";
import { Frame } from "../parts/frame";

/** Environment page (I.4): parent chain in the breadcrumb, description, parameters with their source layer, history with restore. */
export function EnvPage({ tab, descriptor }: { tab: TabState; descriptor: PageDescriptor }) {
  const { client, store, actions } = useWorkbench();
  const { t, tx, dateTime } = useI18n();
  const { toast } = useToast();
  const id = descriptor.resourceId!;
  const env = useQuery((c) => c.params.env(id), [id], ["env", `resource:${id}`]);
  const history = useQuery((c) => c.resource.history(id), [id], ["env", `resource:${id}`]);
  const usedBy = useUi((s) => s.tabs.filter((x) => x.usesEnv && x.envId === id).length);
  const panelOpen = useUi((s) => s.panelOpen);
  const widths = useUi((s) => s.gridWidths["env-params"]);
  const historyWidths = useUi((s) => s.gridWidths["env-history"]);
  const [filter, setFilter] = useState("");

  const items: ActionBarItem[] = descriptor.actions.map((a) => ({
    key: a.id,
    label: tx(a.label),
    icon: a.icon,
    danger: a.danger,
    onSelect: () =>
      a.role === "event"
        ? void client.page.event(tab.target, a.id, {}).then((r) => toast({ tone: "success", title: tx(r.message) }), actions.fail)
        : void actions.command(a.id, { target: tab.target, tree: "environments", nodeKey: id }),
  }));

  const set = (name: string, value: string) => client.params.set(id, name, value).catch(actions.fail);

  const columns: Array<DataGridColumn<EnvParam>> = [
    {
      key: "name",
      header: t("env.param"),
      width: 176,
      value: (p) => p.name,
      render: (p) => (
        <Pane direction="row" align="center" gap="xs">
          <Text mono size="sm" truncate>
            {p.name}
          </Text>
          {p.layers && (
            <Popover
              size="md"
              title={t("env.layersTitle", { name: p.name })}
              trigger={<IconButton icon="list-tree" size="sm" label={t("env.layersShow")} />}
            >
              <Pane gap="sm">
                {p.layers.map((l, i) => (
                  <Pane key={l.envId} gap="xs">
                    <Pane direction="row" align="center" gap="xs">
                      <Text size="xs" tone="muted">
                        {String(i + 1)}
                      </Text>
                      <Text size="sm" weight="medium" truncate>
                        {l.name}
                      </Text>
                      {l.effective && <Badge tone="accent">{t("env.layerEffective")}</Badge>}
                    </Pane>
                    {l.value === null ? (
                      <Text size="sm" tone="subtle">
                        {t("env.layerNotSet")}
                      </Text>
                    ) : (
                      <Text mono size="sm">
                        {l.value}
                      </Text>
                    )}
                  </Pane>
                ))}
              </Pane>
            </Popover>
          )}
          {p.declaredBy.length > 0 && (
            <Tooltip content={t("env.declaredBy", { names: p.declaredBy.slice(0, 6).join(", ") + (p.declaredBy.length > 6 ? " …" : "") })}>
              <span tabIndex={0}>
                <Badge>{String(p.declaredBy.length)}</Badge>
              </span>
            </Tooltip>
          )}
        </Pane>
      ),
    },
    { key: "type", header: t("env.type"), width: 64, muted: true, value: (p) => p.type },
    {
      key: "value",
      header: t("env.value"),
      width: 224,
      value: (p) => p.display ?? p.value,
      render: (p) =>
        p.type === "boolean" ? (
          <Switch aria-label={p.name} checked={p.value === "true"} onCheckedChange={(on) => void set(p.name, on ? "true" : "false")} />
        ) : p.type === "secret" ? (
          <Input size="sm" mono icon="key-round" aria-label={p.name} value={p.value} readOnly />
        ) : p.type === "ref" ? (
          <Pane direction="row" gap="xs" align="center">
            <Pane grow>
              <Input size="sm" icon="link" aria-label={p.name} value={p.display ?? p.value} readOnly />
            </Pane>
            <IconButton icon="arrow-up-right" size="sm" label={t("env.openRef")} onClick={() => actions.open(`resource:${p.value}`)} />
          </Pane>
        ) : (
          <Input
            key={`${p.name}:${p.value}:${p.own}`}
            size="sm"
            mono
            aria-label={p.name}
            defaultValue={p.value}
            placeholder={t("env.notSet")}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            onBlur={(e) => {
              if (e.currentTarget.value !== p.value) void set(p.name, e.currentTarget.value);
            }}
          />
        ),
    },
    {
      key: "source",
      header: t("env.source"),
      width: 220,
      value: (p) => (p.own ? "" : p.sourceName || "~"),
      render: (p) =>
        p.own ? (
          <Badge tone="accent" icon="layers">
            {t("env.sourceOwn")}
          </Badge>
        ) : p.sourceName ? (
          <Badge icon="corner-left-up">{t("env.sourceInherited", { name: p.sourceName })}</Badge>
        ) : (
          <Text size="sm" tone="subtle">
            {t("env.sourceNone")}
          </Text>
        ),
    },
    {
      key: "status",
      header: t("env.status"),
      width: 196,
      sortable: false,
      render: (p) => (
        <Pane direction="row" align="center" gap="xs">
          {p.changedUpstream && (
            <>
              <Tooltip content={t("env.changedUpstreamHint", { was: p.changedUpstream.was, now: p.changedUpstream.now, name: p.inherited?.sourceName ?? "" })}>
                <span tabIndex={0}>
                  <Badge tone="warning" icon="triangle-alert">
                    {t("env.changedUpstream")}
                  </Badge>
                </span>
              </Tooltip>
              <Button size="sm" variant="ghost" onClick={() => client.params.acknowledge(id, p.name).catch(actions.fail)}>
                {t("env.keepMine")}
              </Button>
            </>
          )}
          {p.restricted && (
            <Tooltip content={tx(p.restricted)}>
              <span tabIndex={0}>
                <Badge tone="warning" icon="shield-alert">
                  {t("env.restricted")}
                </Badge>
              </span>
            </Tooltip>
          )}
          {p.own && p.inherited && !p.changedUpstream && !p.restricted && (
            <Text size="xs" tone="muted" truncate>
              {t("env.overrides", { name: p.inherited.sourceName, value: p.inherited.value })}
            </Text>
          )}
        </Pane>
      ),
    },
    {
      key: "actions",
      header: "",
      width: 48,
      sortable: false,
      resizable: false,
      render: (p) =>
        p.own ? (
          <IconButton icon={p.inherited ? "undo-2" : "x"} size="sm" label={p.inherited ? t("env.useInherited", { value: p.inherited.value }) : t("env.removeValue")} onClick={() => client.params.unset(id, p.name).catch(actions.fail)} />
        ) : null,
    },
  ];

  const historyColumns: Array<DataGridColumn<HistoryEntry>> = [
    { key: "at", header: t("history.time"), width: 152, value: (h) => h.at, render: (h) => dateTime(h.at) },
    { key: "actor", header: t("history.actor"), width: 104, value: (h) => h.actor },
    {
      key: "field",
      header: t("history.field"),
      width: 208,
      value: (h) => h.field,
      render: (h) => (
        <Pane direction="row" gap="xs" align="center">
          <Text mono size="sm" truncate>
            {h.field.replace(/^param:/, "")}
          </Text>
          {h.restoredFrom && <Badge icon="undo-2">{t("history.restored")}</Badge>}
        </Pane>
      ),
    },
    { key: "before", header: t("history.before"), width: 240, mono: true, value: (h) => h.before },
    { key: "after", header: t("history.after"), width: 240, mono: true, value: (h) => h.after },
    {
      key: "restore",
      header: "",
      width: 112,
      sortable: false,
      resizable: false,
      render: (h) => (
        <Button
          size="sm"
          variant="ghost"
          icon="undo-2"
          onClick={() => client.resource.restore(id, h.id).then(() => toast({ tone: "success", title: t("history.restoredToast", { field: h.field.replace(/^param:/, ""), value: h.before }) }), actions.fail)}
        >
          {t("history.restore")}
        </Button>
      ),
    },
  ];

  const needle = filter.trim().toLowerCase();
  const params = (env.data?.params ?? []).filter((p) => !needle || p.name.toLowerCase().includes(needle) || p.value.toLowerCase().includes(needle));
  const own = env.data?.params.filter((p) => p.own).length ?? 0;

  return (
    <Frame
      tab={tab}
      descriptor={descriptor}
      actions={items}
      meta={
        <>
          {usedBy > 0 && (
            <Badge tone="success" dot>
              {t("env.usedBy", { count: usedBy })}
            </Badge>
          )}
          {env.data && env.data.children.length > 0 && <Badge>{t("env.children", { count: env.data.children.length })}</Badge>}
        </>
      }
      panel={
        <BottomPanel
          label={t("history.title")}
          tabs={[{ value: "history", label: t("history.title"), icon: "history", count: history.data?.length }]}
          value="history"
          onValueChange={() => !panelOpen && store.set({ panelOpen: true })}
          collapsed={!panelOpen}
          trailing={<IconButton icon={panelOpen ? "panel-bottom-close" : "panel-bottom-open"} size="sm" label={panelOpen ? t("result.collapse") : t("result.expand")} onClick={() => store.set({ panelOpen: !panelOpen })} />}
        >
          {!history.data ? (
            <LoadingState layout="inline" label={t("common.loading")} />
          ) : (
            <DataGrid
              label={t("history.title")}
              columns={historyColumns}
              rows={history.data}
              getRowKey={(h) => h.id}
              nullText=""
              widths={historyWidths}
              onWidthsChange={(next) => store.set((s) => ({ gridWidths: { ...s.gridWidths, "env-history": next } }))}
              empty={<EmptyState layout="inline" message={t("history.empty")} />}
            />
          )}
        </BottomPanel>
      }
    >
      {!env.data ? (
        <LoadingState label={t("common.loading")} />
      ) : (
        <Pane grow scroll pad="md" gap="md">
          <Section title={t("env.description")} variant="plain">
            <Textarea
              key={env.data.description}
              rows={2}
              aria-label={t("env.description")}
              defaultValue={env.data.description}
              placeholder={t("env.descriptionPlaceholder")}
              onBlur={(e) => {
                if (e.currentTarget.value !== env.data!.description) client.resource.update(id, { description: e.currentTarget.value }).catch(actions.fail);
              }}
            />
          </Section>
          <Section
            variant="plain"
            title={t("env.params")}
            description={t("env.paramsHint", { own, total: env.data.params.length })}
            actions={<Input size="sm" icon="list-filter" placeholder={t("env.filter")} aria-label={t("env.filter")} value={filter} onChange={(e) => setFilter(e.target.value)} />}
          >
            <DataGrid
              label={t("env.params")}
              size="regular"
              framed
              autoHeight
              columns={columns}
              rows={params}
              getRowKey={(p) => p.name}
              widths={widths}
              onWidthsChange={(next) => store.set((s) => ({ gridWidths: { ...s.gridWidths, "env-params": next } }))}
              empty={<EmptyState layout="inline" message={t("env.noParams")} />}
            />
          </Section>
        </Pane>
      )}
    </Frame>
  );
}
