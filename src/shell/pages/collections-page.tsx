import { useEffect, useState } from "react";
import {
  Button,
  Dialog,
  DialogClose,
  EmptyState,
  ErrorState,
  FormField,
  Input,
  LoadingState,
  Page,
  PageBody,
  PageHeader,
  Select,
  Stack,
  Table,
  useToast,
  type TableColumn,
} from "../../design";
import type { Collection } from "../../plugin-api";
import { errorInfo, formatDateTime } from "../format";
import { useAsync, useKernelTick } from "../hooks";
import { t } from "../i18n";
import { kindLabel, ResourceTable } from "../resource-table";
import { useShell } from "../shell-context";

function useRuleSummary() {
  const { kernel } = useShell();
  return (rule: Collection["rule"]) =>
    rule.type === "tag" ? t("collections.ruleSummary.tag", { value: rule.value }) : t("collections.ruleSummary.kind", { value: kindLabel(kernel, rule.value) });
}

function NewCollectionDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { kernel, navigate } = useShell();
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [type, setType] = useState<Collection["rule"]["type"]>("tag");
  const [value, setValue] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const kinds = kernel.registry.kinds();

  useEffect(() => {
    if (!open) return;
    setName("");
    setType("tag");
    setValue("");
    setErrors({});
    void kernel.resources.tags().then((list) => setTags(list.map((x) => x.tag)), () => setTags([]));
  }, [open, kernel]);

  const submit = async () => {
    const next: Record<string, string> = {};
    if (!name.trim()) next.name = t("field.required", { label: t("collections.name") });
    if (!value.trim()) next.value = t("field.required", { label: type === "tag" ? t("collections.ruleTagValue") : t("collections.ruleKindValue") });
    setErrors(next);
    if (Object.keys(next).length) return;
    setSaving(true);
    try {
      const created = await kernel.collections.create({ name: name.trim(), rule: { type, value: value.trim() } });
      onOpenChange(false);
      toast({ title: t("collections.created", { name: created.name }), tone: "success" });
      await navigate({ page: "collections", id: created.id });
    } catch (e) {
      const info = errorInfo(e);
      setErrors(info.fields ?? { name: info.message });
    } finally {
      setSaving(false);
    }
  };

  const valueOptions = type === "kind" ? kinds.map((k) => ({ value: k.id, label: k.name })) : tags.map((x) => ({ value: x, label: x }));
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("collections.new")}
      closeLabel={t("common.close")}
      dismissible={!saving}
      footer={
        <>
          <DialogClose>
            <Button disabled={saving}>{t("common.cancel")}</Button>
          </DialogClose>
          <Button variant="primary" loading={saving} onClick={() => void submit()}>
            {t("common.create")}
          </Button>
        </>
      }
    >
      <Stack gap="md">
        <FormField label={t("collections.name")} required requiredMark={t("common.requiredMark")} error={errors.name}>
          <Input value={name} autoFocus onChange={(e) => setName(e.target.value)} />
        </FormField>
        <FormField label={t("collections.ruleType")}>
          <Select
            value={type}
            onValueChange={(v) => {
              setType(v === "kind" ? "kind" : "tag");
              setValue("");
            }}
            options={[
              { value: "tag", label: t("collections.rule.tag") },
              { value: "kind", label: t("collections.rule.kind") },
            ]}
          />
        </FormField>
        <FormField
          label={type === "tag" ? t("collections.ruleTagValue") : t("collections.ruleKindValue")}
          required
          requiredMark={t("common.requiredMark")}
          error={errors.value}
        >
          {type === "tag" && valueOptions.length === 0 ? (
            <Input value={value} onChange={(e) => setValue(e.target.value)} />
          ) : (
            <Select value={value || undefined} placeholder={t("collections.valuePlaceholder")} onValueChange={setValue} options={valueOptions} />
          )}
        </FormField>
      </Stack>
    </Dialog>
  );
}

function CollectionDetail({ id }: { id: string }) {
  const { kernel, navigate, confirm } = useShell();
  const { toast } = useToast();
  const summary = useRuleSummary();
  const tick = useKernelTick(kernel, ["resource.created", "resource.updated", "resource.deleted", "plugin.changed", "collection.changed"]);
  const data = useAsync(async () => {
    const collection = await kernel.collections.get(id);
    return { collection, resources: collection ? await kernel.collections.resources(id) : [] };
  }, [kernel, id, tick]);

  if (data.status === "error" && !data.data) {
    const info = errorInfo(data.error);
    return <ErrorState title={t("common.loadFailed")} reason={info.message} resolution={info.hint ?? t("state.pageErrorResolution")} onRetry={data.reload} retryLabel={t("common.retry")} />;
  }
  if (!data.data) return <LoadingState label={t("common.loading")} />;
  const { collection, resources } = data.data;
  if (!collection) {
    return (
      <ErrorState
        title={t("resource.notFound")}
        reason={t("resource.notFoundReason")}
        actions={<Button onClick={() => void navigate({ page: "collections" })}>{t("collections.back")}</Button>}
      />
    );
  }
  const remove = async () => {
    const ok = await confirm({
      title: t("collections.deleteTitle", { name: collection.name }),
      description: t("collections.deleteBody"),
      confirmLabel: t("common.delete"),
      danger: true,
    });
    if (!ok) return;
    await kernel.collections.delete(collection.id);
    toast({ title: t("collections.deleted", { name: collection.name }), tone: "success" });
    await navigate({ page: "collections" });
  };
  return (
    <Page>
      <PageHeader
        icon="library"
        title={collection.name}
        description={summary(collection.rule)}
        actions={
          <Stack direction="row" gap="sm">
            <Button icon="arrow-left" variant="ghost" onClick={() => void navigate({ page: "collections" })}>
              {t("collections.back")}
            </Button>
            <Button icon="trash-2" variant="danger" onClick={() => void remove()}>
              {t("collections.delete")}
            </Button>
          </Stack>
        }
      />
      <PageBody width="full">
        <ResourceTable resources={resources} label={collection.name} empty={<EmptyState layout="inline" message={t("collections.itemsEmpty")} />} />
      </PageBody>
    </Page>
  );
}

export function CollectionsPage({ id }: { id?: string }) {
  const { kernel, navigate } = useShell();
  const summary = useRuleSummary();
  const [creating, setCreating] = useState(false);
  const tick = useKernelTick(kernel, ["collection.changed"]);
  const data = useAsync(() => kernel.collections.list(), [kernel, tick]);
  if (id) return <CollectionDetail id={id} />;

  const columns: Array<TableColumn<Collection>> = [
    { key: "name", header: t("collections.col.name") },
    { key: "rule", header: t("collections.col.rule"), render: (c) => summary(c.rule) },
    { key: "createdAt", header: t("collections.col.created"), width: "md", numeric: true, muted: true, render: (c) => formatDateTime(c.createdAt) },
  ];
  let body;
  if (data.status === "error" && !data.data) {
    const info = errorInfo(data.error);
    body = <ErrorState title={t("common.loadFailed")} reason={info.message} resolution={info.hint ?? t("state.pageErrorResolution")} onRetry={data.reload} retryLabel={t("common.retry")} />;
  } else if (!data.data) body = <LoadingState label={t("common.loading")} />;
  else
    body = (
      <Table
        columns={columns}
        rows={data.data}
        getRowKey={(c) => c.id}
        label={t("collections.listLabel")}
        onRowActivate={(c) => void navigate({ page: "collections", id: c.id })}
        empty={<EmptyState layout="inline" message={t("collections.empty")} />}
      />
    );
  return (
    <Page>
      <PageHeader
        icon="library"
        title={t("collections.title")}
        description={t("collections.description")}
        actions={
          <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
            {t("collections.new")}
          </Button>
        }
      />
      <PageBody width="full">{body}</PageBody>
      <NewCollectionDialog open={creating} onOpenChange={setCreating} />
    </Page>
  );
}
