// A question (题, docs/redesign/book.md §19.3): the stem with its blanks `{{?}}`, the options, the answers (one line
// per blank, alternatives `a | b`), the rule, the points. How it is shown for answering and how it is marked.

import { blankRight, letters, truth } from "./judge.js";

export const TYPES = ["fill", "single", "multi", "judge", "free"];
const BLANK = /\{\{\?[^{}\n]{0,40}\}\}/g;

const str = (v) => (typeof v === "string" ? v : v === null || v === undefined ? "" : String(v));

/** The parts of a question body, made safe. */
export function partsOf(body) {
  const b = body || {};
  const type = TYPES.includes(b.type) ? b.type : "fill";
  const stem = str(b.stem);
  const options = str(b.options)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l, i) => {
      const m = /^([A-Za-z])\s*[.．、)）:：]\s*(.*)$/.exec(l);
      return m ? { letter: m[1].toUpperCase(), text: m[2] } : { letter: String.fromCharCode(65 + i), text: l };
    });
  const answers = str(b.answers).split("\n").map((l) => l.trim());
  const blanks = type === "fill" ? Math.max(1, (stem.match(BLANK) || []).length) : 1;
  const rule = ["number", "text", "symbol", "teacher"].includes(b.rule) ? b.rule : type === "free" ? "teacher" : "number";
  const points = Number(b.points) > 0 ? Number(b.points) : 1;
  return { type, stem, options, answers, blanks, rule, points, hint: str(b.hint), explanation: str(b.explanation) };
}

/** The stem as shown: each blank a numbered gap “（1）”. */
export function stemShown(q) {
  let i = 0;
  return q.stem.replace(BLANK, () => `（${++i}）`);
}

/**
 * Marks a question: `given` is one value per blank. `{ state: "right" | "wrong" | "partial" | "pending" | "empty",
 * score, max }`. `partialChoice`: a multiple choice with some right letters (none wrong) gets half.
 */
export function mark(q, given, partialChoice = false) {
  const max = q.points;
  const g = (given || []).map(str);
  if (g.every((x) => !x.trim())) return { state: "empty", score: 0, max };
  if (q.type === "free" || q.rule === "teacher") return { state: "pending", score: 0, max };
  if (q.type === "single" || q.type === "multi") {
    const want = letters(q.answers[0]);
    const got = letters(g[0]);
    if (got === want) return { state: "right", score: max, max };
    const some = got && [...got].every((c) => want.includes(c));
    if (q.type === "multi" && partialChoice && some) return { state: "partial", score: max / 2, max };
    return { state: "wrong", score: 0, max };
  }
  if (q.type === "judge") {
    const ok = truth(g[0]) !== null && truth(g[0]) === truth(q.answers[0]);
    return ok ? { state: "right", score: max, max } : { state: "wrong", score: 0, max };
  }
  let right = 0;
  for (let i = 0; i < q.blanks; i++) if (blankRight(q.rule, q.answers[i], g[i])) right++;
  if (right === q.blanks) return { state: "right", score: max, max };
  if (right === 0) return { state: "wrong", score: 0, max };
  return { state: "partial", score: Math.round((max * right * 100) / q.blanks) / 100, max };
}

/** The correct answer as shown after marking. */
export function answerShown(q) {
  if (q.type === "fill") return q.answers.slice(0, q.blanks).map((a, i) => `（${i + 1}）${a.split("|")[0].trim()}`).join("　");
  return q.answers[0] || "";
}

/** The form fields to answer a question; `name(i)` names blank i. */
export function fieldsOf(ctx, q, name, readOnly) {
  const ro = readOnly ? { readOnly: true } : {};
  if (q.type === "single") return [{ name: name(0), label: ctx.t("field.choice"), kind: "enum", options: q.options.map((o) => ({ value: o.letter, label: `${o.letter}. ${o.text}` })), ...ro }];
  if (q.type === "multi") return [{ name: name(0), label: ctx.t("field.choices"), kind: "multi", options: q.options.map((o) => ({ value: o.letter, label: `${o.letter}. ${o.text}` })), ...ro }];
  if (q.type === "judge") return [{ name: name(0), label: ctx.t("field.judge"), kind: "enum", options: [{ value: "对", label: ctx.t("judge.true") }, { value: "错", label: ctx.t("judge.false") }], ...ro }];
  if (q.type === "free") return [{ name: name(0), label: ctx.t("field.answer"), kind: "longtext", ...ro }];
  return Array.from({ length: q.blanks }, (_, i) => ({ name: name(i), label: `（${i + 1}）`, kind: "text", ...ro }));
}

/**
 * Quick writing (§19.3): one question per line, the answer in brackets — `3 + 5 = (8)`, `7 × (8) = 56`, `38 (<) 83`.
 * A line starting with `#` is a heading (`# 一、口算`). Answers that are numbers are judged by value, signs by symbol.
 */
export function quick(text) {
  const out = [];
  for (const raw of String(text || "").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#")) {
      out.push({ heading: line.replace(/^#+\s*/, "") });
      continue;
    }
    const answers = [];
    const stem = line.replace(/[（(]\s*([^()（）]+?)\s*[)）]/g, (_, a) => {
      answers.push(a);
      return "{{?}}";
    });
    if (answers.length === 0) continue;
    const symbols = answers.every((a) => /^(>|<|=|≥|≤|＞|＜|＝)$/.test(a.trim()));
    out.push({ name: line.slice(0, 60), body: { type: "fill", stem, answers: answers.join("\n"), rule: symbols ? "symbol" : "number", points: 1 } });
  }
  return out;
}

/** A question's first line, short (for lists). */
export function shortStem(q, max = 40) {
  const first = stemShown(q).split("\n").find((l) => l.trim()) || "";
  return first.length > max ? `${first.slice(0, max)}…` : first;
}
