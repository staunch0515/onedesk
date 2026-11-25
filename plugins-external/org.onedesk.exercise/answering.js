// How questions are shown to answer and after marking — the same in a book (inside an embed) and on a page.

import { answerShown, fieldsOf, stemShown } from "./question.js";
import { say } from "./common.js";

const MARK = { right: "✓", wrong: "✗", partial: "◐", pending: "…", empty: "·" };

/**
 * View nodes for items: a heading, or a question (its stem, its fields named by `name(qid, i)`, and — when `marks`
 * has it — the mark; with `reveal`, the right answer and the explanation too). `lock(qid)` makes a question's fields
 * read-only. Returns `{ view, count }`.
 */
export function questionNodes(ctx, items, qs, { name, marks, reveal, lock, bind }) {
  const view = [];
  let n = 0;
  for (const it of items) {
    if (it.h !== undefined) {
      view.push({ type: "text", id: `h-${view.length}`, text: `### ${it.h}`, format: "markdown" });
      continue;
    }
    const e = qs.get(it.q);
    if (!e) continue;
    n += 1;
    const q = e.q;
    view.push({ type: "text", id: `s-${it.q}`, text: `**${n}.** ${stemShown(q)}`, format: "markdown" });
    // `bind`: the fields write the resource the page shows (an attempt); otherwise they are the embed's or the tab's.
    const fields = fieldsOf(ctx, q, (i) => name(it.q, i), lock ? lock(it.q) : false).map((f) => (bind ? { ...f, bind: f.name } : f));
    view.push({ type: "form", id: `f-${it.q}`, layout: q.type === "free" ? "stack" : "strip", fields });
    const m = marks && marks[it.q];
    if (m) {
      const lines = [`${MARK[m.state] || ""} ${say(ctx, `state.${m.state}`)}${m.state === "pending" || m.state === "empty" ? "" : `　${say(ctx, "score", { score: m.score, max: m.max })}`}`];
      if (reveal && m.state !== "right") lines.push(say(ctx, "answer.is", { answer: answerShown(q) }));
      if (reveal && q.explanation.trim()) lines.push(q.explanation.trim());
      view.push({ type: "text", id: `m-${it.q}`, text: lines.join("\n\n"), format: "markdown", ...(m.state === "wrong" ? { tone: "danger" } : {}) });
    }
  }
  return { view, count: n };
}
