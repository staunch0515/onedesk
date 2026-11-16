import { useEffect, useRef, useState } from "react";
import { Badge, Banner, BottomPanel, Button, DataGrid, EmptyState, IconButton, LoadingState, Pane, Progress, Text, TextBlock, useToast, type DataGridColumn, type Tone } from "../../design";
import { useI18n } from "../i18n";
import type { OutputCell, PageDescriptor, Run, RunStatus } from "../protocol";
import { useQuery, useUi, useWorkbench } from "../state/context";
import type { TabState } from "../state/store";
import { startRunExport } from "./transfer-dialogs";
import { ViewNodes } from "./view-nodes";

export const STATUS_TONE: Record<RunStatus, Tone> = { running: "accent", success: "success", error: "danger", cancelled: "neutral" };

function useGridWidths(key: string) {
  const { store } = useWorkbench();
  const widths = useUi((s) => s.gridWidths[key]);
  return { widths, onWidthsChange: (next: Record<string, number>) => store.set((s) => ({ gridWidths: { ...s.gridWidths, [key]: next } })) };
}

function OutputTable({ run, widthKey }: { run: Run; widthKey: string }) {
  const { t } = useI18n();
  const grid = useGridWidths(widthKey);
  if (run.output?.type !== "table") return null;
  const out = run.output;
  const columns: Array<DataGridColumn<OutputCell[]>> = out.columns.map((c, i) => ({
    key: c.key,
    header: c.label,
    numeric: c.numeric,
    value: (row) => row[i],
    width: c.numeric ? 120 : 176,
  }));
  return (
    <DataGrid
      label={t("result.result")}
      columns={columns}
      rows={out.rows as OutputCell[][]}
      getRowKey={(_row, i) => String(i)}
      rowNumbers
      {...grid}
      empty={<EmptyState layout="inline" message={t("result.noRows")} />}
    />
  );
}

/** The most progress messages kept for display while a run is going (older ones scroll away; the finished output is complete). */
const LIVE_LOG_LINES = 2000;

/**
 * What a running action has sent through `ctx.progress`, in order (D332: output streams while the run goes). The kernel keeps only
 * the latest message; the shell collects each new one so streamed output reads as a log, not a flicker. It resets for each run and
 * is dropped when the run ends, because the finished run shows the plugin's complete output instead.
 */
export function useLiveLog(run: Run | null | undefined): string[] {
  const [log, setLog] = useState<{ id: string; lines: string[] }>({ id: "", lines: [] });
  const last = useRef("");
  const running = run?.status === "running" ? run : null;
  const message = running?.progress?.message;
  const id = running?.id;
  useEffect(() => {
    if (!id) return;
    if (message === undefined || message === last.current) return;
    last.current = message;
    setLog((prev) => ({ id, lines: [...(prev.id === id ? prev.lines : []), message].slice(-LIVE_LOG_LINES) }));
  }, [id, message]);
  return id && log.id === id ? log.lines : [];
}

/** Streamed chunks usually end with their own line break (whole lines); only add one where it is missing. */
export function liveText(chunks: string[]): string {
  return chunks.map((c) => (c.endsWith("\n") ? c : `${c}\n`)).join("").replace(/\n$/, "");
}

function OutputTab({ tab, run, widthKey }: { tab: TabState; run: Run | null | undefined; widthKey: string }) {
  const { client, actions } = useWorkbench();
  const { t, runError } = useI18n();
  const live = useLiveLog(run);
  if (run === undefined) return <LoadingState layout="inline" label={t("common.loading")} />;
  if (run === null) return <EmptyState layout="inline" icon="play" message={tab.target.startsWith("run:") ? t("result.gone") : t("result.empty")} />;
  if (run.status === "running") {
    return (
      <Pane grow align="center" justify="center" gap="sm" pad="lg">
        <Progress value={run.progress?.fraction !== undefined ? run.progress.fraction * 100 : undefined} label={t("result.running")} />
        {live.length > 1 ? (
          <Pane grow scroll width="form">
            <TextBlock variant="code" label={t("result.liveOutput")}>{liveText(live)}</TextBlock>
          </Pane>
        ) : (
          <Text size="sm" tone="muted" tabular>
            {run.progress?.message ?? t("result.running")}
          </Text>
        )}
        {run.cancellable && (
          <Button size="sm" icon="square" onClick={() => client.run.cancel(run.id).catch(actions.fail)}>
            {t("result.cancel")}
          </Button>
        )}
      </Pane>
    );
  }
  if (run.status === "error" && run.error) {
    // Errors stay here until the next run or "clear" (I.7): never a toast that disappears.
    return (
      <Pane grow scroll pad="md" gap="sm">
        <Banner tone="danger" title={`${run.error.code} — ${runError(run.error)}`}>
          {run.error.hint}
        </Banner>
        {run.error.detail && (
          <TextBlock variant="code" tone="danger" label={t("result.errorDetail")}>
            {run.error.detail}
          </TextBlock>
        )}
      </Pane>
    );
  }
  if (run.status === "cancelled") return <EmptyState layout="inline" icon="circle-slash" message={t("result.cancelled")} />;
  if (run.output?.type === "table") return <OutputTable run={run} widthKey={widthKey} />;
  if (run.output?.type === "text") {
    return (
      <Pane grow scroll pad="md">
        <TextBlock variant="code" label={t("result.result")}>
          {run.output.text}
        </TextBlock>
      </Pane>
    );
  }
  return <EmptyState layout="inline" icon="circle-check" message={run.summary?.message ?? t("result.noOutput")} />;
}

function HistoryTab({ resourceId }: { resourceId: string }) {
  const { actions } = useWorkbench();
  const { t, dateTime, number, duration } = useI18n();
  const runs = useQuery((c) => c.run.listFor(resourceId), [resourceId], ["runs"]);
  const grid = useGridWidths("history");
  const statusName: Record<RunStatus, string> = { running: t("run.running"), success: t("run.success"), error: t("run.error"), cancelled: t("run.cancelled") };
  if (!runs.data) return <LoadingState layout="inline" label={t("common.loading")} />;
  const columns: Array<DataGridColumn<Run>> = [
    { key: "seq", header: "#", numeric: true, width: 72, value: (r) => r.seq },
    { key: "started", header: t("run.started"), width: 152, value: (r) => r.startedAt, render: (r) => dateTime(r.startedAt) },
    { key: "status", header: t("run.status"), width: 104, value: (r) => r.status, render: (r) => <Badge tone={STATUS_TONE[r.status]} dot>{statusName[r.status]}</Badge> },
    { key: "env", header: t("run.environment"), width: 176, value: (r) => r.envName ?? "" },
    { key: "rows", header: t("run.rows"), numeric: true, width: 88, value: (r) => r.summary?.rows, render: (r) => (r.summary?.rows === undefined ? "" : number(r.summary.rows)) },
    { key: "duration", header: t("run.duration"), numeric: true, width: 96, value: (r) => r.summary?.durationMs, render: (r) => (r.summary?.durationMs === undefined ? "" : duration(r.summary.durationMs)) },
    { key: "actor", header: t("run.actor"), width: 104, value: (r) => r.actor },
    { key: "params", header: t("run.params"), width: 360, mono: true, value: (r) => Object.entries(r.params).map(([k, v]) => `${k}=${v}`).join("  ") },
    { key: "note", header: t("run.note"), width: 280, value: (r) => r.error?.message ?? (r.kept ? t("run.kept") : (r.summary?.message ?? "")) },
  ];
  return (
    <DataGrid
      label={t("result.history")}
      columns={columns}
      rows={runs.data}
      getRowKey={(r) => r.id}
      nullText=""
      activateOnClick
      onRowActivate={(r) => actions.open(`run:${r.id}`)}
      {...grid}
      empty={<EmptyState layout="inline" message={t("result.historyEmpty")} />}
    />
  );
}

function ViewTab({ runId, tabId }: { runId: string | null; tabId: string }) {
  const { t } = useI18n();
  const nodes = useQuery((c) => (runId ? c.run.render(runId, tabId) : Promise.resolve(null)), [runId, tabId], runId ? [`run:${runId}`] : []);
  if (!runId) return <EmptyState layout="inline" icon="play" message={t("result.empty")} />;
  if (!nodes.data) return <LoadingState layout="inline" label={t("common.loading")} />;
  return <ViewNodes nodes={nodes.data} />;
}

/** Id of the shell's own output tab (D351): used when the page has no output tab, and always for another plugin's action. */
export const DEFAULT_OUTPUT_TAB = "run-output";

/** An action added by a dependent plugin carries its plugin id (`<plugin>:<action>`); a page's own actions never do. */
export const isForeignAction = (action: string | undefined): boolean => (action ?? "").includes(":");

/** Result area of a page (§9.5): the page chooses the sub-tabs, the frame owns the toolbar. */
export function ResultArea({ tab, descriptor }: { tab: TabState; descriptor: PageDescriptor }) {
  const { client, store, actions } = useWorkbench();
  const { t, tx, number, duration, time, runError } = useI18n();
  const { toast } = useToast();
  const panelOpen = useUi((s) => s.panelOpen);
  const runId = descriptor.runId ?? tab.runId ?? null;
  const run = useQuery((c) => (runId ? c.run.get(runId) : Promise.resolve(null)), [runId], runId ? [`run:${runId}`] : []);
  const r = run.data;
  // A dependent plugin's output is never drawn by the page owner's tabs (D351): the shell's own output tab shows it, named after the
  // action. A page without an output tab gets the same tab, so a run always has somewhere to show.
  const foreign = isForeignAction(r?.action);
  const ownTabs = descriptor.resultTabs;
  const defaultTab = r && (foreign || !ownTabs.some((x) => x.type === "output")) ? { id: DEFAULT_OUTPUT_TAB, label: r.actionLabel ?? t("result.result"), icon: "terminal", type: "output" as const } : null;
  const tabs = defaultTab ? (foreign ? [defaultTab, ...ownTabs] : [...ownTabs, defaultTab]) : ownTabs;
  const active = tabs.find((x) => x.id === tab.resultTab) ?? tabs[0];
  if (!active) return null;

  const summary = r ? (
    <>
      <Badge tone={STATUS_TONE[r.status]} dot>
        {`#${r.seq}`}
      </Badge>
      {r.status === "running" && <span>{r.progress?.message ?? t("result.running")}</span>}
      {r.status === "error" && <span>{r.error ? runError(r.error) : null}</span>}
      {r.summary?.rows !== undefined && <span>{t("result.rows", { count: number(r.summary.rows) })}</span>}
      {r.summary?.durationMs !== undefined && <span>{duration(r.summary.durationMs)}</span>}
      {r.envName && <span>{r.envName}</span>}
      <span>{time(r.startedAt)}</span>
    </>
  ) : undefined;

  const noExport = descriptor.restrictions?.includes("noExport") ?? false;
  const hasTable = r?.status === "success" && r.output?.type === "table";
  const canCopy = r?.status === "success" && (r.output?.type === "table" || r.output?.type === "text");
  return (
    <BottomPanel
      label={t("result.label")}
      tabs={tabs.map((x) => ({ value: x.id, label: tx(x.label), icon: x.icon }))}
      value={active.id}
      onValueChange={(value) => {
        actions.updateTab(tab.id, { resultTab: value });
        if (!panelOpen) store.set({ panelOpen: true });
      }}
      collapsed={!panelOpen}
      summary={summary}
      trailing={
        <>
          <IconButton
            icon="download"
            size="sm"
            label={noExport ? t("restrict.noExportShort") : r && !hasTable ? t("result.exportNeedsTable") : t("result.exportCsv")}
            disabled={!hasTable || noExport || !r}
            onClick={() =>
              r &&
              void startRunExport(client, store, actions, r.id, `${descriptor.title.replace(/[\\/:]/g, "-") || "result"}-${r.seq}.csv`, (rows, path) => toast({ tone: "success", title: t("result.exported", { rows, path }) }))
            }
          />
          <IconButton icon="copy" size="sm" label={noExport ? t("restrict.noExportShort") : t("result.copy")} disabled={!canCopy || noExport} onClick={() => toast({ tone: "success", title: t("result.copied") })} />
          <IconButton icon="eraser" size="sm" label={t("result.clear")} disabled={!tab.runId || Boolean(descriptor.runId)} onClick={() => actions.updateTab(tab.id, { runId: null })} />
          <IconButton icon={panelOpen ? "panel-bottom-close" : "panel-bottom-open"} size="sm" label={panelOpen ? t("result.collapse") : t("result.expand")} shortcut={["⌘", "J"]} onClick={() => store.set({ panelOpen: !panelOpen })} />
        </>
      }
    >
      {active.type === "output" && <OutputTab tab={tab} run={run.loading && r === undefined ? undefined : (r ?? null)} widthKey={`result:${descriptor.resourceId ?? tab.target}`} />}
      {active.type === "history" && (descriptor.resourceId ? <HistoryTab resourceId={descriptor.resourceId} /> : <EmptyState layout="inline" message={t("result.historyUnsaved")} />)}
      {active.type === "view" && <ViewTab runId={runId} tabId={active.id} />}
    </BottomPanel>
  );
}
