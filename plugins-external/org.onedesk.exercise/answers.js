// The answers appendix (习题答案, docs/redesign/book.md §21.6): at the back of a textbook, lettered like an appendix,
// only in the teacher's edition (its role says `edition: "teacher"`). It lists the answers and explanations of every
// practice and test in the book, in the book's order; the teacher ticks the tests whose answers are released and
// “Release” asks the book's colophon for a student's printing that carries them.

import { bookAbove, full, givenOf, itemsOf, questionsOf, say, str } from "./common.js";
import { answerShown } from "./question.js";
import { markEntry, timingOf } from "./sealed.js";
import { snapshotOf } from "./practice.js";

export const ANSWERS = full("answers");
const COLOPHON = "org.onedesk.book:colophon";
const PRINT = "org.onedesk.book:print";

/** The practices and tests of the book, in tree order: `{ id, kind, name, timing }`. */
async function sourcesOf(ctx, book) {
  const out = [];
  let offset = 0;
  for (;;) {
    const r = await ctx.host.resources.tree(book.id, { offset, limit: 2000 });
    for (const n of r.nodes) if (n.kind === full("practice") || n.kind === full("test")) out.push(n);
    if (r.next === null || r.next === undefined || out.length > 2000) break;
    offset = r.next;
  }
  return out;
}

/** One line per question: “1. 8　2. （问答）参考：…”. */
function answersLine(ctx, items, qs) {
  const parts = [];
  let n = 0;
  for (const it of items) {
    const e = it.q && qs.get(it.q);
    if (!e) continue;
    n += 1;
    const q = e.q;
    const a = q.type === "free" ? say(ctx, "answers.free", { answer: q.answers.join(" ").trim() || "—" }) : answerShown(q) || "—";
    // `1\.`: a number, not a Markdown list.
    parts.push(`${n}\\. ${a}${q.explanation.trim() ? `（${say(ctx, "answers.why", { text: q.explanation.trim() })}）` : ""}`);
  }
  return parts.join("　") || say(ctx, "answers.none");
}

function released(body) {
  return str(body && body.release)
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

async function listNodes(ctx, book, body) {
  const view = [];
  const on = new Set(released(body));
  for (const s of await sourcesOf(ctx, book)) {
    const res = await ctx.host.resources.get(s.id);
    if (!res) continue;
    const items = await itemsOf(ctx, res);
    const qs = await questionsOf(ctx, items);
    const mark = s.kind === full("test") ? (on.has(s.id) ? say(ctx, "answers.isReleased") : timingOf(res.body) === "release" ? say(ctx, "answers.notReleased") : "") : "";
    view.push({ type: "text", id: `a-${s.id}`, text: `**${res.name}**${mark ? `　${mark}` : ""}\n\n${answersLine(ctx, items, qs)}`, format: "markdown" });
  }
  if (view.length === 0) view.push({ type: "text", id: "empty", text: say(ctx, "answers.empty"), tone: "muted" });
  return view;
}

export async function renderAnswers(ctx) {
  const a = ctx.resource;
  if (!a || !a.id) return { view: [{ type: "text", id: "new", text: say(ctx, "answers.alone"), tone: "muted" }] };
  const book = await bookAbove(ctx, a.id);
  if (!book) return { view: [{ type: "text", id: "alone", text: say(ctx, "answers.alone"), tone: "muted" }] };
  const tests = (await sourcesOf(ctx, book)).filter((s) => s.kind === full("test"));
  const view = [{ type: "text", id: "about", text: say(ctx, "answers.about"), tone: "muted" }];
  if (tests.length > 0)
    view.push({
      type: "form",
      id: "release",
      layout: "stack",
      fields: [{ name: "release", label: ctx.t("field.release"), kind: "multi", bind: "body.release", options: tests.map((t) => ({ value: t.id, label: t.name })), hint: ctx.t("field.release.hint") }],
    });
  view.push(...(await listNodes(ctx, book, a.body)));
  return { view };
}

export async function embedAnswers(ctx) {
  const book = await bookAbove(ctx, ctx.resource.id);
  if (!book) return { view: [] };
  return { view: await listNodes(ctx, book, ctx.resource.body) };
}

function failed(ctx, key) {
  const text = say(ctx, key);
  return { output: { type: "text", text }, failed: { message: text } };
}

/** “Release”: the student's printing of the current edition with the ticked tests' answers in it. */
export async function releaseAction(ctx) {
  const a = ctx.resource;
  const book = await bookAbove(ctx, a.id);
  if (!book) return failed(ctx, "answers.alone");
  const ids = released(a.body);
  if (ids.length === 0) return failed(ctx, "answers.pickFirst");
  const reveal = {};
  const names = [];
  for (const id of ids) {
    const t = await ctx.host.resources.get(id);
    if (!t || t.kind !== full("test")) continue;
    names.push(t.name);
    for (const it of await itemsOf(ctx, t)) if (it.q) reveal[it.q] = ["answers", "explanation"];
  }
  if (names.length === 0) return failed(ctx, "answers.pickFirst");
  const kids = await ctx.host.resources.tree(book.id, { limit: 200 });
  const colophon = kids.nodes.find((n) => n.depth === 1 && n.kind === COLOPHON);
  if (!colophon) return failed(ctx, "answers.noColophon");
  const r = await ctx.host.actions.call(PRINT, { reveal, note: names.join(say(ctx, "answers.sep")) }, { resource: colophon.id });
  if (!r || r.failed || !r.data) return failed(ctx, "answers.notPublished");
  const text = say(ctx, "answers.released", { names: names.join(say(ctx, "answers.sep")), edition: r.data.edition, printing: r.data.printing, path: (r.data.paths || [])[0] || "" });
  return { output: { type: "text", text } };
}

/**
 * When a question changes (a new printing came in with its answers): attempts handed in that wait for them are
 * marked now — the results, the score, and what the question was.
 */
export async function remarkAwaiting(ctx, event) {
  if (!event || event.kind !== full("question") || !["updated", "upserted"].includes(event.change)) return;
  const attempts = (await ctx.host.resources.list({ kind: "attempt" })).filter((a) => a.body && a.body.status === "submitted" && a.body.results && a.body.results[event.id] && a.body.results[event.id].state === "awaiting");
  if (attempts.length === 0) return;
  const qs = await questionsOf(ctx, [{ q: event.id }]);
  const e = qs.get(event.id);
  if (!e) return;
  for (const a of attempts) {
    const b = a.body;
    const r = await markEntry(ctx, e, givenOf(b, event.id, e.q.blanks), Boolean(b.settings && b.settings.partial));
    if (r.state === "awaiting") continue;
    const results = { ...b.results, [event.id]: r };
    const score = Math.round(Object.values(results).reduce((x, y) => x + (Number(y.score) || 0), 0) * 100) / 100;
    const snapshot = { ...(b.snapshot || {}), ...snapshotOf(qs) };
    await ctx.host.resources.update(a.id, { "body.results": results, "body.score": score, "body.snapshot": snapshot });
  }
}
