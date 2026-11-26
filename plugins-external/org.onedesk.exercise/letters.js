// Homework by letter (docs/redesign/book.md §35.6, interface `onedesk.letter/1`): a test can be sent for someone to
// answer; done when an attempt of it was handed in; what goes back is that attempt; the sender files what comes back
// among the learning records, in a folder of its own (not mixed into the sender's own grades).

import { attemptsOf, NONE, say, str } from "./common.js";

/** The folder answers by letter go into (made once). */
const RECEIVED = "letters";

async function lastHandedIn(ctx, page) {
  return (await attemptsOf(ctx, page)).find((a) => a.body && a.body.status === "submitted") || null;
}

const scoreText = (ctx, b) => say(ctx, "letter.score", { score: b.score, total: b.total });

export async function letterTasks(ctx) {
  const short = String((ctx.resource && ctx.resource.kind) || "").split(":").pop();
  return { output: NONE, data: { tasks: short === "test" ? [{ task: "answer", label: say(ctx, "letter.task.answer") }] : [] } };
}

export async function letterTodo(ctx) {
  const a = ctx.resource ? await lastHandedIn(ctx, ctx.resource.id) : null;
  return { output: NONE, data: a ? { state: "done", summary: scoreText(ctx, a.body) } : { state: "todo", summary: "" } };
}

/** What goes back: the last attempt handed in (its answers, marks and the questions as they were). */
export async function letterReply(ctx) {
  const a = ctx.resource ? await lastHandedIn(ctx, ctx.resource.id) : null;
  if (!a) return { output: NONE, data: {} };
  const keep = {};
  for (const [k, v] of Object.entries(a.body || {})) if (k.startsWith("a.") || ["items", "results", "score", "total", "snapshot", "submitted", "started", "settings", "sourceName", "overtime"].includes(k)) keep[k] = v;
  return { output: NONE, data: { data: keep, summary: scoreText(ctx, a.body) } };
}

/** An answer came back: filed as an attempt of the sender's own test, under “answers by letter”. */
export async function onLetterReply(ctx, e) {
  if (!e || !e.page || !e.data || typeof e.data !== "object" || e.task !== "answer") return;
  const page = await ctx.host.resources.get(e.page);
  if (!page) return;
  const folders = await ctx.host.resources.list({ kind: "subject" });
  let folder = folders.find((s) => s.body && s.body.book === RECEIVED);
  if (!folder) folder = await ctx.host.resources.create({ kind: "subject", name: say(ctx, "letter.folder"), body: { book: RECEIVED } });
  const who = str(e.from && e.from.name);
  const body = Object.assign({}, e.data, { source: page.id, sourceKind: "test", sourceName: page.name, book: RECEIVED, status: "submitted", number: 1, limit: 0, from: e.from || null });
  await ctx.host.resources.create({ kind: "attempt", parent: folder.id, name: say(ctx, "letter.attemptName", { who, name: page.name }), body });
}
