/**
 * Renders a validated view tree (D02: form / table / text / link) with design-system components only.
 * Plugins never touch the DOM; links open through the platform (http/https/mailto only, D65).
 */
import { Badge, EmptyState, KeyValueList, Markdown, Section, Stack, Table, Text, TextBlock, TextLink, type TableColumn } from "../design";
import type { FormNode, LinkNode, TableNode, ViewNode } from "../plugin-api";
import { t } from "./i18n";

type Cell = string | number | boolean | null;

export interface ViewTreeProps {
  nodes: ViewNode[];
  onOpenLink: (href: string) => void;
}

function cellText(v: Cell): string {
  if (v === null) return t("common.empty");
  if (typeof v === "boolean") return v ? t("common.yes") : t("common.no");
  return String(v);
}

export function FormValue({ field }: { field: FormNode["fields"][number] }) {
  const v = field.value;
  if (v === null || v === "") return <Text tone="subtle">{t("common.empty")}</Text>;
  if (typeof v === "boolean") return <Badge tone={v ? "success" : "neutral"}>{cellText(v)}</Badge>;
  switch (field.format) {
    case "badge":
      return <Badge>{String(v)}</Badge>;
    case "code":
      return <TextBlock variant="code">{String(v)}</TextBlock>;
    case "url":
      return <Text mono>{String(v)}</Text>;
    default:
      return <TextBlock>{String(v)}</TextBlock>;
  }
}

function FormView({ node }: { node: FormNode }) {
  return (
    <Section title={node.title}>
      <KeyValueList
        layout="stacked"
        items={node.fields.map((field, i) => ({ key: `${i}`, label: field.label, value: <FormValue field={field} /> }))}
      />
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
  else if (node.format === "code")
    body = (
      <TextBlock variant="code" tone={tone} label={node.title}>
        {node.text}
      </TextBlock>
    );
  else body = <TextBlock tone={tone}>{node.text}</TextBlock>;
  if (!node.title) return body;
  return <Section title={node.title}>{body}</Section>;
}

function LinkView({ node, onOpenLink }: { node: LinkNode; onOpenLink: (href: string) => void }) {
  return (
    <div>
      <TextLink href={node.href} onOpen={onOpenLink} external>
        {node.text ?? node.href}
      </TextLink>
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
