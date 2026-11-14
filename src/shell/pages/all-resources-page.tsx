import { useMemo, useState } from "react";
import { Badge, Button, EmptyState, ErrorState, FormField, LoadingState, Page, PageBody, PageHeader, Select, Stack } from "../../design";
import { errorInfo } from "../format";
import { useAsync, useKernelTick } from "../hooks";
import { t } from "../i18n";
import { kindLabel, ResourceTable } from "../resource-table";
import { useShell } from "../shell-context";

const ALL = "__all__";

export function AllResourcesPage() {
  const { kernel, openNewResource } = useShell();
  const tick = useKernelTick(kernel, ["resource.created", "resource.updated", "resource.deleted", "plugin.changed"]);
  const data = useAsync(() => kernel.resources.list({ includeDisabled: true }), [kernel, tick]);
  const [kind, setKind] = useState(ALL);
  const [tag, setTag] = useState(ALL);

  const all = useMemo(() => data.data ?? [], [data.data]);
  const kinds = useMemo(() => [...new Set([...kernel.registry.kinds().map((k) => k.id), ...all.map((r) => r.kind)])], [kernel, all]);
  const tags = useMemo(() => [...new Set(all.flatMap((r) => r.tags))].sort((a, b) => a.localeCompare(b, "zh-CN")), [all]);
  const rows = all.filter((r) => (kind === ALL || r.kind === kind) && (tag === ALL || r.tags.includes(tag)));
  const filtered = kind !== ALL || tag !== ALL;
  const clear = () => {
    setKind(ALL);
    setTag(ALL);
  };

  let body;
  if (data.status === "error" && !data.data) {
    const info = errorInfo(data.error);
    body = <ErrorState title={t("common.loadFailed")} reason={info.message} resolution={info.hint ?? t("state.pageErrorResolution")} onRetry={data.reload} retryLabel={t("common.retry")} />;
  } else if (!data.data) {
    body = <LoadingState label={t("common.loading")} />;
  } else {
    body = (
      <Stack gap="md">
        <Stack direction="row" gap="md" align="end" wrap>
          <FormField label={t("all.filterKind")}>
            <Select
            size="sm"
            value={kind}
            onValueChange={setKind}
            options={[{ value: ALL, label: t("all.allKinds") }, ...kinds.map((k) => ({ value: k, label: kindLabel(kernel, k) }))]}
            />
          </FormField>
          <FormField label={t("all.filterTag")}>
            <Select
            size="sm"
            value={tag}
            onValueChange={setTag}
            options={[{ value: ALL, label: t("all.allTags") }, ...tags.map((x) => ({ value: x, label: x }))]}
            />
          </FormField>
          {filtered && (
            <Button size="sm" variant="ghost" icon="x" onClick={clear}>
              {t("all.clearFilters")}
            </Button>
          )}
        </Stack>
        <ResourceTable
          resources={rows}
          label={t("all.tableLabel")}
          empty={
            filtered ? (
              <EmptyState layout="inline" message={t("all.emptyFiltered")} action={<Button size="sm" onClick={clear}>{t("all.clearFilters")}</Button>} />
            ) : (
              <EmptyState layout="inline" message={t("all.empty")} action={<Button size="sm" variant="primary" icon="plus" onClick={() => openNewResource()}>{t("topbar.new")}</Button>} />
            )
          }
        />
      </Stack>
    );
  }

  return (
    <Page>
      <PageHeader
        icon="layout-grid"
        title={t("all.title")}
        description={t("all.description")}
        meta={data.data ? <Badge>{t("all.count", { count: rows.length })}</Badge> : undefined}
      />
      <PageBody width="full">{body}</PageBody>
    </Page>
  );
}
