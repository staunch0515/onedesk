/**
 * Renders a validated view tree (D02: form / table / text / link) with design-system components only.
 * Plugins never touch the DOM; links open through the platform (http/https/mailto only, D65).
 */
import { Badge, Button, EmptyState, Markdown, Section, Stack, Table, Text, type TableColumn } from "../design";
import type { FormNode, LinkNode, TableNode, ViewNode } from "../plugin-api";
import { t } from "./i18n";

type Cell = string | number | boolean | null;
type TextTone = "default" | "muted" | "success" | "warning" | "danger";

export interface ViewTreeProps {
  nodes: ViewNode[];
  onOpenLink: (href: string) => void;
}

/** Longest run of backticks + 1, so any text fits in a fenced code block. */
function fence(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  return "`".repeat(longest + 1);
}

export function codeMarkdown(text: string): string {
  const f = fence(text);
  return `${f}\n${text}\n${f}`;
}

/** Plain text keeps its line breaks: one paragraph per line (empty lines keep their height). */
export function PlainText({ text, tone = "default", mono }: { text: string; tone?: TextTone; mono?: boolean }) {
  const lines = text.split("\n");
  return (
    <div>
      {lines.map((line, i) => (
        <Text as="p" key={i} tone={tone} mono={mono}>
          {line === "" ? " " : line}
        </Text>
      ))}
    </div>
  );
}

function cellText(v: Cell): string {
  if (v === null) return t("common.empty");
  if (typeof v === "boolean") return v ? t("common.yes") : t("common.no");
  return String(v);
}

function FormValue({ field }: { field: FormNode["fields"][number] }) {
  const v = field.value;
  if (v === null || v === "") return <Text tone="subtle">{t("common.empty")}</Text>;
  if (typeof v === "boolean") return <Badge tone={v ? "success" : "neutral"}>{cellText(v)}</Badge>;
  switch (field.format) {
    case "badge":
      return <Badge>{String(v)}</Badge>;
    case "code":
    case "url":
      return <PlainText text={String(v)} mono />;
    default:
      return <PlainText text={String(v)} />;
  }
}

function FormView({ node }: { node: FormNode }) {
  return (
    <Section title={node.title}>
      <Stack gap="md">
        {node.fields.map((field, i) => (
          <Stack gap="xs" key={`${field.label}-${i}`}>
            <Text size="sm" tone="muted">
              {field.label}
            </Text>
            <FormValue field={field} />
          </Stack>
        ))}
      </Stack>
    </Section>
  );
}

type Row = { __key: string } & Record<string, Cell>;

function TableView({ node }: { node: TableNode }) {
  const rows: Row[] = node.rows.map((r, i) => ({ ...r, __key: String(i) }));
  const columns: Array<TableColumn<Row>> = node.columns.map((c) => ({
    key: c.key,
    header: c.label,
    numeric: c.numeric,
    align: c.align,
    render: (row) => cellText(row[c.key] ?? null),
  }));
  return (
    <Section title={node.title} variant={node.title ? "card" : "plain"}>
      <Table
        columns={columns}
        rows={rows}
        getRowKey={(r) => r.__key}
        label={node.title}
        empty={<EmptyState layout="inline" message={node.emptyText ?? t("resource.viewEmpty")} />}
      />
    </Section>
  );
}

function TextView({ node, onOpenLink }: { node: Extract<ViewNode, { type: "text" }>; onOpenLink: (href: string) => void }) {
  const tone = node.tone ?? "default";
  let body;
  if (node.format === "markdown") body = <Markdown onLinkClick={onOpenLink}>{node.text}</Markdown>;
  else if (node.format === "code") body = <Markdown>{codeMarkdown(node.text)}</Markdown>;
  else body = <PlainText text={node.text} tone={tone} />;
  if (!node.title) return body;
  return <Section title={node.title}>{body}</Section>;
}

function LinkView({ node, onOpenLink }: { node: LinkNode; onOpenLink: (href: string) => void }) {
  return (
    <div>
      <Button variant="secondary" icon="external-link" onClick={() => onOpenLink(node.href)} title={node.href}>
        {node.text ?? node.href}
      </Button>
    </div>
  );
}

export function ViewTree({ nodes, onOpenLink }: ViewTreeProps) {
  if (nodes.length === 0) return <EmptyState layout="inline" message={t("resource.viewEmpty")} />;
  return (
    <Stack gap="lg">
      {nodes.map((node, i) => {
        switch (node.type) {
          case "form":
            return <FormView key={i} node={node} />;
          case "table":
            return <TableView key={i} node={node} />;
          case "text":
            return <TextView key={i} node={node} onOpenLink={onOpenLink} />;
          case "link":
            return <LinkView key={i} node={node} onOpenLink={onOpenLink} />;
          default:
            return null;
        }
      })}
    </Stack>
  );
}
