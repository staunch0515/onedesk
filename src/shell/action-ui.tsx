/** Action input dialog and result panel (running / success / error / cancelled). */
import { useEffect, useState } from "react";
import { Banner, Button, Dialog, DialogClose, EmptyState, IconButton, Markdown, Progress, Section, Stack, Table, Text, type TableColumn } from "../design";
import type { ActionResult, FieldDef, Resource } from "../plugin-api";
import { t } from "./i18n";
import { initialValues, validateValues, valuesToInput, type FormValue, type FormValues } from "./schema-form";
import { SchemaFields } from "./schema-fields";
import { codeMarkdown, PlainText } from "./view-tree";

export interface ActionInputRequest {
  key: string;
  label: string;
  fields: FieldDef[];
  resource?: Resource;
}

export function ActionInputDialog({
  request,
  onClose,
  onRun,
}: {
  request: ActionInputRequest | null;
  onClose: () => void;
  onRun: (request: ActionInputRequest, input: Record<string, unknown>) => void;
}) {
  const [values, setValues] = useState<FormValues>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  useEffect(() => {
    if (request) setValues(initialValues(request.fields, {}, true));
    setErrors({});
  }, [request]);
  const submit = () => {
    if (!request) return;
    const next = validateValues(request.fields, values);
    setErrors(next);
    if (Object.keys(next).length) return;
    onRun(request, valuesToInput(request.fields, values));
    onClose();
  };
  return (
    <Dialog
      open={request !== null}
      onOpenChange={(open) => !open && onClose()}
      title={request ? t("action.inputTitle", { label: request.label }) : ""}
      description={t("action.inputDescription")}
      closeLabel={t("common.close")}
      footer={
        <>
          <DialogClose>
            <Button>{t("common.cancel")}</Button>
          </DialogClose>
          <Button variant="primary" icon="play" onClick={submit}>
            {t("action.run")}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        onKeyDown={(e) => {
          if ((e.key === "Enter" && (e.metaKey || e.ctrlKey)) || (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT" && !e.nativeEvent.isComposing)) {
            e.preventDefault();
            submit();
          }
        }}
      >
        <Stack gap="md">
          {request && (
            <SchemaFields fields={request.fields} values={values} errors={errors} onChange={(name: string, v: FormValue) => setValues((s) => ({ ...s, [name]: v }))} />
          )}
        </Stack>
      </form>
    </Dialog>
  );
}

type Row = { __key: string } & Record<string, string | number | boolean | null>;

function cell(v: unknown): string {
  if (v === null || v === undefined) return t("common.empty");
  if (typeof v === "boolean") return v ? t("common.yes") : t("common.no");
  return String(v);
}

function OutputView({ output, onOpenLink }: { output: NonNullable<ActionResult["output"]>; onOpenLink: (href: string) => void }) {
  switch (output.type) {
    case "text":
      if (output.format === "markdown") return <Markdown onLinkClick={onOpenLink}>{output.text}</Markdown>;
      if (output.format === "code") return <Markdown>{codeMarkdown(output.text)}</Markdown>;
      return <PlainText text={output.text} />;
    case "table": {
      const rows: Row[] = output.rows.map((r, i) => ({ ...r, __key: String(i) }));
      const columns: Array<TableColumn<Row>> = output.columns.map((c) => ({
        key: c.key,
        header: c.label,
        numeric: c.numeric,
        align: c.align,
        render: (row) => cell(row[c.key]),
      }));
      return <Table columns={columns} rows={rows} getRowKey={(r) => r.__key} empty={<EmptyState layout="inline" message={t("resource.viewEmpty")} />} />;
    }
    case "link":
      return (
        <div>
          <Button variant="secondary" icon="external-link" onClick={() => onOpenLink(output.href)} title={output.href}>
            {output.text ?? output.href}
          </Button>
        </div>
      );
    case "file":
      return (
        <Stack gap="sm">
          <Text size="sm" tone="muted">
            {t("action.file", { name: output.name })}
          </Text>
          <Markdown>{codeMarkdown(output.content)}</Markdown>
        </Stack>
      );
    default:
      return null;
  }
}

export interface ResultPanelProps {
  label: string;
  /** Running run of this resource, if any. */
  running?: { runId: string } | null;
  result?: ActionResult;
  onCancel: (runId: string) => void;
  onDismiss: () => void;
  onOpenLink: (href: string) => void;
}

export function ActionResultPanel({ label, running, result, onCancel, onDismiss, onOpenLink }: ResultPanelProps) {
  if (running) {
    return (
      <Section
        title={t("action.resultTitle")}
        actions={
          <Button size="sm" icon="square" onClick={() => onCancel(running.runId)}>
            {t("action.cancel")}
          </Button>
        }
      >
        <Stack gap="sm">
          <Text tone="muted" size="sm" as="p">
            {t("action.running", { label })}
          </Text>
          <Progress label={t("action.running", { label })} />
        </Stack>
      </Section>
    );
  }
  if (!result) return null;
  const duration = (
    <Text size="sm" tone="muted" tabular>
      {t("action.duration", { ms: Math.round(result.durationMs) })}
    </Text>
  );
  const dismiss = <IconButton icon="x" size="sm" label={t("action.dismiss")} onClick={onDismiss} />;
  const actions = (
    <Stack direction="row" gap="sm" align="center">
      {duration}
      {dismiss}
    </Stack>
  );

  if (result.status === "error") {
    return (
      <Section title={t("action.resultTitle")} actions={actions}>
        <Banner tone="danger" title={t("action.error", { label })}>
          <Stack gap="xs">
            <Text tone="danger" as="p">
              {result.error?.message ?? t("common.unknownError")}
            </Text>
            {result.error?.hint && (
              <Text tone="danger" as="p" size="sm">
                {t("action.errorHint", { hint: result.error.hint })}
              </Text>
            )}
          </Stack>
        </Banner>
      </Section>
    );
  }
  if (result.status === "cancelled") {
    return (
      <Section title={t("action.resultTitle")} actions={actions}>
        <Banner tone="warning" title={t("action.cancelled", { label })} />
      </Section>
    );
  }
  const output = result.output;
  const message = output?.message ?? (output?.type === "none" || !output ? t("action.noOutput") : undefined);
  return (
    <Section title={t("action.resultTitle")} actions={actions}>
      <Stack gap="md">
        <Banner tone="success" title={t("action.success", { label })}>
          {message}
        </Banner>
        {output && output.type !== "none" && <OutputView output={output} onOpenLink={onOpenLink} />}
      </Stack>
    </Section>
  );
}
