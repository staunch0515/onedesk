import { useState } from "react";
import { Button, DataGrid, Dialog, EmptyState, Icon, LoadingState, Pane, Text, type DataGridColumn } from "../../design";
import { useI18n } from "../i18n";
import type { PageDescriptor, Resource } from "../protocol";
import { useQuery, useWorkbench } from "../state/context";
import type { TabState } from "../state/store";
import { Frame } from "../parts/frame";

/** Deleted items (§3.4): restore, or delete permanently after a second confirmation (I.0c). */
export function DeletedPage({ tab, descriptor }: { tab: TabState; descriptor: PageDescriptor }) {
  const { client, actions } = useWorkbench();
  const { t, tx, dateTime } = useI18n();
  const rows = useQuery((c) => c.resource.listDeleted(), [], ["tree:deleted"]);
  const [purge, setPurge] = useState<Resource | null>(null);

  const columns: Array<DataGridColumn<Resource>> = [
    {
      key: "name",
      header: t("deleted.name"),
      width: 320,
      value: (r) => r.name,
      render: (r) => (
        <Pane direction="row" gap="sm" align="center">
          <Icon name={r.icon} size="md" />
          <Text truncate>{r.name}</Text>
        </Pane>
      ),
    },
    { key: "kind", header: t("deleted.kind"), width: 144, value: (r) => tx(r.kindLabel) },
    { key: "location", header: t("deleted.location"), width: 280, muted: true, value: (r) => r.location.join(" / ") },
    { key: "at", header: t("deleted.at"), width: 160, value: (r) => r.updatedAt, render: (r) => dateTime(r.updatedAt) },
    {
      key: "actions",
      header: "",
      width: 264,
      sortable: false,
      resizable: false,
      render: (r) => (
        <Pane direction="row" gap="xs" align="center">
          <Button size="sm" icon="undo-2" onClick={() => client.resource.undelete(r.id).catch(actions.fail)}>
            {t("deleted.restore")}
          </Button>
          <Button size="sm" variant="ghost" icon="trash-2" onClick={() => setPurge(r)}>
            {t("deleted.purge")}
          </Button>
        </Pane>
      ),
    },
  ];

  return (
    <Frame tab={tab} descriptor={{ ...descriptor, title: t("deleted.title") }}>
      <Pane grow>
        {!rows.data ? (
          <LoadingState layout="inline" label={t("common.loading")} />
        ) : (
          <DataGrid label={t("deleted.title")} size="regular" columns={columns} rows={rows.data} getRowKey={(r) => r.id} nullText="" empty={<EmptyState layout="inline" icon="trash-2" message={t("deleted.empty")} />} />
        )}
      </Pane>
      <Dialog
        open={purge !== null}
        onOpenChange={(open) => !open && setPurge(null)}
        size="sm"
        title={t("deleted.purgeTitle")}
        description={t("deleted.purgeBody", { name: purge?.name ?? "" })}
        footer={
          <>
            <Button onClick={() => setPurge(null)}>{t("common.cancel")}</Button>
            <Button
              variant="danger"
              onClick={() => {
                if (purge) client.resource.purge(purge.id).catch(actions.fail);
                setPurge(null);
              }}
            >
              {t("deleted.purge")}
            </Button>
          </>
        }
      />
    </Frame>
  );
}
