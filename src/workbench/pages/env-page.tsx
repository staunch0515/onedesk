import { useState } from "react";
import { Badge, BottomPanel, Button, DataGrid, EmptyState, IconButton, Input, LineageList, LoadingState, Pane, Popover, Section, Select, Switch, Text, Tooltip, useToast, type ActionBarItem, type DataGridColumn } from "../../design";
import { useI18n } from "../i18n";
import type { EnvParam, HistoryEntry, PageDescriptor, ParamType } from "../protocol";
import { useQuery, useUi, useWorkbench } from "../state/context";
import type { TabState } from "../state/store";
import { Frame } from "../parts/frame";
import { validParamName } from "./new-param-row";
import { RefPicker } from "./ref-picker";

/** The types a parameter can be given here; a secret is made on the secrets page and keeps its type. */
const TYPES: ParamType[] = ["text", "number", "boolean", "list", "ref"];

/** The value kept when a parameter changes type (D472): a switch is on or off, a reference is chosen again. */
export function valueForType(p: Pick<EnvParam, "type" | "value" | "display">, type: ParamType): string {
  if (type === "boolean") return p.value === "true" ? "true" : "false";
  if (type === "ref") return "";
  if (p.type === "ref") return p.display ?? "";
  return p.value;
}

/**
 * Environment page (I.4): parent chain in the breadcrumb, parameters with their source layer, history with restore.
 * Name and description are in the info panel only (D470). D472: a parameter set here can be renamed and given another
 * type in its row; a new one is typed in the table's last row; "Comes from" opens how the value is set along the parents.
 */
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
  // The reference parameter whose resource is being chosen (G3); `isNew`: the one being added in the last row.
  const [picking, setPicking] = useState<{ name: string; isNew: boolean } | null>(null);
  // The last row: a new parameter (D472).
  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState<ParamType>("text");
  const [newValue, setNewValue] = useState("");

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

  // The page was drawn from this revision; the kernel refuses a change to a parameter that moved since (conflict).
  const basis = env.data ? String(env.data.rev) : undefined;
  const guard = (done: Promise<void>) =>
    done.catch((error) => {
      actions.fail(error);
      env.reload();
    });
  const set = (name: string, value: string, type?: ParamType) => guard(client.params.set(id, name, value, basis, type));
  const ownNames = new Set((env.data?.params ?? []).filter((p) => p.own).map((p) => p.name));
  const typeOptions = TYPES.map((v) => ({ value: v, label: typeLabel(v) }));
  function typeLabel(type: ParamType): string {
    const labels: Record<ParamType, string> = {
      text: t("env.ptypeText"),
      number: t("env.ptypeNumber"),
      boolean: t("env.ptypeBoolean"),
      list: t("env.ptypeList"),
      ref: t("env.ptypeRef"),
      secret: t("env.ptypeSecret"),
    };
    return labels[type];
  }
  const nameProblem = (name: string, was?: string) =>
    name === "" || name === was ? undefined : !validParamName(name) ? t("params.addBadName") : ownNames.has(name) ? t("params.addExists") : undefined;
  const rename = (p: EnvParam, input: HTMLInputElement) => {
    const next = input.value.trim();
    const problem = nameProblem(next, p.name);
    if (next === "" || next === p.name || problem) {
      if (problem) toast({ tone: "danger", title: problem });
      input.value = p.name;
      return;
    }
    void guard(client.params.rename(id, p.name, next, basis));
  };
  const newTrimmed = newName.trim();
  const newProblem = nameProblem(newTrimmed);
  const newReady = newTrimmed !== "" && !newProblem;
  const addNew = (value: string) => {
    if (!newReady) return;
    void client.params.set(id, newTrimmed, value, basis, newType).then(
      () => {
        setNewName("");
        setNewValue("");
        setNewType("text");
      },
      (error) => {
        actions.fail(error);
        env.reload();
      },
    );
  };

  const columns: Array<DataGridColumn<EnvParam>> = [
    {
      key: "name",
      header: t("env.param"),
      width: 176,
      value: (p) => p.name,
      render: (p) => (
        <Pane direction="row" align="center" gap="xs">
          {p.own ? (
            <Pane grow>
              <Input
                key={`name:${p.name}`}
                size="sm"
                mono
                aria-label={t("env.nameOf", { name: p.name })}
                defaultValue={p.name}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                  else if (e.key === "Escape") {
                    e.currentTarget.value = p.name;
                    e.currentTarget.blur();
                  }
                }}
                onBlur={(e) => rename(p, e.currentTarget)}
              />
            </Pane>
          ) : (
            <Text mono size="sm" truncate>
              {p.name}
            </Text>
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
    {
      key: "type",
      header: t("env.type"),
      width: 120,
      value: (p) => typeLabel(p.type),
      render: (p) =>
        p.own && p.type !== "secret" ? (
          <Select size="sm" aria-label={t("env.typeOf", { name: p.name })} options={typeOptions} value={p.type} onValueChange={(v) => void set(p.name, valueForType(p, v as ParamType), v as ParamType)} />
        ) : (
          <Text size="sm" tone="muted">
            {typeLabel(p.type)}
          </Text>
        ),
    },
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
            <IconButton icon="replace" size="sm" label={p.value ? t("env.refChange") : t("env.refChoose")} onClick={() => setPicking({ name: p.name, isNew: false })} />
            {p.value !== "" && <IconButton icon="arrow-up-right" size="sm" label={t("env.openRef")} onClick={() => actions.open(`resource:${p.value}`)} />}
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
      render: (p) => {
        const label = p.own ? t("env.sourceOwn") : p.sourceName ? t("env.sourceInherited", { name: p.sourceName }) : t("env.sourceNone");
        // Never set in a parent environment: nothing to show but where it is.
        if (!p.layers) {
          return p.own ? (
            <Badge tone="accent" icon="layers">
              {label}
            </Badge>
          ) : (
            <Text size="sm" tone="subtle">
              {label}
            </Text>
          );
        }
        const inEffect = (
          <Badge tone="accent" dot>
            {t("env.layerEffective")}
          </Badge>
        );
        const shown = (value: string | undefined) =>
          value === undefined ? (
            <Text size="sm" tone="subtle">
              {t("env.layerNotSet")}
            </Text>
          ) : (
            <Text mono size="sm">
              {value}
            </Text>
          );
        return (
          <Popover
            size="md"
            title={t("env.layersTitle", { name: p.name })}
            trigger={
              <Button size="sm" variant="ghost" icon={p.own ? "layers" : "corner-left-up"} trailingIcon="chevron-down" aria-label={`${label} — ${t("env.layersShow")}`}>
                {label}
              </Button>
            }
          >
            <LineageList
              label={t("env.layersTitle", { name: p.name })}
              items={[
                ...p.layers.map((l) => ({ key: l.envId, label: l.name, value: shown(l.value), badge: !p.own && l.effective ? inEffect : undefined })),
                { key: id, label: t("env.layerThis", { name: env.data?.name ?? "" }), value: shown(p.own ? p.value : undefined), badge: p.own ? inEffect : undefined, current: true },
              ]}
            />
          </Popover>
        );
      },
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
              <Button size="sm" variant="ghost" onClick={() => guard(client.params.acknowledge(id, p.name, basis))}>
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
          <IconButton icon={p.inherited ? "undo-2" : "x"} size="sm" label={p.inherited ? t("env.useInherited", { value: p.inherited.value }) : t("env.removeValue")} onClick={() => guard(client.params.unset(id, p.name, basis))} />
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
          <Section
            variant="plain"
            title={t("env.params")}
            description={t("env.paramsHint", { own, total: env.data.params.length })}
            actions={
              <Input size="sm" icon="list-filter" placeholder={t("env.filter")} aria-label={t("env.filter")} value={filter} onChange={(e) => setFilter(e.target.value)} />
            }
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
              lastRow={{
                // D470/D472: a new parameter is typed in the table's last row; no dialog.
                name: (
                  <Input mono size="sm" aria-label={t("params.newName")} placeholder={t("params.newNamePlaceholder")} invalid={Boolean(newProblem)} value={newName} onChange={(e) => setNewName(e.target.value)} />
                ),
                type: (
                  <Select
                    size="sm"
                    aria-label={t("env.newType")}
                    options={typeOptions}
                    value={newType}
                    onValueChange={(v) => {
                      setNewType(v as ParamType);
                      setNewValue(v === "boolean" ? "false" : "");
                    }}
                  />
                ),
                value:
                  newType === "boolean" ? (
                    <Switch aria-label={t("params.newValue")} checked={newValue === "true"} onCheckedChange={(on) => setNewValue(on ? "true" : "false")} />
                  ) : newType === "ref" ? (
                    <Button size="sm" variant="secondary" icon="link" disabled={!newReady} onClick={() => setPicking({ name: newTrimmed, isNew: true })}>
                      {t("env.refChoose")}
                    </Button>
                  ) : (
                    <Input
                      mono
                      size="sm"
                      aria-label={t("params.newValue")}
                      placeholder={t("params.newValuePlaceholder")}
                      value={newValue}
                      onChange={(e) => setNewValue(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && addNew(newValue)}
                    />
                  ),
                status: newProblem ? (
                  <Text size="xs" tone="danger" truncate>
                    {newProblem}
                  </Text>
                ) : undefined,
                actions: newType === "ref" ? undefined : <IconButton icon="plus" size="sm" variant="secondary" label={t("params.addHere")} disabled={!newReady} onClick={() => addNew(newValue)} />,
              }}
            />
          </Section>
        </Pane>
      )}
      <RefPicker
        open={picking !== null}
        onOpenChange={(open) => !open && setPicking(null)}
        onPick={(resource) => {
          const target = picking;
          setPicking(null);
          if (!target) return;
          if (target.isNew) addNew(resource);
          else void set(target.name, resource);
        }}
      />
    </Frame>
  );
}
