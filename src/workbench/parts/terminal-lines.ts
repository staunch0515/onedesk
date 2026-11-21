import type { TerminalLine, TerminalTone } from "../../design";

/** The tone names the kernel allows (round 17 `LineTone`); anything else (e.g. "stdout") is the default. */
const TONES: readonly string[] = ["default", "muted", "success", "warning", "danger", "stderr"];
const toTone = (v: unknown): TerminalTone => (typeof v === "string" && TONES.includes(v) ? (v as TerminalTone) : "default");

/** Text split at line breaks, one tone per line (`lineTones[i]`; null or missing = default). */
export function textLines(text: string, lineTones?: Array<string | null> | null): TerminalLine[] {
  return text.split("\n").map((line, i) => ({ text: line, tone: toTone(lineTones?.[i]) }));
}

export interface TableLike {
  columns: Array<{ key: string }>;
  rows: unknown[][];
  toneColumn?: string | null;
  lineColumn?: string | null;
}

/** A table drawn as terminal lines: `lineColumn` (default: the last column) is the text, `toneColumn` the tone name. */
export function tableLines(t: TableLike): TerminalLine[] {
  const keys = t.columns.map((c) => c.key);
  const lineIdx = t.lineColumn && keys.includes(t.lineColumn) ? keys.indexOf(t.lineColumn) : keys.length - 1;
  const toneIdx = t.toneColumn ? keys.indexOf(t.toneColumn) : -1;
  return t.rows.map((row) => ({ text: String(row[lineIdx] ?? ""), tone: toneIdx >= 0 ? toTone(row[toneIdx]) : "default" }));
}

/** Terminal lines of a (partial or final) run output that asks for the terminal look; null otherwise. */
export function terminalLinesOf(out: unknown): TerminalLine[] | null {
  const o = out as { type?: string; text?: string; lineTones?: Array<string | null>; appearance?: string } & Partial<TableLike> | null | undefined;
  if (!o || o.appearance !== "terminal") return null;
  if (o.type === "text" && typeof o.text === "string") return textLines(o.text, o.lineTones);
  if (o.type === "table" && o.columns && o.rows) return tableLines(o as TableLike);
  return null;
}
