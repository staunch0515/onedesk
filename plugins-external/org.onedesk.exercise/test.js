// The test page (测验页, docs/redesign/book.md §19.5, §19.7): in a book, a card — how many questions, the last and best
// score, “Start”; answered on an attempt page of its own, handed in, marked. On its own page: what the author edits.

import { attemptsOf, bookAbove, full, itemsOf, questionsOf, say, startAttempt, str } from "./common.js";
import { timingOf } from "./sealed.js";
import { authorNodes, generate, quickText } from "./authoring.js";

export const TEST = full("test");

/** The settings of a test, made safe. */
export function settingsOf(body) {
  const b = body || {};
  return {
    timing: timingOf(b),
    tries: Number(b.tries) > 0 ? Math.floor(Number(b.tries)) : 0,
    keep: b.keep === "last" ? "last" : "best",
    limit: Number(b.limit) > 0 ? Number(b.limit) : 0,
    editable: b.editable !== false,
    partial: b.partial === true,
  };
}

/** Its handed-in attempts, the score that counts, and whether another may be started. */
export async function standing(ctx, test) {
  const s = settingsOf(test.body);
  const all = await attemptsOf(ctx, test.id);
  const done = all.filter((a) => a.body.status === "submitted");
  const last = done[0] || null;
  const best = done.reduce((m, a) => (m === null || Number(a.body.score) > Number(m.body.score) ? a : m), null);
  const counts = s.keep === "last" ? last : best;
  const open = all.find((a) => a.body.status === "doing") || null;
  const used = all.length;
  return { s, done, last, best, counts, open, canStart: s.tries === 0 || used < s.tries, used };
}

export async function embedTest(ctx) {
  const test = ctx.resource;
  const items = await itemsOf(ctx, test);
  const qs = await questionsOf(ctx, items);
  let total = 0;
  for (const e of qs.values()) total += e.q.points;
  const st = await standing(ctx, test);
  const lines = [say(ctx, "test.card", { n: qs.size, total }) + (st.s.limit ? `　${say(ctx, "test.limit", { m: st.s.limit })}` : "")];
  if (st.last) lines.push(say(ctx, "test.last", { score: st.last.body.score, n: st.last.body.number }) + (st.best ? `　${say(ctx, "test.best", { score: st.best.body.score })}` : ""));
  else lines.push(say(ctx, "test.notYet"));
  if (!st.canStart) lines.push(say(ctx, "test.noMore", { n: st.s.tries }));
  const actions = [];
  if (st.open) actions.push({ id: "continue", label: ctx.t("action.continue"), icon: "play" });
  else if (st.canStart) actions.push({ id: "start", label: ctx.t("action.start"), icon: "play" });
  if (st.last) actions.push({ id: "last", label: ctx.t("action.lastAttempt"), icon: "history" });
  return { view: [{ type: "text", id: "card", text: lines.join("\n\n"), format: "markdown" }], actions };
}

/** Starts an attempt (or goes back to the open one) and opens it. */
export async function startTest(ctx, test) {
  const st = await standing(ctx, test);
  if (st.open) {
    await ctx.host.ui.open(`resource:${st.open.id}`);
    return null;
  }
  if (!st.canStart) return say(ctx, "test.noMore", { n: st.s.tries });
  const items = await itemsOf(ctx, test);
  const book = await bookAbove(ctx, test.id);
  const a = await startAttempt(ctx, { source: test.id, sourceKind: "test", name: test.name, book, items, limit: st.s.limit, settings: st.s });
  await ctx.host.ui.open(`resource:${a.id}`);
  return null;
}

export async function actTest(ctx, ask) {
  const test = ctx.resource;
  if (ask.action === "start" || ask.action === "continue") {
    const why = await startTest(ctx, test);
    const card = await embedTest(ctx);
    return why ? { ...card, message: why } : card;
  }
  if (ask.action === "last") {
    const st = await standing(ctx, test);
    if (st.last) await ctx.host.ui.open(`resource:${st.last.id}`);
    return undefined;
  }
  return undefined;
}

const ROW_ACTIONS = (ctx) => [
  { id: "up", label: ctx.t("action.up"), icon: "arrow-up" },
  { id: "down", label: ctx.t("action.down"), icon: "arrow-down" },
  { id: "drop", label: ctx.t("action.removeFromTest"), icon: "x" },
];

/** The author's page: settings in one row, the questions, quick writing. */
export async function renderTest(ctx) {
  const test = ctx.resource;
  const view = [
    {
      type: "form",
      id: "settings",
      layout: "strip",
      fields: [
        { name: "timing", label: ctx.t("field.timing"), kind: "enum", bind: "body.timing", options: ["release", "submit", "each"].map((v) => ({ value: v, label: ctx.t(`timing.${v}`) })) },
        { name: "tries", label: ctx.t("field.tries"), kind: "number", bind: "body.tries", hint: ctx.t("field.tries.hint") },
        { name: "keep", label: ctx.t("field.keep"), kind: "enum", bind: "body.keep", options: ["best", "last"].map((v) => ({ value: v, label: ctx.t(`keep.${v}`) })) },
        { name: "limit", label: ctx.t("field.limit"), kind: "number", bind: "body.limit", hint: ctx.t("field.limit.hint") },
        { name: "editable", label: ctx.t("field.editable"), kind: "boolean", bind: "body.editable" },
        { name: "partial", label: ctx.t("field.partial"), kind: "boolean", bind: "body.partial" },
      ],
    },
  ];
  if (!test || !test.id) return { view };
  const items = await itemsOf(ctx, test);
  const qs = await questionsOf(ctx, items);
  const card = await embedTest(ctx);
  view.push(...card.view);
  view.push(...authorNodes(ctx, items, qs, { rowActions: ROW_ACTIONS(ctx) }));
  // A question from elsewhere joins by reference (it stays where it is: one question can be in several tests).
  view.push({ type: "form", id: "refer", layout: "strip", fields: [{ name: "pick", label: ctx.t("field.pick"), kind: "ref", kinds: ["question"], param: true }] });
  return { view };
}

export async function testEvent(ctx, event) {
  const test = ctx.resource;
  if (event === "start") {
    const why = await startTest(ctx, test);
    return why ? { message: why } : undefined;
  }
  if (event === "generate") {
    const text = quickText(ctx);
    if (!text.trim()) return { message: ctx.t("quick.nothing") };
    const made = await generate(ctx, test.id, text);
    const items = (await itemsOf(ctx, test)).filter((x) => !made.some((m) => m.q && m.q === x.q));
    await ctx.host.resources.update(test.id, { "body.items": [...items, ...made] });
    return { params: { quick: "" }, message: say(ctx, "quick.made", { n: made.filter((m) => m.q).length }) };
  }
  if (event === "refer") {
    const id = str(ctx.params && ctx.params.pick);
    if (!id) return { message: ctx.t("test.pickFirst") };
    const items = await itemsOf(ctx, test);
    if (!items.some((x) => x.q === id)) await ctx.host.resources.update(test.id, { "body.items": [...items, { q: id }] });
    return { params: { pick: "" }, message: say(ctx, "test.added", { n: 1 }) };
  }
  if (event === "up" || event === "down" || event === "drop") {
    const items = await itemsOf(ctx, test);
    const i = Number(ctx.row);
    if (!(i >= 0 && i < items.length)) return undefined;
    if (event === "drop") items.splice(i, 1);
    else {
      const j = event === "up" ? i - 1 : i + 1;
      if (j < 0 || j >= items.length) return undefined;
      [items[i], items[j]] = [items[j], items[i]];
    }
    await ctx.host.resources.update(test.id, { "body.items": items });
    return undefined;
  }
  throw new Error(`unknown event ${event}`);
}

export const testHeading = (text) => ({ h: str(text) });
