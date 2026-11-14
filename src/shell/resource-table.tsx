import type { ReactNode } from "react";
import { Badge, Icon, Stack, Table, Text, type TableColumn } from "../design";
import type { Kernel } from "../kernel/contracts";
import type { Resource } from "../plugin-api";
import { formatDateTime, groupLabel } from "./format";
import { t } from "./i18n";
import { useShell } from "./shell-context";

/** Kind display name; resources of disabled (or missing) plugins are marked, not hidden (D15). */
export function kindLabel(kernel: Kernel, kind: string): string {
  const def = kernel.registry.kind(kind);
  if (def) return def.name;
  const owner = kernel.registry.kindOwner(kind);
  const plugin = owner ? kernel.plugins.list().find((p) => p.manifest.id === owner) : undefined;
  return plugin ? t("all.disabledKind", { kind: plugin.manifest.name }) : t("all.unknownKind", { kind });
}

export function ResourceTable({ resources, label, empty }: { resources: Resource[]; label: string; empty: ReactNode }) {
  const { kernel, navigate } = useShell();
  const columns: Array<TableColumn<Resource>> = [
    {
      key: "name",
      header: t("all.col.name"),
      render: (r) => (
        <Stack direction="row" gap="sm" align="center">
          <Icon name={kernel.registry.kind(r.kind)?.icon ?? "file"} size="sm" />
          <Text truncate>{r.name}</Text>
        </Stack>
      ),
    },
    { key: "kind", header: t("all.col.kind"), width: "md", render: (r) => kindLabel(kernel, r.kind) },
    { key: "group", header: t("all.col.group"), width: "md", render: (r) => groupLabel(r.group) },
    {
      key: "tags",
      header: t("all.col.tags"),
      render: (r) =>
        r.tags.length ? (
          <Stack direction="row" gap="xs">
            {r.tags.map((tag) => (
              <Badge key={tag}>{tag}</Badge>
            ))}
          </Stack>
        ) : (
          t("common.empty")
        ),
    },
    { key: "updatedAt", header: t("all.col.updated"), width: "md", numeric: true, muted: true, render: (r) => formatDateTime(r.updatedAt) },
  ];
  return (
    <Table
      columns={columns}
      rows={resources}
      getRowKey={(r) => r.id}
      label={label}
      isRowMuted={(r) => !kernel.registry.kind(r.kind)}
      onRowActivate={(r) => void navigate({ page: "resource", id: r.id })}
      empty={empty}
    />
  );
}
