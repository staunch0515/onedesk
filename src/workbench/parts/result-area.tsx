import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, Banner, BottomPanel, Button, DataGrid, EmptyState, ErrorState, IconButton, LoadingState, Pane, Progress, TerminalText, Text, TextBlock, useToast, type DataGridColumn, type TerminalLine, type Tone } from "../../design";
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

const PAGE_ROWS = 1000;
/** A bigger result is not copied to the clipboard (export is for that). */
export const COPY_ROWS_LIMIT = 10_000;

/**
 * A `paged` table (D414) carries only its first rows; the rest is read from the kernel a page at a time, as the grid scrolls
 * near the end of what is loaded (`more`), so a big result never arrives at once. Pages already read stay in `rows`.
 * `rows` is null when the output is whole.
 */
export function usePagedRows(run: Run): { rows: OutputCell[][] | null; more: () => void } {
  const { client, actions } = useWorkbench();
  const out = run.output;
  const paged = out?.type === "table" && out.paged === true;
  const first = out?.type === "table" ? (out.rows as OutputCell[][]) : [];
  const total = out?.type === "table" ? out.total : 0;
  const [rows, setRows] = useState<OutputCell[][]>(first);
  const state = useRef({ id: run.id, rows: first, busy: false });
  useEffect(() => {
    state.current = { id: run.id, rows: first, busy: false };
    setRows(first);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.id, paged, total]);
  const more = useCallback(() => {
    const cur = state.current;
    if (!paged || !client.run.rows || cur.busy || cur.rows.length >= total) return;
    cur.busy = true;
    client.run.rows(cur.id, cur.rows.length, PAGE_ROWS).then(
      (page) => {
        cur.busy = false;
        if (state.current !== cur || page.rows.length === 0) return;
        cur.rows = cur.rows.concat(page.rows as OutputCell[][]);
        setRows(cur.rows);
      },
      (e) => {
        cur.busy = false;
        if (state.current === cur) actions.fail(e);
      },
    );
  }, [client, actions, paged, total]);
  return { rows: paged ? rows : null, more };
}

function OutputTable({ run, widthKey }: { run: Run; widthKey: string }) {
  const { t } = useI18n();
  const grid = useGridWidths(widthKey);
  const paged = usePagedRows(run);
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
      rows={paged.rows ?? (out.rows as OutputCell[][])}
      onNeedMore={paged.rows ? paged.more : undefined}
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

/**
 * Like `useLiveLog`, but keeps which stream each line came from (X17). A progress update may carry `stream`
 * ("stdout" | "stderr") next to its message, or `output`: the lines so far, which then replaces the collected list.
 */
export function useLiveLines(run: Run | null | undefined): TerminalLine[] {
  const [log, setLog] = useState<{ id: string; lines: TerminalLine[] }>({ id: "", lines: [] });
  const last = useRef<unknown>(undefined);
  const running = run?.status === "running" ? run : null;
  const progress = running?.progress as { message?: string; stream?: "stdout" | "stderr"; output?: Array<{ text: string; stream?: "stdout" | "stderr" }> } | undefined;
  const id = running?.id;
  useEffect(() => {
    if (!id || !progress) return;
    const token = progress.output ?? `${progress.stream ?? ""}|${progress.message ?? ""}`;
    if (token === last.current) return;
    last.current = token;
    if (progress.output) {
      const lines = progress.output.map((l) => ({ text: l.text.replace(/\n$/, ""), stream: l.stream })).slice(-LIVE_LOG_LINES);
      setLog({ id, lines });
    } else if (progress.message !== undefined) {
      const line = { text: progress.message.replace(/\n$/, ""), stream: progress.stream };
      setLog((prev) => ({ id, lines: [...(prev.id === id ? prev.lines : []), line].slice(-LIVE_LOG_LINES) }));
    }
  }, [id, progress]);
  return id && log.id === id ? log.lines : [];
}

/** Streamed chunks usually end with their own line break (whole lines); only add one where it is missing. */
export function liveText(chunks: string[]): string {
  return chunks.map((c) => (c.endsWith("\n") ? c : `${c}\n`)).join("").replace(/\n$/, "");
}

/** Milliseconds since `since`, refreshed while `active` (the running-run timer, D5). */
export function useElapsed(since: number | undefined, active: boolean): number | undefined {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(timer);
  }, [active]);
  return since === undefined ? undefined : Math.max(0, now - since);
}

/** The result as tab-separated text (header first): what "copy" puts on the clipboard. */
export function resultText(run: Run, all?: OutputCell[][]): string | null {
  const out = run.output;
  if (out?.type === "text") return out.text;
  if (out?.type !== "table") return null;
  const cell = (v: OutputCell) => (v === null ? "" : String(v).replace(/[\t\r\n]+/g, " "));
  return [out.columns.map((c) => c.label).join("\t"), ...(all ?? (out.rows as OutputCell[][])).map((r) => r.map(cell).join("\t"))].join("\n");
}

function OutputTab({ tab, run, widthKey }: { tab: TabState; run: Run | null | undefined; widthKey: string }) {
  const { client, actions } = useWorkbench();
  const { t, runError, duration } = useI18n();
  const live = useLiveLines(run);
  const elapsed = useElapsed(run?.startedAt, run?.status === "running");
  if (run === undefined) return <LoadingState layout="inline" label={t("common.loading")} />;
  if (run === null) return <EmptyState layout="inline" icon="play" message={tab.target.startsWith("run:") ? t("result.gone") : t("result.empty")} />;
  if (run.status === "running") {
    return (
      <Pane grow align="center" justify="center" gap="sm" pad="lg">
        <Progress value={typeof run.progress?.fraction === "number" ? run.progress.fraction * 100 : undefined} label={t("result.running")} />
        {elapsed !== undefined && (
          <Text size="sm" tone="muted" tabular aria-label={t("result.elapsed")}>
            {duration(Math.floor(elapsed / 100) * 100)}
          </Text>
        )}
        {live.length > 1 ? (
          <Pane grow scroll width="form">
            <TerminalText label={t("result.liveOutput")} lines={live} showStreams={live.some((l) => l.stream)} streamLabels={{ stdout: t("stream.stdout"), stderr: t("stream.stderr") }} />
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
  if (run.output?.type === "link") {
    // A link to another page; `params` (D423) are that page's starting state, held in memory only (D419), like `Open.params`.
    const link = run.output;
    return (
      <Pane grow pad="md" gap="sm" align="start">
        <Button icon="external-link" onClick={() => actions.open(link.target, { params: link.params })}>
          {link.label}
        </Button>
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
  // A run the kernel cannot draw (for example one of an unsaved page) answers with an error: say so instead of loading for ever.
  if (nodes.error && !nodes.data) return <ErrorState layout="inline" title={t("result.viewFailed")} reason={nodes.error} onRetry={nodes.reload} retryLabel={t("common.retry")} />;
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
  const { t, tx, number, duration, time, runError, plural } = useI18n();
  const { toast } = useToast();
  const panelOpen = useUi((s) => s.panelOpen);
  const runId = descriptor.runId ?? tab.runId ?? null;
  const run = useQuery((c) => (runId ? c.run.get(runId) : Promise.resolve(null)), [runId], runId ? [`run:${runId}`] : []);
  const r = run.data;
  const elapsed = useElapsed(r?.startedAt, r?.status === "running");
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
      {r.status === "running" && elapsed !== undefined && <span>{duration(Math.floor(elapsed / 100) * 100)}</span>}
      {r.status === "error" && <span>{r.error ? runError(r.error) : null}</span>}
      {r.summary?.rows !== undefined && <span>{plural("result.rows", r.summary.rows, { count: number(r.summary.rows) })}</span>}
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
          <IconButton icon="copy" size="sm" label={noExport ? t("restrict.noExportShort") : t("result.copy")} disabled={!canCopy || noExport} onClick={() => {
            if (!r) return;
            // A paged table holds only its first rows here: the whole result is read page by page for the clipboard.
            const out = r.output;
            const paged = out?.type === "table" && out.paged === true;
            if (paged && out?.type === "table" && out.total > COPY_ROWS_LIMIT) {
              toast({ tone: "neutral", title: t("result.copyTooMany", { count: number(out.total), limit: number(COPY_ROWS_LIMIT) }) });
              return;
            }
            const gather = async (): Promise<OutputCell[][] | undefined> => {
              if (!paged || out?.type !== "table" || !client.run.rows) return undefined;
              let all = out.rows as OutputCell[][];
              const total = out.total;
              while (all.length < total) {
                const page = await client.run.rows!(r.id, all.length, PAGE_ROWS);
                if (page.rows.length === 0) break;
                all = all.concat(page.rows as OutputCell[][]);
              }
              return all;
            };
            void gather()
              .then((all) => {
                const text = resultText(r, all);
                return text === null ? undefined : navigator.clipboard.writeText(text).then(() => toast({ tone: "success", title: t("result.copied") }));
              })
              .catch(actions.fail);
          }} />
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
