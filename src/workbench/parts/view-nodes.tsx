import { Button, CodeEditor, DataGrid, EmptyState, Pane, Text, TextBlock, type DataGridColumn } from "../../design";
import { useI18n } from "../i18n";
import type { OutputCell, ViewNode } from "../protocol";
import { useWorkbench } from "../state/context";
import { TOKENIZERS } from "./sql-tokens";

type Indexed = { cells: OutputCell[]; index: number };

/** Draws the read-only view nodes (text, table, link, placeholder). Forms are drawn by the view page. */
export function ViewNodes({ nodes }: { nodes: ViewNode[] }) {
  const { actions } = useWorkbench();
  const { tx } = useI18n();
  return (
    <>
      {nodes.map((node) => {
        switch (node.type) {
          case "text":
            return node.mono ? (
              <CodeEditor key={node.id} label={node.id} value={node.text} readOnly tokenize={node.language ? TOKENIZERS[node.language] : undefined} />
            ) : (
              <Pane key={node.id} pad="md">
                <TextBlock tone={node.tone === "danger" ? "danger" : node.tone === "muted" ? "muted" : "default"}>{node.text}</TextBlock>
              </Pane>
            );
          case "table": {
            const columns: Array<DataGridColumn<Indexed>> = node.columns.map((c, i) => ({ key: c.key, header: c.label, numeric: c.numeric, value: (row) => row.cells[i], width: i === 0 ? 320 : 144 }));
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
                onRowActivate={targets ? (row) => targets[row.index] && actions.open(targets[row.index]!) : undefined}
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
