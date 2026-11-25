// The practice page (练习页, docs/redesign/book.md §19.6): answered right where it is read — in the book — and marked
// at once; done again as often as wanted. Each check is kept in one attempt, until “again” starts a new one.

import { mark } from "./question.js";
import { attemptsOf, bookAbove, ensureLedgers, full, givenOf, itemsOf, markAll, questionsOf, say, startAttempt, str } from "./common.js";
import { questionNodes } from "./answering.js";

const fieldName = (qid, i) => `q.${qid}.${i}`;

/** The attempt being worked on (the newest still open), or null. */
async function current(ctx, practiceId) {
  const list = await attemptsOf(ctx, practiceId);
  return list.find((a) => a.body.status === "doing") || null;
}

/** What a practice shows to answer: its questions, the answers so far, the marks of the last check. */
export async function practiceView(ctx, practice) {
  const items = await itemsOf(ctx, practice);
  const qs = await questionsOf(ctx, items);
  const a = await current(ctx, practice.id);
  const values = {};
  if (a) for (const [qid, e] of qs) givenOf(a.body, qid, e.q.blanks).forEach((v, i) => (values[fieldName(qid, i)] = v));
  const { view, count } = questionNodes(ctx, items, qs, { name: fieldName, marks: a ? a.body.results : null, reveal: true });
  if (count === 0) return { view: [{ type: "text", id: "empty", text: say(ctx, "practice.empty"), tone: "muted" }], values: {} };
  return { view, values };
}

const ACTIONS = (ctx) => [
  { id: "check", label: ctx.t("action.check"), icon: "check" },
  { id: "again", label: ctx.t("action.again"), icon: "rotate-ccw" },
];

export async function embedPractice(ctx) {
  const v = await practiceView(ctx, ctx.resource);
  return { view: v.view, values: v.values, actions: ACTIONS(ctx) };
}

/** Checks the answers given (`values`): kept in the open attempt (made now when there is none), marked at once. */
export async function checkPractice(ctx, practice, values) {
  const items = await itemsOf(ctx, practice);
  const qs = await questionsOf(ctx, items);
  let a = await current(ctx, practice.id);
  if (!a) {
    const book = await bookAbove(ctx, practice.id);
    a = await startAttempt(ctx, { source: practice.id, sourceKind: "practice", name: practice.name, book, items, limit: 0 });
  }
  const changes = {};
  const body = Object.assign({}, a.body);
  for (const [qid, e] of qs)
    for (let i = 0; i < e.q.blanks; i++) {
      const v = str(values && values[fieldName(qid, i)]);
      changes[`body.a.${qid}.${i}`] = v;
      body[`a.${qid}.${i}`] = v;
    }
  const m = markAll(mark, qs, items, body, false);
  changes["body.results"] = m.results;
  changes["body.score"] = m.score;
  changes["body.total"] = m.total;
  changes["body.items"] = items;
  changes["body.snapshot"] = snapshotOf(qs);
  await ctx.host.resources.update(a.id, changes);
  await ensureLedgers(ctx);
  const right = Object.values(m.results).filter((r) => r.state === "right").length;
  return { right, of: Object.keys(m.results).length };
}

/** Closes the open attempt: the next check starts a new one. */
export async function againPractice(ctx, practice) {
  const a = await current(ctx, practice.id);
  if (a) await ctx.host.resources.update(a.id, { "body.status": "submitted", "body.submitted": Date.now() });
}

export async function actPractice(ctx, ask) {
  const practice = ctx.resource;
  if (ask.action === "check") {
    const r = await checkPractice(ctx, practice, ask.values || {});
    const v = await practiceView(ctx, practice);
    return { view: v.view, values: v.values, actions: ACTIONS(ctx), message: say(ctx, "practice.checked", r) };
  }
  if (ask.action === "again") {
    await againPractice(ctx, practice);
    const v = await practiceView(ctx, practice);
    return { view: v.view, values: {}, actions: ACTIONS(ctx) };
  }
  return { message: ctx.t("action.check") };
}

/** What the questions were when answered (kept in the attempt). */
export function snapshotOf(qs) {
  const out = {};
  for (const [qid, e] of qs) out[qid] = { name: e.res.name, stem: e.q.stem, answers: e.q.answers.join("\n"), type: e.q.type, options: e.q.options.map((o) => `${o.letter}. ${o.text}`).join("\n"), explanation: e.q.explanation, points: e.q.points, rule: e.q.rule, tags: e.res.tags || [] };
  return out;
}

export const PRACTICE = full("practice");
