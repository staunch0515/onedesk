import { EmptyState, ErrorState, LoadingState, Page, PageBody, PageHeader } from "../../design";
import { errorInfo } from "../format";
import { useAsync, useKernelTick } from "../hooks";
import { t } from "../i18n";
import { ResourceTable } from "../resource-table";
import { useShell } from "../shell-context";

/** Full-text results (name, description, tags, body); resources of disabled plugins shown grey (D15). */
export function SearchPage({ query }: { query: string }) {
  const { kernel } = useShell();
  const tick = useKernelTick(kernel, ["resource.created", "resource.updated", "resource.deleted", "plugin.changed"]);
  const data = useAsync(() => (query ? kernel.search(query, { includeDisabled: true, limit: 200 }) : Promise.resolve([])), [kernel, query, tick]);

  let body;
  if (!query) body = <EmptyState icon="search" message={t("search.prompt")} />;
  else if (data.status === "error" && !data.data) {
    const info = errorInfo(data.error);
    body = <ErrorState title={t("common.loadFailed")} reason={info.message} resolution={info.hint ?? t("state.pageErrorResolution")} onRetry={data.reload} retryLabel={t("common.retry")} />;
  } else if (!data.data) body = <LoadingState label={t("palette.loading")} />;
  else body = <ResourceTable resources={data.data} label={t("search.tableLabel")} empty={<EmptyState layout="inline" message={t("search.empty", { query })} />} />;

  return (
    <Page>
      <PageHeader icon="search" title={query ? t("search.title", { query }) : t("nav.search")} description={t("search.description")} />
      <PageBody width="full">{body}</PageBody>
    </Page>
  );
}
