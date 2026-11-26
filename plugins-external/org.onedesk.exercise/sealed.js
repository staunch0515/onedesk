// Answers kept back (docs/redesign/book.md §21.5): a question's answers and explanation are withheld fields — the
// student's edition of a book does not carry them. When the question can be marked on the spot (in a practice, or in a
// test whose answers come after handing in or after each question), the edition carries fingerprints of the accepted
// writings instead, and their text goes to the student's keychain; the question is then marked by fingerprint, and its
// answer shown (opened) only when the author's timing says so. A question that has neither waits for the teacher to
// release its answers ("awaiting").

import { blankRight, letters, numberOf, plain, truth } from "./judge.js";
import { mark, partsOf } from "./question.js";
import { full } from "./common.js";

const SYMBOLS = { ">": ">", "<": "<", "=": "=", "≥": ">=", "≤": "<=", ">=": ">=", "<=": "<=", "≠": "!=", "!=": "!=" };
const str = (v) => (typeof v === "string" ? v : v === null || v === undefined ? "" : String(v));

/** One writing of blank `i` as both sides compare it: `"<i>|<kind>:<normal form>"`. */
export function writing(q, i, text) {
  const t = plain(text);
  if (!t) return null;
  if (q.type === "single" || q.type === "multi") return `${i}|l:${letters(t)}`;
  if (q.type === "judge") {
    const v = truth(t);
    return v === null ? `${i}|t:${t}` : `${i}|j:${v ? "T" : "F"}`;
  }
  if (q.rule === "number") {
    const n = numberOf(t);
    if (n !== null) return `${i}|n:${Number(n.toPrecision(12))}`;
  }
  if (q.rule === "symbol") return `${i}|s:${SYMBOLS[t] ?? t}`;
  return `${i}|t:${t}`;
}

/** Every accepted writing of a question (what `seal` gives for its answers). */
export function acceptedWritings(q) {
  const out = new Set();
  if (q.type === "free" || q.rule === "teacher") return [];
  if (q.type === "single" || q.type === "multi" || q.type === "judge") {
    const w = writing(q, 0, q.answers[0]);
    return w ? [w] : [];
  }
  for (let i = 0; i < q.blanks; i++)
    for (const alt of str(q.answers[i]).split("|")) {
      const w = writing(q, i, alt);
      if (w) out.add(w);
    }
  return [...out];
}

/**
 * `seal` of a question: when it is marked on the spot (in a practice, or in a test not waiting for the teacher), the
 * accepted writings of its answers; its explanation goes along to be opened later. Otherwise nothing at all.
 */
export async function sealQuestion(ctx) {
  const r = ctx.resource || {};
  let parent = null;
  try {
    parent = r.parentId ? await ctx.host.resources.get(r.parentId) : null;
  } catch {
    parent = null;
  }
  const onTheSpot = parent && (parent.kind === full("practice") || (parent.kind === full("test") && timingOf(parent.body) !== "release"));
  if (!onTheSpot) return { checks: {} };
  const q = partsOf(r.body);
  return { checks: { answers: acceptedWritings(q), explanation: [] } };
}

/** A test's answer timing (the teacher releasing them is the default). */
export function timingOf(body) {
  const t = body && body.timing;
  return t === "each" || t === "submit" ? t : "release";
}

/** Whether a question entry has its answers held back (a read-only copy without them). */
export function heldBack(res) {
  return Boolean(res && res.copy && typeof (res.body || {}).answers !== "string");
}

/**
 * Marks one question entry `{ res, q }`: by its answers when it has them; otherwise by fingerprint; with neither,
 * `awaiting` (the teacher has not released the answers).
 */
export async function markEntry(ctx, e, given, partial) {
  if (!heldBack(e.res)) return mark(e.q, given, partial);
  const q = e.q;
  const max = q.points;
  const g = (given || []).map(str);
  if (g.every((x) => !x.trim())) return { state: "empty", score: 0, max };
  if (q.type === "free" || q.rule === "teacher") return { state: "pending", score: 0, max };
  const n = q.type === "fill" ? q.blanks : 1;
  let right = 0;
  for (let i = 0; i < n; i++) {
    const w = writing(q, i, g[i]);
    if (!w) continue;
    let ok;
    try {
      ok = await ctx.host.sealed.check(e.res.id, "answers", w);
    } catch {
      ok = null;
    }
    if (ok === null || ok === undefined) return { state: "awaiting", score: 0, max };
    if (ok) right++;
  }
  if (right === n) return { state: "right", score: max, max };
  if (right === 0) return { state: "wrong", score: 0, max };
  return { state: "partial", score: Math.round((max * right * 100) / n) / 100, max };
}

/** The entry with its answers and explanation opened from the keychain (when the timing shows them). */
export async function openEntry(ctx, e) {
  if (!heldBack(e.res)) return e;
  const open = async (field) => {
    try {
      const v = await ctx.host.sealed.open(e.res.id, field);
      return typeof v === "string" ? v : null;
    } catch {
      return null;
    }
  };
  const answers = await open("answers");
  if (answers === null) return e;
  const explanation = await open("explanation");
  return { ...e, q: partsOf({ ...e.res.body, answers, explanation: explanation ?? "" }), opened: true };
}

/** `openEntry` for every question in `qs` (a Map), in place. */
export async function openAll(ctx, qs) {
  for (const [id, e] of qs) qs.set(id, await openEntry(ctx, e));
  return qs;
}

/** Whether `blankRight` would accept — kept for the same judging both ways (tests). */
export function sameJudging(q, i, accepted, given) {
  const ws = new Set(str(accepted).split("|").map((a) => writing(q, i, a)));
  return blankRight(q.rule, accepted, given) === ws.has(writing(q, i, given));
}
