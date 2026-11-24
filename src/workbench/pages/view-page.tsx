import { useEffect, useRef, useState } from "react";
import { Banner, Button, CodeEditor, Dialog, DropdownMenu, FieldStrip, FormField, IconButton, Input, MultiSelect, Pane, Select, StripField, Switch, Text, Textarea, useToast, type ActionBarItem } from "../../design";
import { useI18n } from "../i18n";
import type { ActionDecl, PageApply, PageDescriptor, RunStatus, ViewField, ViewNode } from "../protocol";
import { applyPageParams, runParams, viewParams } from "./run-params";
import { useRunEndRefresh } from "./run-refresh";
import { useQuery, useUi, useWorkbench } from "../state/context";
import { mergeDraft, type MergeState } from "../state/merge";
import type { TabState } from "../state/store";
import { NewParamRow } from "./new-param-row";
import { Frame } from "../parts/frame";
import { DEFAULT_OUTPUT_TAB, isForeignAction, ResultArea, STATUS_TONE } from "../parts/result-area";
import { TOKENIZERS } from "../parts/sql-tokens";
import { ViewNodes } from "../parts/view-nodes";
import { Badge, FactRow } from "../../design";
import { RunKeepBar } from "../parts/run-keep-bar";
import { clashes, conversationOf, targetInput, useAssistProvider } from "../parts/ai-chat";

const EMPTY: Record<string, unknown> = {};
/** D479: how many turns each tab's conversation showed last, to empty its box when a new one comes in. */
const SEEN_TURNS = new Map<string, number>();

interface FieldProps {
  field: ViewField;
  value: string;
  onChange: (value: string) => void;
  size: "sm" | "md";
  readOnly: boolean;
  id?: string;
  /** Kernel pages: a secret is write-only. `saved` says whether one is stored; the box never shows it. */
  secret?: { saved: boolean };
}

/** The workspace configuration's `ui.language` is chosen from the languages on offer (`i18n.languages`, D379), not typed. */
const LANGUAGE_PARAM = /^(params?[.:])?ui\.language$/;

function LanguageSelect({ id, size, label, value, disabled, onChange }: { id?: string; size: "sm" | "md"; label: string; value: string; disabled: boolean; onChange: (value: string) => void }) {
  const { t } = useI18n();
  const languages = useQuery((c) => (c.i18n ? c.i18n.languages() : Promise.resolve([])), [], ["languages"]);
  const list = languages.data ?? [];
  // A language that is configured but not on offer (its plugin is off) stays visible, as it is.
  const options = [...list, ...(value && !list.some((l) => l.locale === value) ? [{ locale: value, name: value }] : [])];
  return <Select id={id} size={size} aria-label={label} disabled={disabled} value={value || undefined} placeholder={t("field.choose")} onValueChange={onChange} options={options.map((l) => ({ value: l.locale, label: l.name }))} />;
}

const RESOURCE_ID = /^[0-9a-f]{32}$/;

/** A configuration parameter that holds a resource (the kernel draws a reference as a text box of its id) says whose id it is. */
function ResourceName({ id }: { id: string }) {
  const res = useQuery((c) => c.resource.get(id), [id], [`resource:${id}`]);
  if (!res.data || res.data.deleted) return null;
  return (
    <Text size="xs" tone="muted" truncate>
      {res.data.name}
    </Text>
  );
}

/** One form control, chosen by the field's kind. Values are always text; booleans are "true" / "false". */
export function FieldControl({ field, value, onChange, size, readOnly, id, secret }: FieldProps) {
  const { tx, t } = useI18n();
  const label = tx(field.label);
  const placeholder = field.envValue || (field.placeholder ? tx(field.placeholder) : undefined);
  const locked = readOnly || Boolean(field.readOnly);
  if (LANGUAGE_PARAM.test(field.bind ?? field.name) && field.kind === "text") return <LanguageSelect id={id} size={size} label={label} value={value} disabled={locked} onChange={onChange} />;
  // D414: `ref` (a reference to a resource; the page lists the choices as `options`) is drawn like an enum, and `time` like text with presets.
  const kind = field.kind === "ref" ? "enum" : field.kind;
  switch (kind) {
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
    case "multi": {
      // D477: the value is the chosen option values joined with "," (in the order of the options).
      const chosen = (value || field.envValue || "").split(",").map((v) => v.trim()).filter(Boolean);
      return (
        <MultiSelect
          id={id}
          size={size}
          aria-label={label}
          disabled={locked}
          value={chosen}
          placeholder={placeholder ?? t("field.choose")}
          onValueChange={(vs) => onChange(vs.join(","))}
          options={(field.options ?? []).map((o) => ({ value: o.value, label: tx(o.label) }))}
        />
      );
    }
    case "longtext":
      return <Textarea id={id} aria-label={label} rows={4} value={value} readOnly={locked} maxLength={field.maxLength} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />;
    case "code":
      return <CodeEditor label={label} height="auto" framed value={value} readOnly={locked} tokenize={field.language ? TOKENIZERS[field.language] : undefined} onChange={onChange} />;
    case "secret":
      if (secret) return <Input id={id} size={size} aria-label={label} icon="key-round" mono type="password" autoComplete="off" value={value} readOnly={locked} placeholder={secret.saved ? t("field.secretSaved") : t("field.secretUnset")} onChange={(e) => onChange(e.target.value)} />;
      return <Input id={id} size={size} aria-label={label} icon="key-round" mono value={value} readOnly placeholder={t("field.secretUnset")} />;
    default: {
      const time = field.kind === "time";
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
          maxLength={field.maxLength}
          required={field.required || undefined}
          placeholder={placeholder ?? (time ? t("field.timePlaceholder") : undefined)}
          onChange={(e) => onChange(e.target.value)}
        />
      );
      if (!field.presets && !time && field.kind === "text" && field.bind?.startsWith("params.") && RESOURCE_ID.test(value)) {
        return (
          <Pane gap="xs">
            {input}
            <ResourceName id={value} />
          </Pane>
        );
      }
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
    <>
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
    <RunKeepBar run={r} />
    </>
  );
}

/** `protection.readonly` refuses saving and running (the run writes its record); the page says why in its banner. */
function blockedByProtection(descriptor: PageDescriptor, action: ActionDecl): boolean {
  return Boolean(descriptor.restrictions?.includes("readonly")) && (action.role === "save" || action.role === "save-run" || action.role === "run");
}

/**
 * A plugin page drawn from its view tree (§9.3). Bound fields edit the resource and stay unsaved
 * until Save; parameter fields live in the tab. Typing never leaves the browser: the page is only
 * re-resolved ~300 ms after typing stops, when the plugin asked for it (`recompute`).
 */
export function ViewPage({ tab, descriptor: initial }: { tab: TabState; descriptor: PageDescriptor }) {
  const { client, store, actions } = useWorkbench();
  const { t, tx, locale } = useI18n();
  const { toast } = useToast();
  const draft = useUi((s) => s.drafts[tab.id]) ?? EMPTY;
  const [descriptor, setDescriptor] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [ask, setAsk] = useState<ActionDecl | null>(null);
  // D479: an answer's changes for a page that has unsaved changes of its own wait for the user's word.
  const [applyAsk, setApplyAsk] = useState<{ tabId: string; values: Record<string, unknown>; label: string } | null>(null);
  const provider = useAssistProvider();
  const running = useQuery((c) => (tab.runId ? c.run.get(tab.runId) : Promise.resolve(null)), [tab.runId], tab.runId ? [`run:${tab.runId}`] : []);
  const isRunning = running.data?.status === "running";
  // The plugin that owns this resource's type: its own actions are named in full too, and are not "foreign" (D351).
  const kindName = useQuery((c) => (initial.resourceId ? c.resource.get(initial.resourceId) : Promise.resolve(null)), [initial.resourceId], []).data?.kind;
  const ownerPlugin = kindName?.includes(":") ? kindName.slice(0, kindName.indexOf(":")) : undefined;

  useEffect(() => setDescriptor(initial), [initial]);

  // The plugin resolves its own words (title, intro, labels) in the interface language, so a language change means asking for the page again.
  const seenLocale = useRef(locale);
  useEffect(() => {
    if (seenLocale.current === locale) return;
    seenLocale.current = locale;
    actions.updateTab(tab.id, { reload: (store.get().tabs.find((x) => x.id === tab.id)?.reload ?? 0) + 1 });
  }, [locale, tab.id, actions, store]);

  // The saved values changed elsewhere (another client, a plugin) while this page was open (§9.3, D374): fields not typed
  // here just show the new value; a field typed here that was changed to something else asks the user (bar below).
  const pending: MergeState | undefined = useUi((s) => s.merge[tab.id]);
  const valuesKey = JSON.stringify(initial.values);
  useEffect(() => {
    if (initial.autosave) return;
    const st = store.get();
    const before = st.bases[tab.id];
    const typed = st.drafts[tab.id] ?? {};
    if (before && Object.keys(typed).length > 0) {
      const found = mergeDraft(before, initial.values, typed);
      if (found.converged.length > 0) actions.clearDraft(tab.id, found.converged);
      if (found.conflicts.length > 0) {
        store.set((s) => {
          const prev = s.merge[tab.id] ?? { conflicts: [], keep: [] };
          return { merge: { ...s.merge, [tab.id]: { conflicts: [...new Set([...prev.conflicts, ...found.conflicts])], keep: prev.keep.filter((f) => !found.conflicts.includes(f)) } } };
        });
      }
    }
    store.set((s) => ({ bases: { ...s.bases, [tab.id]: initial.values } }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [valuesKey, tab.id]);

  // A plugin page may show what its last run left behind (e.g. a summary it stored): when a run started
  // here ends, ask for the page again. Unsaved drafts live in the store and stay.
  const kernelRun = client.demo !== undefined && !client.demo.target(tab.target);
  useRunEndRefresh(tab.runId, running.data, () => {
    if (kernelRun) actions.updateTab(tab.id, { reload: (store.get().tabs.find((x) => x.id === tab.id)?.reload ?? 0) + 1 });
  });

  // The plugin version this resource is bound to changed (an upgrade took it over): the result on screen belongs to
  // the old version and what the page shows from its last run may differ, so drop the result and read the page again.
  const resourceId = descriptor.resourceId;
  const bound_ = useQuery((c) => (kernelRun && resourceId ? c.resource.get(resourceId).then((r) => r?.pluginVersion ?? null) : Promise.resolve(undefined)), [kernelRun, resourceId], resourceId ? [`resource:${resourceId}`, "plugins"] : []);
  const seenVersion = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const version = bound_.data;
    if (version === undefined) return;
    const before = seenVersion.current;
    seenVersion.current = version;
    if (before !== undefined && before !== version) actions.updateTab(tab.id, { runId: null, reload: (store.get().tabs.find((x) => x.id === tab.id)?.reload ?? 0) + 1 });
  }, [bound_.data, tab.id, actions, store]);

  // "Recompute after the content changed" (§9.3): ask the plugin again 300 ms after typing stops.
  const draftKey = JSON.stringify(draft);
  const conversation = conversationOf(descriptor.view);
  // D479: what is typed in a conversation's input box is a run parameter like a `param: true` field.
  const chatField: ViewField[] = conversation?.input ? [{ name: conversation.input.name, label: conversation.input.name, kind: "longtext", param: true }] : [];
  const paramFields = [...descriptor.view.flatMap((n) => (n.type === "form" ? n.fields.filter((f) => f.param) : [])), ...chatField];
  const kernelPage = client.demo !== undefined && !client.demo.target(tab.target);
  // Page parameters (D358) go along with every resolve; they live in the tab, so changing one never marks the page unsaved.
  // The page's own render and events also get its view state (D467); a run gets only the parameter fields.
  const pageParams = (entered: Record<string, string>) => ({ ...viewParams(entered), ...runParams(paramFields, entered, kernelPage) });
  const paramsKey = JSON.stringify(pageParams(tab.params));
  useEffect(() => {
    if (!initial.recompute || (Object.keys(draft).length === 0 && paramsKey === "{}")) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      client.page.resolve(tab.target, { envId: tab.envId, draft, params: pageParams(tab.params) }).then((next) => !cancelled && setDescriptor(next), actions.fail);
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey, paramsKey, initial.recompute, tab.target, tab.envId, client, actions]);

  const values = descriptor.values;
  const bound = (bind: string): string => String((bind in draft ? draft[bind] : values[bind]) ?? "");
  const readOnly = descriptor.readOnly;

  const setBound = (bind: string, value: string) => {
    if (descriptor.autosave && descriptor.resourceId) client.page.save(`resource:${descriptor.resourceId}`, { [bind]: value }).catch(actions.fail);
    else actions.setDraft(tab.id, bind, typed(bind, value), fieldKinds.get(bind) === "secret" && kernelPage ? "" : kernelPage ? (values[bind] ?? "") : String(values[bind] ?? ""));
  };
  // A stored secret is never put back into the box: it shows only what is typed now, and "saved" as a hint.
  const secretOf = (f: ViewField) => (kernelPage && f.kind === "secret" ? { saved: Boolean(values[f.bind ?? f.name]) } : undefined);
  const fieldValue = (f: ViewField) => (secretOf(f) ? String(draft[f.bind ?? f.name] ?? "") : bound(f.bind ?? f.name));
  const setParam = (name: string, value: string) => actions.updateTab(tab.id, { params: { ...tab.params, [name]: value } });

  const latest = useRef({ descriptor, draft, tab });
  latest.current = { descriptor, draft, tab };

  // Values the kernel types as numbers or booleans go out as such (the controls hold text). Demo pages keep text.
  const fieldKinds = new Map(descriptor.view.flatMap((n) => (n.type === "form" ? n.fields.filter((f) => f.bind && !f.param).map((f) => [f.bind!, f.kind] as const) : [])));
  const typed = (bind: string, value: unknown): unknown => {
    if (!kernelPage || typeof value !== "string") return value;
    const kind = fieldKinds.get(bind);
    if (kind === "number" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
    if (kind === "boolean" && (value === "true" || value === "false")) return value === "true";
    return value;
  };
  const typedAll = (values: Record<string, unknown>) => Object.fromEntries(Object.entries(values).map(([k, v]) => [k, typed(k, v)]));

  const invoke = async (action: ActionDecl, confirmed = false) => {
    if (action.confirm && !confirmed && (action.role === "run" || action.role === "save-run")) {
      setAsk(action);
      return;
    }
    const now = latest.current;
    // A required field left empty stops a save or a run (D414, narrowed by D436); the value may come from the environment or a saved value.
    // D436: an action that declares `ignoreRequired` checks no required field.
    if (!action.ignoreRequired && (action.role === "save" || action.role === "save-run" || action.role === "run")) {
      const missing = now.descriptor.view.flatMap((n) => (n.type === "form" ? n.fields : [])).filter((f) => {
        if (!f.required) return false;
        // D436: a page parameter only matters to a run; saving the page does not use it.
        if (f.param && action.role === "save") return false;
        const v = f.param ? ((store.get().tabs.find((x) => x.id === tab.id) ?? now.tab).params[f.name] ?? f.envValue ?? "") : String(f.bind && f.bind in now.draft ? now.draft[f.bind] : (now.descriptor.values[f.bind ?? f.name] ?? ""));
        return v.trim() === "";
      });
      if (missing.length > 0) {
        toast({ tone: "danger", title: t("field.requiredMissing", { fields: missing.map((f) => tx(f.label)).join(", ") }) });
        return;
      }
    }
    const context = { envId: now.tab.envId, draft: typedAll({ ...now.descriptor.values, ...now.draft }), params: pageParams(now.tab.params) };
    try {
      setBusy(action.id);
      // D429: a page button that declares a `command` runs that command on this page, with the values of the inputs as `args`.
      const command = action.command;
      if (command) {
        // `save-run` with a command saves first, like a run would.
        if (action.role === "save-run" && !(await actions.save(tab.id))) return;
        await actions.command(command, { target: tab.target, tabId: tab.id, ...(tab.node ? { tree: tab.node.tree, nodeKey: tab.node.key } : {}), args: context.draft });
        return;
      }
      if (action.role === "save" || action.role === "save-run") {
        if (!(await actions.save(tab.id))) return;
        if (action.role === "save") toast({ tone: "success", title: t("page.saved") });
      }
      if (action.role === "run" || action.role === "save-run") {
        const fresh = store.get().tabs.find((x) => x.id === tab.id) ?? now.tab;
        const params = runParams(paramFields, fresh.params, kernelPage);
        const runId = await client.run.start({
          action: action.action ?? (action.role === "save-run" ? "run" : action.id),
          resourceId: fresh.target.startsWith("resource:") ? fresh.target.slice(9) : undefined,
          target: fresh.target,
          tabId: tab.id,
          envId: fresh.envId,
          input: { ...context.draft, ...(conversation?.targetTab ? targetInput(store.get(), conversation.targetTab) : {}) },
          params,
        });
        const own = isForeignAction(action.action ?? action.id, ownerPlugin) ? undefined : now.descriptor.resultTabs.find((x) => x.type === "output")?.id;
        actions.updateTab(tab.id, { runId, resultTab: own ?? DEFAULT_OUTPUT_TAB });
        store.set({ panelOpen: true });
      } else if (action.role === "event") {
        const result = await client.page.event(tab.target, action.id, context);
        for (const [bind, value] of Object.entries(result.changes ?? {})) actions.setDraft(tab.id, bind, value, now.descriptor.values[bind]);
        const merged = applyPageParams(now.descriptor.view.flatMap((n) => (n.type === "form" ? n.fields.filter((f) => f.param) : [])), store.get().tabs.find((x) => x.id === tab.id)?.params ?? now.tab.params, result.params);
        if (merged) actions.updateTab(tab.id, { params: merged });
        if (result.message) toast({ tone: "neutral", title: tx(result.message) });
        if (result.apply) startApply(result.apply);
      } else if (action.role === "command") {
        await actions.command(action.id, { target: tab.target, tabId: tab.id });
      }
    } catch (error) {
      actions.fail(error);
    } finally {
      setBusy(null);
    }
  };
  /** A row button of a table (round 12): the page event goes out with the row's index; the plugin's answer is applied like any page event. */
  const rowEvent = async (event: string, row: string) => {
    const now = latest.current;
    const context = { envId: now.tab.envId, draft: typedAll({ ...now.descriptor.values, ...now.draft }), params: pageParams(now.tab.params), row };
    try {
      const result = await client.page.event(tab.target, event, context);
      for (const [bind, value] of Object.entries(result.changes ?? {})) actions.setDraft(tab.id, bind, value, now.descriptor.values[bind]);
      if (result.message) toast({ tone: "neutral", title: tx(result.message) });
      if (result.apply) startApply(result.apply);
    } catch (error) {
      actions.fail(error);
    }
  };
  /** D479: put an answer's changes into the page they are for, as unsaved changes; that page's own typing is asked about first. */
  const putInto = (tabId: string, values: Record<string, unknown>, label: string) => {
    const s = store.get();
    for (const [bind, value] of Object.entries(values)) actions.setDraft(tabId, bind, value, s.bases[tabId]?.[bind]);
    const to = s.tabs.find((x) => x.id === tabId);
    if (to) actions.open(to.target);
    toast({ tone: "success", title: t("apply.done", { name: label }) });
  };
  const startApply = (apply: PageApply) => {
    let s = store.get();
    let tabId = apply.tabId && s.tabs.some((x) => x.id === apply.tabId) ? apply.tabId : s.tabs.find((x) => x.target === apply.target)?.id;
    if (!tabId) {
      actions.open(apply.target, tab.envId ? { envId: tab.envId } : undefined);
      s = store.get();
      tabId = s.tabs.find((x) => x.target === apply.target)?.id;
    }
    if (!tabId) return;
    const label = apply.label ?? "";
    if (clashes(s.drafts[tabId], apply.values).length > 0) setApplyAsk({ tabId, values: apply.values, label });
    else putInto(tabId, apply.values, label);
  };
  const invokeRef = useRef(invoke);
  invokeRef.current = invoke;

  // ⌘S saves, ⌘↵ runs the main action — only the active tab's page is mounted.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      const list = latest.current.descriptor.actions;
      const action = e.key === "s" && !e.shiftKey ? list.find((a) => a.role === "save") : e.key === "Enter" ? (list.find((a) => a.role === "run") ?? list.find((a) => a.role === "save-run")) : undefined;
      if (!action) return;
      e.preventDefault();
      if (!action.disabled && !blockedByProtection(latest.current.descriptor, action)) void invokeRef.current(action);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /** D479: Enter in a conversation's box runs the page action it names. */
  const sendFrom = (actionId: string) => {
    const a = latest.current.descriptor.actions.find((x) => x.id === actionId);
    if (a && !a.disabled && !blockedByProtection(latest.current.descriptor, a)) void invokeRef.current(a);
  };
  // D479: when a new turn comes in, the box it was typed in is emptied.
  const turnCount = conversation?.turns.length ?? -1;
  const inputName = conversation?.input?.name;
  useEffect(() => {
    // Kept per tab outside the page: the page is drawn anew when its run ends.
    const before = SEEN_TURNS.get(tab.id) ?? -1;
    SEEN_TURNS.set(tab.id, turnCount);
    if (!inputName || before < 0 || turnCount <= before) return;
    const fresh = store.get().tabs.find((x) => x.id === tab.id);
    if (fresh?.params[inputName]) actions.updateTab(tab.id, { params: { ...fresh.params, [inputName]: "" } });
  }, [turnCount, inputName, tab.id, actions, store]);
  // D479: the kinds of the fields this page shows, so a chat about it never takes a secret along.
  const kindsKey = JSON.stringify([...fieldKinds]);
  useEffect(() => {
    store.set((s) => ({ fieldKinds: { ...s.fieldKinds, [tab.id]: Object.fromEntries(fieldKinds) } }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kindsKey, tab.id, store]);

  const dirty = Object.keys(draft).length > 0;
  // A workspace configuration page is a list of parameters: it can add the ones the kernel knows (round 5).
  const isConfig = descriptor.breadcrumb[descriptor.breadcrumb.length - 1]?.tree === "config" && Boolean(descriptor.resourceId) && descriptor.autosave;
  const items: ActionBarItem[] = descriptor.actions.map((a) => ({
    key: a.id,
    label: tx(a.label),
    icon: a.icon,
    primary: a.primary,
    danger: a.danger,
    shortcut: a.shortcut,
    loading: busy === a.id || (a.role === "run" && a.primary && isRunning),
    disabled: a.disabled || blockedByProtection(descriptor, a) || (a.role === "save" && !dirty) || (busy !== null && busy !== a.id),
    onSelect: () => void invoke(a),
  }));

  // D479: the one AI entry point — the conversation about this page (made the first time). The page is let AI see first:
  // asking for a chat about it is the user's word for that.
  const chatCommand = provider?.command;
  if (chatCommand && kernelPage && !conversation && (tab.target.startsWith("resource:") || tab.target.startsWith("new:"))) {
    items.push({
      key: "assist",
      label: t("assist.chat"),
      icon: "messages-square",
      onSelect: () =>
        void (async () => {
          try {
            const id = descriptor.resourceId;
            if (id) {
              const r = await client.resource.get(id);
              if (r && !r.aiVisible) {
                await client.resource.setAiVisible(id, true);
                toast({ tone: "neutral", title: t("assist.allowed", { name: r.name }) });
              }
            }
            // A page not saved yet is named by what is typed in its info panel.
            const typedName = store.get().drafts[tab.id]?.name;
            await actions.command(chatCommand, { target: tab.target, tabId: tab.id, args: { envId: tab.envId ?? "", name: typeof typedName === "string" ? typedName : "" } });
          } catch (error) {
            actions.fail(error);
          }
        })(),
    });
  }

  const hasFill = descriptor.view.some((n) => (n.type === "form" && n.fields.some((f) => f.fill)) || (n.type === "text" && n.mono) || n.type === "table");
  const renderForm = (node: Extract<ViewNode, { type: "form" }>) => {
    // Several forms on one page, one of them filling the rest: the others keep their own height instead of being squeezed into each other.
    const stacked = descriptor.view.length > 1 && hasFill;
    if (node.layout === "strip") {
      const strip = (
        <FieldStrip key={node.id} label={tx(node.label)}>
          {node.fields.map((f) => {
            const id = `${tab.id}-${node.id}-${f.name}`;
            return (
              <StripField
                key={f.name}
                label={tx(f.label)}
                hint={f.hint ? tx(f.hint) : undefined}
                source={f.param && f.envSource && !tab.params[f.name] ? t("field.fromEnv", { name: f.envSource }) : undefined}
                wide={f.kind === "date" || f.kind === "datetime" || f.kind === "time"}
                required={f.required}
                fill={f.fill}
                htmlFor={id}
              >
                <FieldControl
                  id={id}
                  field={f}
                  size="sm"
                  readOnly={readOnly && !f.param}
                  value={f.param ? (tab.params[f.name] ?? "") : fieldValue(f)}
                  secret={secretOf(f)}
                  onChange={(v) => (f.param ? setParam(f.name, v) : setBound(f.bind ?? f.name, v))}
                />
              </StripField>
            );
          })}
        </FieldStrip>
      );
      return stacked ? (
        <Pane key={node.id} fixed>
          {strip}
        </Pane>
      ) : (
        strip
      );
    }
    const fill = node.fields.find((f) => f.fill);
    const rest = node.fields.filter((f) => !f.fill);
    return (
      <Pane key={node.id} grow={Boolean(fill)} fixed={stacked && !fill} fillMin={stacked && Boolean(fill)}>
        {rest.length > 0 && (
          <Pane grow={!fill && !stacked} scroll={!stacked} pad="lg" gap="md" width="form">
            {rest.map((f) => (
              <FormField key={f.name} label={tx(f.label)} required={f.required} requiredMark="*" description={f.hint ? tx(f.hint) : undefined}>
                <FieldControl field={f} size="md" readOnly={readOnly} value={fieldValue(f)} secret={secretOf(f)} onChange={(v) => setBound(f.bind ?? f.name, v)} />
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

  const labelOf = (bind: string) => {
    for (const n of descriptor.view) if (n.type === "form") for (const f of n.fields) if ((f.bind ?? f.name) === bind) return tx(f.label);
    return bind;
  };
  const conflictBar = pending && pending.conflicts.length > 0 && (
    <Banner
      tone="warning"
      title={t("merge.title")}
      actions={
        <>
          <Button size="sm" onClick={() => actions.resolveMerge(tab.id, "keep")}>
            {t("merge.keepMine")}
          </Button>
          <Button size="sm" onClick={() => actions.resolveMerge(tab.id, "adopt", descriptor.basis)}>
            {t("merge.useNew")}
          </Button>
        </>
      }
    >
      {t("merge.body", { fields: pending.conflicts.map(labelOf).join(", ") })}
    </Banner>
  );
  return (
    <>
    <Frame tab={tab} descriptor={descriptor} actions={items} panel={descriptor.resultTabs.length > 0 || tab.runId ? <ResultArea tab={tab} descriptor={descriptor} /> : undefined}>
      {conflictBar}
      {descriptor.runId && <RunHeader runId={descriptor.runId} />}
      <Pane grow scroll={!hasFill || descriptor.view.length > 1}>
        {descriptor.view.map((node) => (node.type === "form" ? renderForm(node) : <ViewNodes key={node.id} nodes={[node]} onRowAction={(event, row) => void rowEvent(event, row)} params={tab.params} onSelectRow={setParam} onParam={setParam} onSend={sendFrom} busy={isRunning} compactTables={Boolean(conversation)} />))}
        {/* D470: the workspace configuration adds a parameter right here, under its parameters; no dialog. */}
        {isConfig && (
          <Pane pad="md">
            <NewParamRow own={new Set(Object.keys(descriptor.values).map((k) => k.replace(/^params?[.:]/, "")))} onAdd={(name, value, type) => client.params.set(descriptor.resourceId!, name, value, undefined, type).catch((error) => { actions.fail(error); throw error; })} />
          </Pane>
        )}
      </Pane>
    </Frame>
      <Dialog
        open={applyAsk !== null}
        onOpenChange={(open) => !open && setApplyAsk(null)}
        size="sm"
        title={t("apply.replaceTitle")}
        description={applyAsk ? t("apply.replaceBody", { name: applyAsk.label }) : undefined}
        footer={
          <>
            <Button onClick={() => setApplyAsk(null)}>{t("common.cancel")}</Button>
            <Button
              variant="primary"
              onClick={() => {
                const pending = applyAsk;
                setApplyAsk(null);
                if (pending) putInto(pending.tabId, pending.values, pending.label);
              }}
            >
              {t("apply.replace")}
            </Button>
          </>
        }
      />
      <Dialog
        open={ask !== null}
        onOpenChange={(open) => !open && setAsk(null)}
        size="sm"
        title={t("confirm.title")}
        description={ask?.confirm ? tx(ask.confirm) : undefined}
        footer={
          <>
            <Button onClick={() => setAsk(null)}>{t("common.cancel")}</Button>
            <Button
              variant={ask?.danger ? "danger" : "primary"}
              onClick={() => {
                const pending = ask;
                setAsk(null);
                if (pending) void invoke(pending, true);
              }}
            >
              {t("confirm.ok")}
            </Button>
          </>
        }
      />
    </>
  );
}
