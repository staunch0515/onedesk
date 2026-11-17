/**
 * Unsaved content whose saved value changed elsewhere (§9.3, D374). The page is read again when the resource changes; this
 * compares what the page showed before with what it shows now, field by field (bind path), against what the user typed.
 */

export type Values = Record<string, unknown>;

/** What is pending for one tab. */
export interface MergeState {
  /** Fields typed here whose saved value was changed elsewhere to something else: the user must choose. */
  conflicts: string[];
  /** Fields the user chose "keep mine" for: sent as `overwrite` with the next save. */
  keep: string[];
}

export const NO_MERGE: MergeState = { conflicts: [], keep: [] };

export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if ((a === undefined || a === null || a === "") && (b === undefined || b === null || b === "")) return true;
  return JSON.stringify(a) === JSON.stringify(b);
}

export interface MergeResult {
  /** Fields changed elsewhere (saved value before ≠ now), whether or not they are typed here. */
  changed: string[];
  /** Typed here and changed elsewhere to something else. */
  conflicts: string[];
  /** Typed here and changed elsewhere to the very value typed: nothing left to keep. */
  converged: string[];
}

/**
 * `before` / `after`: the page's saved values when the draft was started and now; `draft`: the unsaved fields.
 * A field changed elsewhere and absent from the draft is simply the new display (quiet); one in the draft is a conflict
 * unless it already has the same value.
 */
export function mergeDraft(before: Values, after: Values, draft: Values): MergeResult {
  const changed: string[] = [];
  const conflicts: string[] = [];
  const converged: string[] = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (sameValue(before[key], after[key])) continue;
    changed.push(key);
    if (!(key in draft)) continue;
    (sameValue(draft[key], after[key]) ? converged : conflicts).push(key);
  }
  return { changed, conflicts, converged };
}

/** What `page.save` rejected with (`conflict` / `stale`): the conflicting bind paths, or null for any other error. */
export function staleFields(error: unknown): { fields: string[]; rev?: string } | null {
  if (!error || typeof error !== "object") return null;
  const e = error as { code?: unknown; params?: Record<string, string> };
  if (e.code !== "conflict" || e.params?.reason !== "stale") return null;
  return { fields: (e.params.fields ?? "").split(",").map((f) => f.trim()).filter(Boolean), rev: e.params.rev };
}
