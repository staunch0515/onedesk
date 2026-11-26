// The flow contents (流程目录, docs/redesign/book.md §25.4): a contents whose reading is carrying the procedure out —
// its steps one after another, in the contents' order. Numbers come from the book's own plugin (by book); each item
// shows its step's state in the current run log.

import { full, parentOf, say, str } from "./common.js";
import { carryOn, entriesOfBook, LOG, newLog, stepsOf } from "./engine.js";

export const FLOW = full("flow");
const MARK = { ok: "✓", failed: "✗", skipped: "⏭", waiting: "⏸", confirmed: "✓" };

/** The flow's current log (the one “continue” goes on with), or null. */
export async function currentLog(ctx, flowId) {
  const id = await ctx.host.storage.get(`current:${flowId}`);
  if (typeof id !== "string" || !id) return null;
  try {
    const l = await ctx.host.resources.get(id);
    return l && l.kind === LOG ? l : null;
  } catch {
    return null;
  }
}

/** The flow contents of a book (the page playing its contents, if it is ours). */
export async function flowOfBook(ctx, bookId) {
  const kids = await ctx.host.resources.tree(bookId, { limit: 500 });
  const n = kids.nodes.find((x) => x.depth === 1 && x.kind === FLOW);
  return n ? { id: n.id, name: n.name } : null;
}

function headLine(ctx, log, steps) {
  if (!log) return say(ctx, "flow.notRun");
  const b = log.body;
  const at = steps[b.next];
  const where = b.status === "done" ? say(ctx, "status.done") : b.status === "waiting" ? say(ctx, "status.waitingAt", { step: at ? at.title : "" }) : b.status === "failed" ? say(ctx, "status.failedAt", { step: at ? at.title : "" }) : say(ctx, "status.running");
  return say(ctx, "flow.head", { n: b.number, operator: b.operator || "—", where });
}

async function operatorField(ctx) {
  const f = { name: "operator", label: ctx.t("field.operator"), kind: "text", param: true };
  try {
    const found = await ctx.host.params.get(say(ctx, "env.operator"));
    if (found && found.found) {
      f.envValue = String(found.value);
      f.envSource = found.sourceName;
    }
  } catch {
    // no environment
  }
  return f;
}

export async function renderFlow(ctx) {
  const flow = ctx.resource;
  if (!flow || !flow.id) return { view: [{ type: "text", id: "new", text: say(ctx, "flow.alone"), tone: "muted" }] };
  const book = await parentOf(ctx, flow);
  const all = book ? await stepsOf(ctx, book) : null;
  if (!all) return { view: [{ type: "text", id: "alone", text: say(ctx, "flow.alone"), tone: "muted" }] };
  const log = await currentLog(ctx, flow.id);
  const recs = (log && log.body.steps) || {};
  const byId = new Map(all.steps.map((s) => [s.id, s]));
  const items = all.items.map((it) => {
    if (!it.resource || !byId.has(it.resource)) return it;
    const r = recs[it.resource];
    return { ...it, title: `${r ? MARK[r.state] || "·" : "·"} ${it.title}` };
  });
  const view = [
    { type: "text", id: "head", text: headLine(ctx, log, all.steps), tone: "muted" },
    { type: "form", id: "run", layout: "strip", fields: [await operatorField(ctx)] },
  ];
  if (items.length === 0) view.push({ type: "text", id: "empty", text: say(ctx, "flow.empty"), tone: "muted" });
  else view.push({ type: "sequence", id: "book", items, toc: true, mode: ctx.params && ctx.params["view.mode"] === "pages" ? "pages" : "scroll", positionEvent: "position" });
  return { view };
}

export async function flowEvent(ctx, event) {
  if (event === "position") {
    if (typeof ctx.row === "string" && ctx.row) await ctx.host.storage.set(`pos:${ctx.resource.id}`, ctx.row);
    return undefined;
  }
  if (event === "toggle") {
    const next = ctx.params && ctx.params["view.mode"] === "pages" ? "scroll" : "pages";
    return { params: { "view.mode": next } };
  }
  if (event === "fresh") {
    await ctx.host.storage.set(`current:${ctx.resource.id}`, null);
    return { message: ctx.t("flow.freshDone") };
  }
  throw new Error(`unknown event ${event}`);
}

function outputOf(ctx, log, steps) {
  const b = log.body;
  const at = steps[b.next];
  const key = b.status === "done" ? "run.done" : b.status === "waiting" ? "run.waiting" : "run.failed";
  const text = say(ctx, key, { step: at ? at.title : "", confirm: at ? str(b.steps[at.id] && b.steps[at.id].confirmText) : "" });
  const res = { output: { type: "text", text } };
  if (b.status === "failed") res.failed = { message: text };
  return res;
}

/** Who runs it: typed on the page, else the environment's value (as the field shows it). */
async function operatorOf(ctx) {
  const typed = str(ctx.params && ctx.params.operator).trim();
  if (typed) return typed;
  try {
    const f = await ctx.host.params.get(say(ctx, "env.operator"));
    return f && f.found ? str(f.value).trim() : "";
  } catch {
    return "";
  }
}

/** “Run”: a new log, from the first step. */
export async function runAction(ctx) {
  const flow = ctx.resource;
  const book = await parentOf(ctx, flow);
  const all = book ? await stepsOf(ctx, book) : null;
  if (!all) return { output: { type: "text", text: say(ctx, "flow.alone") }, failed: { message: say(ctx, "flow.alone") } };
  const log = await newLog(ctx, flow, book, await operatorOf(ctx));
  await ctx.host.storage.set(`current:${flow.id}`, log.id);
  const done = await carryOn(ctx, log, all.steps, 0);
  return outputOf(ctx, await withConfirmText(ctx, done, all.steps), all.steps);
}

/** “Continue”: from where the current log stopped (confirming the step that waited; running a failed one again). */
export async function continueAction(ctx) {
  const flow = ctx.resource;
  const book = await parentOf(ctx, flow);
  const all = book ? await stepsOf(ctx, book) : null;
  const log = await currentLog(ctx, flow.id);
  if (!all || !log) return runAction(ctx);
  if (log.body.status === "done") return { output: { type: "text", text: say(ctx, "run.alreadyDone") } };
  let from = Number(log.body.next) || 0;
  if (log.body.status === "waiting" && all.steps[from]) {
    const id = all.steps[from].id;
    const steps = { ...log.body.steps, [id]: { ...log.body.steps[id], state: "confirmed", confirmedBy: (await operatorOf(ctx)) || log.body.operator || "", confirmedAt: Date.now() } };
    await ctx.host.resources.update(log.id, { "body.steps": steps, "body.status": "running" });
    log.body = { ...log.body, steps, status: "running" };
    from += 1;
  }
  const done = await carryOn(ctx, log, all.steps, from);
  return outputOf(ctx, await withConfirmText(ctx, done, all.steps), all.steps);
}

/** The words of the step a log waits at (for the run's message). */
async function withConfirmText(ctx, log, steps) {
  if (log.body.status !== "waiting") return log;
  const at = steps[log.body.next];
  if (!at) return log;
  const s = await ctx.host.resources.get(at.id);
  log.body.steps[at.id].confirmText = str(s && s.body && s.body.confirm);
  return log;
}

/** `entries` for a flow contents in a sub-book: the book's own, with each step's state. */
export async function flowEntries(ctx, input) {
  const book = await parentOf(ctx, ctx.resource);
  const e = await entriesOfBook(ctx, book);
  if (!e) return { items: [] };
  const depth = input && Number.isInteger(input.depth) ? input.depth : 0;
  return { items: e.items.map((x) => ({ ...x, level: Math.min(9, x.level + depth) })) };
}
