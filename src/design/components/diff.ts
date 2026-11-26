/**
 * D487 §29.3 (K17): the difference between two texts, line by line, and within a changed line character by character.
 * The kernel only gives what was and what is; the difference is worked out here.
 */

export type DiffOp = "same" | "added" | "removed" | "changed";

/** A piece of a changed line: kept, or only on one side. */
export interface DiffPart {
  text: string;
  kind: "same" | "added" | "removed";
}

/** One row of the comparison: the line before (absent when added), after (absent when removed). */
export interface DiffLine {
  op: DiffOp;
  before?: string;
  after?: string;
  /** Line numbers (1-based) on each side. */
  beforeNo?: number;
  afterNo?: number;
  /** For a changed line: its pieces on each side. */
  beforeParts?: DiffPart[];
  afterParts?: DiffPart[];
}

/** Above this many cells (lines × lines, characters × characters) the comparison stops looking for what is kept. */
const MAX_CELLS = 4_000_000;
const MAX_CHAR_CELLS = 250_000;

/** The longest common subsequence of `a` and `b`, as pairs of indexes; empty when it would cost too much. */
function common<T>(a: T[], b: T[], max: number): Array<[number, number]> | null {
  // Same start and end are kept without the table.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const n = endA - start;
  const m = endB - start;
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < start; i++) pairs.push([i, i]);
  if (n > 0 && m > 0) {
    if (n * m > max) return null;
    const w = m + 1;
    const t = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        t[i * w + j] = a[start + i] === b[start + j] ? t[(i + 1) * w + j + 1]! + 1 : Math.max(t[(i + 1) * w + j]!, t[i * w + j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[start + i] === b[start + j]) {
        pairs.push([start + i, start + j]);
        i++;
        j++;
      } else if (t[(i + 1) * w + j]! >= t[i * w + j + 1]!) i++;
      else j++;
    }
  }
  for (let k = 0; k < a.length - endA; k++) pairs.push([endA + k, endB + k]);
  return pairs;
}

/** The pieces of two versions of one line. */
export function charDiff(before: string, after: string): { before: DiffPart[]; after: DiffPart[] } {
  const a = Array.from(before);
  const b = Array.from(after);
  const pairs = common(a, b, MAX_CHAR_CELLS);
  if (!pairs) return { before: [{ text: before, kind: "removed" }], after: [{ text: after, kind: "added" }] };
  const out = { before: [] as DiffPart[], after: [] as DiffPart[] };
  const push = (list: DiffPart[], text: string, kind: DiffPart["kind"]) => {
    if (!text) return;
    const last = list[list.length - 1];
    if (last && last.kind === kind) last.text += text;
    else list.push({ text, kind });
  };
  let i = 0;
  let j = 0;
  for (const [pi, pj] of [...pairs, [a.length, b.length] as [number, number]]) {
    push(out.before, a.slice(i, pi).join(""), "removed");
    push(out.after, b.slice(j, pj).join(""), "added");
    if (pi < a.length) {
      push(out.before, a[pi]!, "same");
      push(out.after, b[pj]!, "same");
    }
    i = pi + 1;
    j = pj + 1;
  }
  return out;
}

/**
 * Two texts compared by line: kept, added, removed; a run of removed lines followed by added ones is shown as lines
 * changed (paired one to one), with the changed characters marked.
 */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");
  const pairs = common(a, b, MAX_CELLS) ?? [];
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  const gap = (toI: number, toJ: number) => {
    const removed = a.slice(i, toI);
    const added = b.slice(j, toJ);
    const both = Math.min(removed.length, added.length);
    for (let k = 0; k < both; k++) {
      const parts = charDiff(removed[k]!, added[k]!);
      out.push({ op: "changed", before: removed[k], after: added[k], beforeNo: i + k + 1, afterNo: j + k + 1, beforeParts: parts.before, afterParts: parts.after });
    }
    for (let k = both; k < removed.length; k++) out.push({ op: "removed", before: removed[k], beforeNo: i + k + 1 });
    for (let k = both; k < added.length; k++) out.push({ op: "added", after: added[k], afterNo: j + k + 1 });
  };
  for (const [pi, pj] of pairs) {
    gap(pi, pj);
    out.push({ op: "same", before: a[pi], after: b[pj], beforeNo: pi + 1, afterNo: pj + 1 });
    i = pi + 1;
    j = pj + 1;
  }
  gap(a.length, b.length);
  return out;
}

/** How many lines were added, removed and changed. */
export function diffCounts(lines: DiffLine[]): { added: number; removed: number; changed: number } {
  const c = { added: 0, removed: 0, changed: 0 };
  for (const l of lines) if (l.op !== "same") c[l.op]++;
  return c;
}
