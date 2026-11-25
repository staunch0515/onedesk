import { useCallback } from "react";
import { Button, Chat, ChatInput, ChatTurn, CodeEditor, DataGrid, EmptyState, IconButton, MarkdownText, Pane, Text, TerminalText, TextBlock, type DataGridColumn } from "../../design";
import { useI18n } from "../i18n";
import type { OutputCell, RefInfo, ViewNode } from "../protocol";
import { RefMarkdown, useTabEnv } from "./embeds";
import { BlobImage } from "./blobs";
import { SequenceNodeView } from "./sequence";
import { useQuery, useUi, useWorkbench } from "../state/context";
import { textLines } from "./terminal-lines";
import { TOKENIZERS } from "./sql-tokens";

/** `key` travels with the row (not looked up when a button is clicked) so a button always acts on the row it was drawn for. */
type Indexed = { cells: OutputCell[]; index: number; key: string };

/**
 * A text node with `format: "markdown"` (D381). `[[name]]` is resolved with the references of the resource the
 * active tab shows (`refs.outgoing`, the stored text); unresolved or deleted ones show as broken and cannot be opened.
 */
/**
 * Opens a target from the active page in that page's environment (D466): a composite, a note's [[reference]] or a
 * table row opened from a tab on "Staging" opens on "Staging" too.
 */
export function useOpenHere(): (target: string) => void {
  const { actions } = useWorkbench();
  const envId = useUi((s) => {
    const tab = s.tabs.find((x) => x.id === s.activeTabId);
    return tab?.usesEnv ? tab.envId : null;
  });
  return useCallback((target: string) => actions.open(target, envId ? { envId } : undefined), [actions, envId]);
}

function MarkdownNode({ source }: { source: string }) {
  const target = useUi((s) => s.tabs.find((x) => x.id === s.activeTabId)?.target ?? "");
  const resourceId = target.startsWith("resource:") ? target.slice("resource:".length) : null;
  const refs = useQuery((c) => (resourceId ? c.refs.outgoing(resourceId) : Promise.resolve([])), [resourceId], resourceId ? [`resource:${resourceId}`] : []);
  const envId = useTabEnv();
  // D481: `![[…]]` lines show the other resource's content in place (embeds.tsx).
  return (
    <Pane pad="md">
      <RefMarkdown source={source} refs={refs.data ?? NO_REFS} envId={envId} depth={0} chain={resourceId ? [resourceId] : []} />
    </Pane>
  );
}

const NO_REFS: RefInfo[] = [];

/** Draws the read-only view nodes (text, table, link, placeholder). Forms are drawn by the view page. */
export function ViewNodes({
  nodes,
  onRowAction,
  params,
  onSelectRow,
  onParam,
  onSend,
  busy,
  compactTables,
}: {
  nodes: ViewNode[];
  onRowAction?: (event: string, row: string) => void;
  /** The tab's page parameters: a table's `selectParam` (D474) holds the key of its selected row. */
  params?: Record<string, string>;
  /** Clicking a row of a table with `selectParam` sets that parameter to the row's key. */
  onSelectRow?: (param: string, key: string) => void;
  /** D479: a conversation's input box sets its page parameter… */
  onParam?: (name: string, value: string) => void;
  /** …and Enter runs the page action it names. */
  onSend?: (action: string) => void;
  /** A run of this page is going on: the input box waits. */
  busy?: boolean;
  /** D479: tables grow with their rows instead of filling the page (beside a conversation, which goes on below). */
  compactTables?: boolean;
}) {
  const openHere = useOpenHere();
  const { actions } = useWorkbench();
  const { t, tx } = useI18n();
  return (
    <>
      {nodes.map((node) => {
        switch (node.type) {
          case "text": {
            // Round 17 (X10): `lineTones` colors single lines, `appearance: "terminal"` draws the dark terminal look.
            if (node.appearance === "terminal") return <TerminalText key={node.id} label={t("terminal.label")} lines={textLines(node.text, node.lineTones)} />;
            if (node.lineTones?.some((x) => x && x !== "default")) {
              return (
                <Pane key={node.id} pad="md">
                  {textLines(node.text, node.lineTones).map((l, i) => (
                    <TextBlock key={i} tone={l.tone === "stderr" ? "danger" : l.tone === "muted" || l.tone === "success" || l.tone === "warning" || l.tone === "danger" ? l.tone : "default"}>{l.text || " "}</TextBlock>
                  ))}
                </Pane>
              );
            }
            if (node.format === "markdown" && !node.mono) return <MarkdownNode key={node.id} source={node.text} />;
            return node.mono ? (
              <CodeEditor key={node.id} label={node.id} value={node.text} readOnly tokenize={node.language ? TOKENIZERS[node.language] : undefined} />
            ) : (
              <Pane key={node.id} pad="md">
                <TextBlock tone={node.tone === "danger" ? "danger" : node.tone === "muted" ? "muted" : "default"}>{node.text}</TextBlock>
              </Pane>
            );
          }
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
                          onRowAction?.(a.id, row.key);
                        }}
                        onDoubleClick={(e) => e.stopPropagation()}
                      />
                    ))}
                  </Pane>
                ),
              });
            }
            const targets = node.rowTargets;
            const selectParam = onSelectRow && node.selectParam && node.rowKeys ? node.selectParam : undefined;
            const selectedIndex = selectParam ? (node.rowKeys ?? []).indexOf(params?.[selectParam] ?? "") : -1;
            return (
              <DataGrid
                key={node.id}
                label={node.id}
                columns={columns}
                rows={node.rows.map((cells, index) => ({ cells: cells as OutputCell[], index, key: node.rowKeys?.[index] ?? String(index) }))}
                getRowKey={(row) => String(row.index)}
                nullText=""
                autoHeight={compactTables}
                selectedKey={selectedIndex >= 0 ? String(selectedIndex) : null}
                onRowSelect={selectParam ? (row) => onSelectRow?.(selectParam, row.key) : targets ? () => undefined : undefined}
                onRowActivate={targets ? (row) => { const to = targets[row.index]; if (to) openHere(to); } : undefined}
              />
            );
          }
          case "conversation": {
            const input = node.input;
            return (
              <Chat key={node.id} label={t("chat.label")} turns={node.turns.length}>
                {node.turns.map((turn, i) => (
                  <ChatTurn
                    key={i}
                    role={turn.role}
                    who={turn.role === "user" ? t("chat.me") : t("chat.ai")}
                    note={turn.caption ?? undefined}
                    steps={turn.steps?.map((x) => ({ label: x.label, detail: x.detail ?? undefined, failed: x.failed ?? undefined }))}
                    actions={
                      onRowAction && turn.actions && turn.actions.length > 0
                        ? turn.actions.map((a) => (
                            <Button key={a.id} size="sm" icon={a.icon ?? undefined} onClick={() => onRowAction(a.id, String(i))}>
                              {tx(a.label)}
                            </Button>
                          ))
                        : undefined
                    }
                  >
                    {turn.role === "assistant" ? <MarkdownText source={turn.text} onLinkClick={(href) => void actions.openExternal(href)} /> : <TextBlock>{turn.text}</TextBlock>}
                  </ChatTurn>
                ))}
                {input && onParam && (
                  <ChatInput
                    label={t("chat.input")}
                    value={params?.[input.name] ?? ""}
                    placeholder={input.placeholder ? tx(input.placeholder) : undefined}
                    hint={t("chat.inputHint")}
                    disabled={busy}
                    onChange={(v) => onParam(input.name, v)}
                    onSend={() => onSend?.(input.send)}
                  />
                )}
              </Chat>
            );
          }
          case "sequence":
            return <SequenceNodeView key={node.id} node={node} onEvent={onRowAction} />;
          case "image":
            return (
              <Pane key={node.id} pad="md" align="start">
                <BlobImage blob={node.blob} alt={node.alt ?? undefined} width={node.width ?? undefined} />
              </Pane>
            );
          case "link":
            return (
              <Pane key={node.id} pad="sm" align="start">
                <Button variant="ghost" icon="arrow-up-right" onClick={() => openHere(node.target)}>
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
