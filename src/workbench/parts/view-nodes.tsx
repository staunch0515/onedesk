import { useCallback } from "react";
import { Button, CodeEditor, DataGrid, EmptyState, IconButton, MarkdownText, Pane, Text, TextBlock, type DataGridColumn, type ReferenceState } from "../../design";
import { useI18n } from "../i18n";
import type { OutputCell, ViewNode } from "../protocol";
import { useQuery, useUi, useWorkbench } from "../state/context";
import { TOKENIZERS } from "./sql-tokens";

type Indexed = { cells: OutputCell[]; index: number };

/**
 * A text node with `format: "markdown"` (D381). `[[name]]` is resolved with the references of the resource the
 * active tab shows (`refs.outgoing`, the stored text); unresolved or deleted ones show as broken and cannot be opened.
 */
function MarkdownNode({ source }: { source: string }) {
  const { actions } = useWorkbench();
  const target = useUi((s) => s.tabs.find((x) => x.id === s.activeTabId)?.target ?? "");
  const resourceId = target.startsWith("resource:") ? target.slice("resource:".length) : null;
  const refs = useQuery((c) => (resourceId ? c.refs.outgoing(resourceId) : Promise.resolve([])), [resourceId], resourceId ? [`resource:${resourceId}`] : []);
  const lookup = useCallback(
    (name: string) => (refs.data ?? []).find((r) => r.text === name),
    [refs.data],
  );
  const referenceState = useCallback((name: string): ReferenceState => lookup(name)?.state ?? "missing", [lookup]);
  return (
    <Pane pad="md">
      <MarkdownText
        source={source}
        referenceState={referenceState}
        onLinkClick={(href) => void actions.openExternal(href)}
        onReferenceClick={(name) => {
          const to = lookup(name)?.target;
          if (to) actions.open(`resource:${to.id}`);
        }}
      />
    </Pane>
  );
}

/** Draws the read-only view nodes (text, table, link, placeholder). Forms are drawn by the view page. */
export function ViewNodes({ nodes, onRowAction }: { nodes: ViewNode[]; onRowAction?: (event: string, row: string) => void }) {
  const { actions } = useWorkbench();
  const { tx } = useI18n();
  return (
    <>
      {nodes.map((node) => {
        switch (node.type) {
          case "text":
            if (node.format === "markdown" && !node.mono) return <MarkdownNode key={node.id} source={node.text} />;
            return node.mono ? (
              <CodeEditor key={node.id} label={node.id} value={node.text} readOnly tokenize={node.language ? TOKENIZERS[node.language] : undefined} />
            ) : (
              <Pane key={node.id} pad="md">
                <TextBlock tone={node.tone === "danger" ? "danger" : node.tone === "muted" ? "muted" : "default"}>{node.text}</TextBlock>
              </Pane>
            );
          case "table": {
            const columns: Array<DataGridColumn<Indexed>> = node.columns.map((c, i) => ({ key: c.key, header: c.label, numeric: c.numeric, value: (row) => row.cells[i], width: i === 0 ? 320 : 144 }));
            const rowActions = onRowAction ? (node.rowActions ?? []) : [];
            if (rowActions.length > 0) {
              columns.push({
                key: "__actions",
                header: "",
                sortable: false,
                actionCount: rowActions.length,
                render: (row) => (
                  <Pane direction="row" gap="xs">
                    {rowActions.map((a) => (
                      <IconButton
                        key={a.id}
                        icon={a.icon ?? "circle"}
                        size="sm"
                        label={tx(a.label)}
                        onClick={(e) => {
                          e.stopPropagation();
                          onRowAction?.(a.id, node.rowKeys?.[row.index] ?? String(row.index));
                        }}
                        onDoubleClick={(e) => e.stopPropagation()}
                      />
                    ))}
                  </Pane>
                ),
              });
            }
            const targets = node.rowTargets;
            return (
              <DataGrid
                key={node.id}
                label={node.id}
                columns={columns}
                rows={node.rows.map((cells, index) => ({ cells: cells as OutputCell[], index }))}
                getRowKey={(row) => String(row.index)}
                nullText=""
                onRowSelect={targets ? () => undefined : undefined}
                onRowActivate={targets ? (row) => { const to = targets[row.index]; if (to) actions.open(to); } : undefined}
              />
            );
          }
          case "link":
            return (
              <Pane key={node.id} pad="md" align="start">
                <Button variant="ghost" icon="arrow-up-right" onClick={() => actions.open(node.target)}>
                  {tx(node.label)}
                </Button>
              </Pane>
            );
          case "placeholder":
            return (
              <EmptyState
                key={node.id}
                layout="inline"
                icon={node.icon}
                message={tx(node.message)}
                action={
                  node.action ? (
                    <Button size="sm" icon={node.icon} disabled={node.action.disabled}>
                      {tx(node.action.label)}
                    </Button>
                  ) : undefined
                }
              />
            );
          case "form":
            return (
              <Pane key={node.id} pad="md">
                <Text tone="muted">{tx(node.label)}</Text>
              </Pane>
            );
        }
      })}
    </>
  );
}
