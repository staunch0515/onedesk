import type { TerminalLine, TerminalTone } from "../../design";
import type { LineTone, RunOutput } from "../protocol";

/** The tone names the kernel allows (`LineTone`); anything else (e.g. "stdout" in a tone column) is the default. */
const TONES: readonly LineTone[] = ["default", "muted", "success", "warning", "danger", "stderr"];
const toTone = (v: unknown): TerminalTone => (TONES.includes(v as LineTone) ? (v as LineTone) : "default");

/** Text split at line breaks, one tone per line (`lineTones[i]`; null or missing = default). */
export function textLines(text: string, lineTones?: Array<LineTone | null> | null): TerminalLine[] {
  return text.split("\n").map((line, i) => ({ text: line, tone: toTone(lineTones?.[i]) }));
}

type TableOutput = Extract<RunOutput, { type: "table" }>;

/** A table drawn as terminal lines: `lineColumn` (default: the last column) is the text, `toneColumn` the tone name. */
export function tableLines(t: Pick<TableOutput, "columns" | "rows" | "toneColumn" | "lineColumn">): TerminalLine[] {
  const keys = t.columns.map((c) => c.key);
  const lineIdx = t.lineColumn && keys.includes(t.lineColumn) ? keys.indexOf(t.lineColumn) : keys.length - 1;
  const toneIdx = t.toneColumn ? keys.indexOf(t.toneColumn) : -1;
  return t.rows.map((row) => ({ text: String(row[lineIdx] ?? ""), tone: toneIdx >= 0 ? toTone(row[toneIdx]) : "default" }));
}

/** Terminal lines of a (partial or final) run output that asks for the terminal look; null otherwise. */
export function terminalLinesOf(out: RunOutput | null | undefined): TerminalLine[] | null {
  if (!out || !("appearance" in out) || out.appearance !== "terminal") return null;
  if (out.type === "text" && "text" in out) return textLines(out.text, out.lineTones);
  if (out.type === "table" && "rows" in out) return tableLines(out);
  return null;
}
