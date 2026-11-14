/**
 * Resource page: header (name, kind, group, tags) + actions (default action primary, progress, cancel)
 * + tabs (the kind's views, then “编辑”) + action result panel. Disabled plugin → banner + read-only data.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Badge,
  Banner,
  Button,
  DropdownMenu,
  ErrorState,
  IconButton,
  LoadingState,
  Page,
  PageBody,
  PageHeader,
  Stack,
  Tabs,
  useToast,
} from "../../design";
import { CORE_EDIT_VIEW, type RegisteredAction } from "../../kernel/contracts";
import type { FormNode, Resource, ViewNode } from "../../plugin-api";
import { ActionResultPanel } from "../action-ui";
import { EditView, useEditDraft } from "../edit-view";
import { errorInfo, formatDateTime, groupLabel } from "../format";
import { useAsync, useKernelTick } from "../hooks";
import { t } from "../i18n";
import { useShell } from "../shell-context";
import { kindLabel } from "../resource-table";
import { ViewTree } from "../view-tree";

function bodyValue(v: unknown): FormNode["fields"][number]["value"] {
  if (v === null || v === undefined) return null;
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  return JSON.stringify(v, null, 2);
}

/** Read-only data for resources whose plugin is disabled or missing. */
export function readOnlyNodes(resource: Resource, labels?: Record<string, string>): ViewNode[] {
  return [
    {
      type: "form",
      title: t("resource.fieldsTitle"),
      fields: [
        { label: t("edit.name"), value: resource.name },
        { label: t("edit.group"), value: groupLabel(resource.group) },
        { label: t("edit.tags"), value: resource.tags.join(", ") || null },
        { label: t("edit.description"), value: resource.description || null },
        { label: t("all.col.updated"), value: formatDateTime(resource.updatedAt) },
      ],
    },
    {
      type: "form",
      title: t("resource.readonlyData"),
      fields: Object.entries(resource.body).map(([k, v]) => ({
        label: labels?.[k] ?? k,
        value: bodyValue(v),
        format: typeof v === "object" && v !== null ? ("code" as const) : undefined,
      })),
    },
  ];
}

function PluginView({ viewKey, resource }: { viewKey: string; resource: Resource }) {
  const { kernel, openExternal } = useShell();
  const runTick = useKernelTick(kernel, ["action.completed"]);
  const view = useAsync(() => kernel.views.render(viewKey, resource.id), [kernel, viewKey, resource.id, resource.version, runTick]);
  if (view.status === "error") {
    const info = errorInfo(view.error);
    return (
      <ErrorState
        layout="inline"
        title={t("resource.viewFailed")}
        reason={info.message}
        resolution={info.hint ?? t("resource.viewFailedResolution")}
        onRetry={view.reload}
        retryLabel={t("common.retry")}
      />
    );
  }
  if (!view.data) return <LoadingState layout="inline" label={t("resource.viewLoading")} />;
  return <ViewTree nodes={view.data} onOpenLink={openExternal} />;
}

export function ResourcePage({ id, tab }: { id: string; tab?: string }) {
  const { kernel, navigate, confirm, runAction, setLeaveGuard, openExternal } = useShell();
  const { toast } = useToast();
  const tick = useKernelTick(kernel, ["resource.updated", "resource.deleted", "plugin.changed"]);
  useKernelTick(kernel, ["action.started", "action.completed"]);
  const data = useAsync(() => kernel.resources.get(id), [kernel, id, tick]);
  const resource = data.data ?? null;
  const kind = resource?.kind ?? "";
  const kindDef = resource ? kernel.registry.kind(kind) : undefined;
  const schema = useMemo(() => kindDef?.schema ?? [], [kindDef]);
  const ownerId = resource ? kernel.registry.kindOwner(kind) : undefined;
  const owner = ownerId ? kernel.plugins.list().find((p) => p.manifest.id === ownerId) : undefined;
  const views = kindDef ? kernel.registry.viewsFor(kind) : [];
  const actions = kindDef ? kernel.registry.actionsFor(kind) : [];
  const defaultAction = actions.find((a) => a.isDefaultFor.includes(kind));
  const running = resource ? kernel.actions.running().find((r) => r.resourceId === resource.id) : undefined;
  const lastResult = resource ? kernel.actions.lastResult(resource.id) : undefined;
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<string | undefined>(tab);
  const [moreOpen, setMoreOpen] = useState(false);
  const draft = useEditDraft(kernel, resource, schema);
  const needsReferences = schema.some((f) => f.type === "reference");
  const references = useAsync(() => (needsReferences ? kernel.resources.list() : Promise.resolve([])), [kernel, needsReferences, tick]);

  useEffect(() => setActiveTab(tab), [id, tab]);
  const currentTab = activeTab && views.some((v) => v.key === activeTab) ? activeTab : views[0]?.key;

  // Leave guard: unsaved edits ask before navigating away.
  const guardState = useRef({ dirty: false, name: "" });
  guardState.current = { dirty: draft.dirty, name: resource?.name ?? "" };
  useEffect(() => {
    setLeaveGuard(() => (guardState.current.dirty ? guardState.current.name : null));
    return () => setLeaveGuard(null);
  }, [setLeaveGuard]);

  const save = async () => {
    if (!draft.dirty && !draft.formError) return;
    if (await draft.save()) {
      toast({ title: t("edit.saved"), tone: "success" });
      return;
    }
    // Show what failed: focus the first invalid field, or scroll the error banner into view.
    requestAnimationFrame(() => {
      const invalid = document.querySelector<HTMLElement>("main [aria-invalid=true]");
      if (invalid) invalid.focus();
      else document.querySelector("main")?.scrollTo({ top: 0 });
    });
  };

  const run = (action: RegisteredAction) => {
    if (resource && !running) runAction(action.key, resource);
  };

  // ⌘↵ runs the default action, ⌘S saves the edit form.
  const keys = useRef({ save, runDefault: () => defaultAction && run(defaultAction) });
  keys.current = { save, runDefault: () => defaultAction && run(defaultAction) };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      if (e.key === "s" || e.key === "S") {
        e.preventDefault();
        void keys.current.save();
      } else if (e.key === "Enter" && !document.querySelector("[role=dialog]")) {
        e.preventDefault();
        keys.current.runDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const remove = async () => {
    if (!resource) return;
    const ok = await confirm({
      title: t("resource.deleteTitle", { name: resource.name }),
      description: t("resource.deleteBody"),
      confirmLabel: t("common.delete"),
      danger: true,
    });
    if (!ok) return;
    try {
      await kernel.resources.delete(resource.id);
      setLeaveGuard(null);
      toast({ title: t("resource.deleted", { name: resource.name }), tone: "success" });
      await navigate({ page: "all" });
    } catch (e) {
      const info = errorInfo(e);
      toast({ title: info.message, description: info.hint, tone: "danger" });
    }
  };

  const enableOwner = async () => {
    if (!owner) return;
    try {
      await kernel.plugins.enable(owner.manifest.id);
      toast({ title: t("plugins.enabledToast", { name: owner.manifest.name }), tone: "success" });
    } catch (e) {
      const info = errorInfo(e);
      toast({ title: t("plugins.toggleFailed", { name: owner.manifest.name }), description: info.message, tone: "danger" });
    }
  };

  if (data.status === "error" && !resource) {
    const info = errorInfo(data.error);
    return <ErrorState title={t("common.loadFailed")} reason={info.message} resolution={info.hint ?? t("state.pageErrorResolution")} onRetry={data.reload} retryLabel={t("common.retry")} />;
  }
  if (data.status === "loading" && !resource) return <LoadingState label={t("resource.loading")} />;
  if (!resource) {
    return (
      <ErrorState
        title={t("resource.notFound")}
        reason={t("resource.notFoundReason")}
        resolution={t("resource.notFoundResolution")}
        actions={<Button onClick={() => void navigate({ page: "all" })}>{t("nav.allResources")}</Button>}
      />
    );
  }

  const invalidFields = kindDef ? Object.keys(kernel.resources.validate(kind, resource.body)) : [];
  const fieldLabel = (name: string) => schema.find((f) => f.name === name)?.label ?? name;
  const actionLabel = (key: string | undefined) => (key ? (kernel.registry.action(key)?.label ?? t("action.unknown")) : t("action.unknown"));
  const shownResult = lastResult && lastResult.runId !== dismissed ? lastResult : undefined;
  const others = actions.filter((a) => a !== defaultAction);

  const editing = Boolean(kindDef) && currentTab === CORE_EDIT_VIEW;
  const headerActions = (
    <Stack direction="row" gap="sm" align="center">
      {editing && (
        <Button disabled={!draft.dirty || draft.saving} onClick={draft.reset}>
          {t("edit.reset")}
        </Button>
      )}
      {!editing && others.map((a) => (
        <Button key={a.key} icon={a.icon} disabled={Boolean(running)} loading={running?.key === a.key} onClick={() => run(a)}>
          {a.label}
        </Button>
      ))}
      <DropdownMenu
        open={moreOpen}
        onOpenChange={setMoreOpen}
        align="end"
        trigger={<IconButton icon="ellipsis" label={t("common.more")} variant="secondary" />}
        items={[{ key: "delete", label: t("resource.delete"), icon: "trash-2", danger: true, onSelect: () => void remove() }]}
      />
      {editing && (
        <Button variant="primary" loading={draft.saving} disabled={!draft.dirty && !draft.formError} onClick={() => void save()} title={t("edit.saveShortcut")}>
          {t("common.save")}
        </Button>
      )}
      {!editing && defaultAction && (
        <Button
          variant="primary"
          icon={defaultAction.icon ?? "play"}
          disabled={Boolean(running)}
          loading={running?.key === defaultAction.key}
          onClick={() => run(defaultAction)}
          title={`${defaultAction.label}（⌘↵）`}
        >
          {defaultAction.label}
        </Button>
      )}
    </Stack>
  );

  const meta = (
    <Stack direction="row" gap="xs" align="center" wrap>
      <Badge tone={kindDef ? "accent" : "neutral"}>{kindLabel(kernel, kind)}</Badge>
      <Badge icon="folder">{groupLabel(resource.group)}</Badge>
      {resource.tags.map((tag) => (
        <Badge key={tag} icon="tag">
          {tag}
        </Badge>
      ))}
      {draft.dirty && (
        <Badge tone="warning" dot>
          {t("edit.unsaved")}
        </Badge>
      )}
    </Stack>
  );

  let content;
  if (!kindDef) {
    const labels = Object.fromEntries(schema.map((f) => [f.name, f.label]));
    content = (
      <Stack gap="lg">
        {owner ? (
          <Banner
            tone="warning"
            title={t("resource.pluginDisabled")}
            actions={
              <Button size="sm" onClick={() => void enableOwner()}>
                {t("resource.enablePlugin")}
              </Button>
            }
          >
            {t("resource.pluginDisabledBody", { kind, plugin: owner.manifest.name })}
          </Banner>
        ) : (
          <Banner tone="warning" title={t("resource.orphan", { kind })}>
            {t("resource.orphanBody")}
          </Banner>
        )}
        <ViewTree nodes={readOnlyNodes(resource, labels)} onOpenLink={openExternal} />
      </Stack>
    );
  } else {
    content = (
      <Stack gap="lg">
        {invalidFields.length > 0 && (
          <Banner tone="warning" title={t("resource.invalidBanner")}>
            {t("resource.invalidBannerBody", { fields: invalidFields.map(fieldLabel).join("、") })}
          </Banner>
        )}
        {!editing && (running || shownResult) && (
          <ActionResultPanel
            label={actionLabel(running?.key ?? shownResult?.action)}
            running={running ?? null}
            result={shownResult}
            onCancel={(runId) => kernel.actions.cancel(runId)}
            onDismiss={() => setDismissed(shownResult?.runId ?? null)}
            onOpenLink={openExternal}
          />
        )}
        {currentTab === CORE_EDIT_VIEW ? (
          <EditView draft={draft} schema={schema} references={references.data ?? []} onReload={() => draft.reset()} onSave={() => void save()} />
        ) : currentTab ? (
          <PluginView viewKey={currentTab} resource={resource} />
        ) : null}
      </Stack>
    );
  }

  return (
    <Page>
      <PageHeader
        icon={kindDef?.icon ?? "file"}
        title={resource.name}
        description={resource.description || undefined}
        meta={meta}
        actions={headerActions}
      >
        {kindDef && views.length > 0 && (
          <Tabs
            label={t("resource.tabsLabel")}
            value={currentTab}
            onValueChange={setActiveTab}
            items={views.map((v) => ({ value: v.key, label: v.label, icon: v.icon, content: null }))}
          />
        )}
      </PageHeader>
      <PageBody width={currentTab === CORE_EDIT_VIEW ? "readable" : "default"}>{content}</PageBody>
    </Page>
  );
}
