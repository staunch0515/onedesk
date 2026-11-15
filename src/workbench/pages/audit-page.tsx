import { useState } from "react";
import { Badge, DataGrid, EmptyState, FieldStrip, Input, LoadingState, Pane, Select, StripField, Text, useToast, type ActionBarItem, type DataGridColumn, type Tone } from "../../design";
import { useI18n } from "../i18n";
import type { AuditResult, AuditRow, PageDescriptor } from "../protocol";
import { useQuery, useUi, useWorkbench } from "../state/context";
import type { TabState } from "../state/store";
import { Frame } from "../parts/frame";

const ALL = "__all__";
const HOUR = 3_600_000;
const RESULT_TONE: Record<AuditRow["result"], Tone> = { ok: "success", denied: "warning", error: "danger" };

/** Audit log (I.13): table with filters by time, actor, operation, result and text. */
export function AuditPage({ tab, descriptor }: { tab: TabState; descriptor: PageDescriptor }) {
  const { store } = useWorkbench();
  const { t, operation: opName, dateTime, number } = useI18n();
  const { toast } = useToast();
  const [range, setRange] = useState("168");
  const [actor, setActor] = useState(ALL);
  const [operation, setOperation] = useState(ALL);
  const [result, setResult] = useState(ALL);
  const [text, setText] = useState("");
  const facets = useQuery((c) => c.audit.facets(), [], ["audit"]);
  const rows = useQuery(
    (c) => c.audit.list({ sinceMs: range === ALL ? undefined : Number(range) * HOUR, actor: actor === ALL ? undefined : actor, operation: operation === ALL ? undefined : operation, result: result === ALL ? undefined : (result as AuditResult), text: text.trim() || undefined }),
    [range, actor, operation, result, text],
    ["audit"],
  );
  const widths = useUi((s) => s.gridWidths.audit);
  const resultName: Record<AuditRow["result"], string> = { ok: t("audit.ok"), denied: t("audit.denied"), error: t("audit.error") };
  const sourceNames: Record<string, string> = { user: t("audit.sourceUser"), plugin: t("audit.sourcePlugin"), scheduled: t("audit.sourceScheduled"), ai: t("audit.sourceAi"), system: t("audit.sourceSystem") };

  const columns: Array<DataGridColumn<AuditRow>> = [
    { key: "at", header: t("audit.time"), width: 152, value: (a) => a.at, render: (a) => dateTime(a.at) },
    { key: "actor", header: t("audit.actor"), width: 112, value: (a) => a.actor },
    { key: "source", header: t("audit.source"), width: 104, muted: true, value: (a) => (sourceNames[a.source] ?? a.source) },
    { key: "operation", header: t("audit.operation"), width: 184, value: (a) => opName(a.operation) },
    { key: "target", header: t("audit.target"), width: 240, value: (a) => a.target },
    { key: "result", header: t("audit.result"), width: 104, value: (a) => a.result, render: (a) => <Badge tone={RESULT_TONE[a.result]} dot>{resultName[a.result]}</Badge> },
    { key: "detail", header: t("audit.detail"), width: 480, mono: true, value: (a) => a.detail },
  ];

  const items: ActionBarItem[] = [{ key: "export", label: t("audit.export"), icon: "download", onSelect: () => toast({ tone: "success", title: t("audit.exported", { count: rows.data?.length ?? 0 }) }) }];
  const any = { value: ALL, label: t("audit.any") };

  return (
    <Frame tab={tab} descriptor={descriptor} actions={items} meta={rows.data ? <Badge>{t("audit.count", { count: number(rows.data.length) })}</Badge> : undefined}>
      <FieldStrip label={t("audit.filters")}>
        <StripField label={t("audit.time")}>
          <Select
            size="sm"
            aria-label={t("audit.time")}
            value={range}
            onValueChange={setRange}
            options={[
              { value: "24", label: t("audit.last24h") },
              { value: "168", label: t("audit.last7d") },
              { value: "720", label: t("audit.last30d") },
              { value: ALL, label: t("audit.allTime") },
            ]}
          />
        </StripField>
        <StripField label={t("audit.actor")}>
          <Select size="sm" aria-label={t("audit.actor")} value={actor} onValueChange={setActor} options={[any, ...(facets.data?.actors ?? []).map((a) => ({ value: a, label: a }))]} />
        </StripField>
        <StripField label={t("audit.operation")} wide>
          <Select size="sm" aria-label={t("audit.operation")} value={operation} onValueChange={setOperation} options={[any, ...(facets.data?.operations ?? []).map((o) => ({ value: o, label: opName(o) }))]} />
        </StripField>
        <StripField label={t("audit.result")}>
          <Select size="sm" aria-label={t("audit.result")} value={result} onValueChange={setResult} options={[any, { value: "ok", label: resultName.ok }, { value: "denied", label: resultName.denied }, { value: "error", label: resultName.error }]} />
        </StripField>
        <StripField label={t("audit.text")} wide>
          <Input size="sm" icon="search" aria-label={t("audit.text")} placeholder={t("audit.textPlaceholder")} value={text} onChange={(e) => setText(e.target.value)} />
        </StripField>
      </FieldStrip>
      <Pane grow>
        {!rows.data ? (
          <LoadingState layout="inline" label={t("common.loading")} />
        ) : (
          <DataGrid
            label={descriptor.title}
            columns={columns}
            rows={rows.data}
            getRowKey={(a) => a.id}
            nullText=""
            defaultSort={null}
            widths={widths}
            onWidthsChange={(next) => store.set((s) => ({ gridWidths: { ...s.gridWidths, audit: next } }))}
            empty={<EmptyState layout="inline" message={<Text tone="muted">{t("audit.empty")}</Text>} />}
          />
        )}
      </Pane>
    </Frame>
  );
}
