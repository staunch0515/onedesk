import { useEffect, useRef, useState } from "react";
import { CodeEditor, DropdownMenu, FieldStrip, FormField, IconButton, Input, Pane, Select, StripField, Switch, Textarea, useToast, type ActionBarItem } from "../../design";
import { useI18n } from "../i18n";
import type { ActionDecl, PageDescriptor, RunStatus, ViewField, ViewNode } from "../protocol";
import { useQuery, useUi, useWorkbench } from "../state/context";
import type { TabState } from "../state/store";
import { Frame } from "../parts/frame";
import { ResultArea, STATUS_TONE } from "../parts/result-area";
import { TOKENIZERS } from "../parts/sql-tokens";
import { ViewNodes } from "../parts/view-nodes";
import { Badge, FactRow } from "../../design";

const EMPTY: Record<string, unknown> = {};

interface FieldProps {
  field: ViewField;
  value: string;
  onChange: (value: string) => void;
  size: "sm" | "md";
  readOnly: boolean;
  id?: string;
}

/** One form control, chosen by the field's kind. Values are always text; booleans are "true" / "false". */
function FieldControl({ field, value, onChange, size, readOnly, id }: FieldProps) {
  const { tx, t } = useI18n();
  const label = tx(field.label);
  const placeholder = field.envValue || (field.placeholder ? tx(field.placeholder) : undefined);
  const locked = readOnly || Boolean(field.readOnly);
  switch (field.kind) {
    case "boolean":
      return <Switch id={id} aria-label={label} checked={(value || field.envValue) === "true"} disabled={locked} onCheckedChange={(on) => onChange(on ? "true" : "false")} />;
    case "enum":
      return (
        <Select
          id={id}
          size={size}
          aria-label={label}
          disabled={locked}
          value={value || field.envValue || undefined}
          placeholder={t("field.choose")}
          onValueChange={onChange}
          options={(field.options ?? []).map((o) => ({ value: o.value, label: tx(o.label) }))}
        />
      );
    case "longtext":
      return <Textarea id={id} aria-label={label} rows={4} value={value} readOnly={locked} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />;
    case "code":
      return <CodeEditor label={label} height="auto" framed value={value} readOnly={locked} tokenize={field.language ? TOKENIZERS[field.language] : undefined} onChange={onChange} />;
    case "secret":
      return <Input id={id} size={size} aria-label={label} icon="key-round" mono value={value} readOnly placeholder={t("field.secretUnset")} />;
    default: {
      const type = field.kind === "date" ? "date" : field.kind === "datetime" ? "datetime-local" : "text";
      const input = (
        <Input
          id={id}
          size={size}
          aria-label={label}
          type={type}
          inputMode={field.kind === "number" ? "decimal" : undefined}
          value={locked && !value ? (field.envValue ?? "") : value}
          readOnly={locked}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      );
      if (!field.presets || locked) return input;
      return (
        <Pane direction="row" gap="xs" align="center">
          <Pane grow>{input}</Pane>
          <DropdownMenu
            align="end"
            items={field.presets.map((p) => ({ key: p.value + tx(p.label), label: tx(p.label), onSelect: () => onChange(p.value) }))}
            trigger={<IconButton icon="calendar-clock" size={size} variant="secondary" label={t("field.presets", { name: label })} />}
          />
        </Pane>
      );
    }
  }
}

function RunHeader({ runId }: { runId: string }) {
  const { t, dateTime, duration, number } = useI18n();
  const run = useQuery((c) => c.run.get(runId), [runId], [`run:${runId}`]);
  const r = run.data;
  if (!r) return null;
  const statusName: Record<RunStatus, string> = { running: t("run.running"), success: t("run.success"), error: t("run.error"), cancelled: t("run.cancelled") };
  return (
    <FactRow
      items={[
        { key: "status", label: t("run.status"), value: <Badge tone={STATUS_TONE[r.status]} dot>{statusName[r.status]}</Badge> },
        { key: "started", label: t("run.started"), value: dateTime(r.startedAt) },
        { key: "duration", label: t("run.duration"), value: r.summary?.durationMs !== undefined ? duration(r.summary.durationMs) : "—" },
        { key: "rows", label: t("run.rows"), value: r.summary?.rows !== undefined ? number(r.summary.rows) : "—" },
        { key: "env", label: t("run.environment"), value: r.envName ?? "—" },
        { key: "actor", label: t("run.actor"), value: `${r.actor} (${r.source})` },
        ...(r.kept ? [{ key: "kept", label: t("run.keptLabel"), value: <Badge tone="accent" icon="pin">{t("run.kept")}</Badge> }] : []),
      ]}
    />
  );
}

/**
 * A plugin page drawn from its view tree (§9.3). Bound fields edit the resource and stay unsaved
 * until Save; parameter fields live in the tab. Typing never leaves the browser: the page is only
 * re-resolved ~300 ms after typing stops, when the plugin asked for it (`recompute`).
 */
export function ViewPage({ tab, descriptor: initial }: { tab: TabState; descriptor: PageDescriptor }) {
  const { client, store, actions } = useWorkbench();
  const { t, tx } = useI18n();
  const { toast } = useToast();
  const draft = useUi((s) => s.drafts[tab.id]) ?? EMPTY;
  const [descriptor, setDescriptor] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const running = useQuery((c) => (tab.runId ? c.run.get(tab.runId) : Promise.resolve(null)), [tab.runId], tab.runId ? [`run:${tab.runId}`] : []);
  const isRunning = running.data?.status === "running";

  useEffect(() => setDescriptor(initial), [initial]);

  // "Recompute after the content changed" (§9.3): ask the plugin again 300 ms after typing stops.
  const draftKey = JSON.stringify(draft);
  useEffect(() => {
    if (!initial.recompute || Object.keys(draft).length === 0) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      client.page.resolve(tab.target, { envId: tab.envId, draft }).then((next) => !cancelled && setDescriptor(next), actions.fail);
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey, initial.recompute, tab.target, tab.envId, client, actions]);

  const values = descriptor.values;
  const bound = (bind: string): string => String((bind in draft ? draft[bind] : values[bind]) ?? "");
  const readOnly = descriptor.readOnly;
  const paramFields = descriptor.view.flatMap((n) => (n.type === "form" ? n.fields.filter((f) => f.param) : []));

  const setBound = (bind: string, value: string) => {
    if (descriptor.autosave && descriptor.resourceId) client.resource.update(descriptor.resourceId, { [bind]: value }).catch(actions.fail);
    else actions.setDraft(tab.id, bind, value, String(values[bind] ?? ""));
  };
  const setParam = (name: string, value: string) => actions.updateTab(tab.id, { params: { ...tab.params, [name]: value } });

  const latest = useRef({ descriptor, draft, tab });
  latest.current = { descriptor, draft, tab };

  const invoke = async (action: ActionDecl) => {
    const now = latest.current;
    const context = { envId: now.tab.envId, draft: { ...now.descriptor.values, ...now.draft } };
    try {
      setBusy(action.id);
      if (action.role === "save" || action.role === "save-run") {
        if (!(await actions.save(tab.id))) return;
        if (action.role === "save") toast({ tone: "success", title: t("page.saved") });
      }
      if (action.role === "run" || action.role === "save-run") {
        const fresh = store.get().tabs.find((x) => x.id === tab.id) ?? now.tab;
        const params = Object.fromEntries(paramFields.map((f) => [f.name, fresh.params[f.name] || f.envValue || ""]));
        const runId = await client.run.start({
          action: action.role === "save-run" ? "run" : action.id,
          resourceId: fresh.target.startsWith("resource:") ? fresh.target.slice(9) : undefined,
          target: fresh.target,
          tabId: tab.id,
          envId: fresh.envId,
          input: context.draft,
          params,
        });
        actions.updateTab(tab.id, { runId, resultTab: now.descriptor.resultTabs.find((x) => x.type === "output")?.id });
        store.set({ panelOpen: true });
      } else if (action.role === "event") {
        const result = await client.page.event(tab.target, action.id, context);
        for (const [bind, value] of Object.entries(result.changes ?? {})) actions.setDraft(tab.id, bind, value, now.descriptor.values[bind]);
        if (result.message) toast({ tone: "neutral", title: tx(result.message) });
      } else if (action.role === "command") {
        await actions.command(action.id, { target: tab.target, tabId: tab.id });
      }
    } catch (error) {
      actions.fail(error);
    } finally {
      setBusy(null);
    }
  };
  const invokeRef = useRef(invoke);
  invokeRef.current = invoke;

  // ⌘S saves, ⌘↵ runs the main action — only the active tab's page is mounted.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      const list = latest.current.descriptor.actions;
      const action = e.key === "s" && !e.shiftKey ? list.find((a) => a.role === "save") : e.key === "Enter" ? list.find((a) => a.role === "run") : undefined;
      if (!action) return;
      e.preventDefault();
      if (!action.disabled) void invokeRef.current(action);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const dirty = Object.keys(draft).length > 0;
  const items: ActionBarItem[] = descriptor.actions.map((a) => ({
    key: a.id,
    label: tx(a.label),
    icon: a.icon,
    primary: a.primary,
    danger: a.danger,
    shortcut: a.shortcut,
    loading: busy === a.id || (a.role === "run" && a.primary && isRunning),
    disabled: a.disabled || (a.role === "save" && !dirty) || (busy !== null && busy !== a.id),
    onSelect: () => void invoke(a),
  }));

  const renderForm = (node: Extract<ViewNode, { type: "form" }>) => {
    if (node.layout === "strip") {
      return (
        <FieldStrip key={node.id} label={tx(node.label)}>
          {node.fields.map((f) => {
            const id = `${tab.id}-${node.id}-${f.name}`;
            return (
              <StripField
                key={f.name}
                label={tx(f.label)}
                hint={f.hint ? tx(f.hint) : undefined}
                source={f.param && f.envSource && !tab.params[f.name] ? t("field.fromEnv", { name: f.envSource }) : undefined}
                wide={f.kind === "date" || f.kind === "datetime"}
                htmlFor={id}
              >
                <FieldControl
                  id={id}
                  field={f}
                  size="sm"
                  readOnly={readOnly && !f.param}
                  value={f.param ? (tab.params[f.name] ?? "") : bound(f.bind ?? f.name)}
                  onChange={(v) => (f.param ? setParam(f.name, v) : setBound(f.bind ?? f.name, v))}
                />
              </StripField>
            );
          })}
        </FieldStrip>
      );
    }
    const fill = node.fields.find((f) => f.fill);
    const rest = node.fields.filter((f) => !f.fill);
    return (
      <Pane key={node.id} grow={Boolean(fill)}>
        {rest.length > 0 && (
          <Pane grow={!fill} scroll pad="lg" gap="md" width="form">
            {rest.map((f) => (
              <FormField key={f.name} label={tx(f.label)} description={f.hint ? tx(f.hint) : undefined}>
                <FieldControl field={f} size="md" readOnly={readOnly} value={bound(f.bind ?? f.name)} onChange={(v) => setBound(f.bind ?? f.name, v)} />
              </FormField>
            ))}
          </Pane>
        )}
        {fill && (
          <CodeEditor
            label={tx(fill.label)}
            value={bound(fill.bind ?? fill.name)}
            readOnly={readOnly || Boolean(fill.readOnly)}
            placeholder={fill.placeholder ? tx(fill.placeholder) : undefined}
            tokenize={fill.language ? TOKENIZERS[fill.language] : undefined}
            onChange={(v) => setBound(fill.bind ?? fill.name, v)}
          />
        )}
      </Pane>
    );
  };

  const hasFill = descriptor.view.some((n) => (n.type === "form" && n.fields.some((f) => f.fill)) || (n.type === "text" && n.mono) || n.type === "table");
  return (
    <Frame tab={tab} descriptor={descriptor} actions={items} panel={descriptor.resultTabs.length > 0 ? <ResultArea tab={tab} descriptor={descriptor} /> : undefined}>
      {descriptor.runId && <RunHeader runId={descriptor.runId} />}
      <Pane grow scroll={!hasFill}>
        {descriptor.view.map((node) => (node.type === "form" ? renderForm(node) : <ViewNodes key={node.id} nodes={[node]} />))}
      </Pane>
    </Frame>
  );
}
