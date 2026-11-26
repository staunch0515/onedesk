// A letter received (来件, docs/redesign/book.md §35.5): who sent it (signed, checked or not), what about, by when; the
// pages attached (read only) and what is asked of each, with whether it is done (each page's role says); a general
// response (read, agree or not, a comment); "Reply…" writes the signed reply file with what each page's role gives back.

import { bodyNow, day, failed, folderOf, freePath, overdue, replyOf, safeName, say, str, todoOf, whoText } from "./common.js";

export async function renderLetter(ctx) {
  const res = ctx.resource || {};
  const info = res.id ? await ctx.host.letters.info(res.id) : null;
  if (!info || info.dir !== "in") return { view: [{ type: "text", id: "none", text: say(ctx, "letter.notReceived"), tone: "muted" }] };
  const body = bodyNow(ctx);
  const head = [`**${str(info.subject)}**`, say(ctx, "letter.from", { who: whoText(ctx, info.from) }), say(ctx, "letter.receivedAt", { at: day(info.at) })];
  if (info.due) head.push(say(ctx, overdue(info.due, Date.now()) && !body.repliedAt ? "letter.overdue" : "letter.due", { due: info.due }));
  if (info.comment) head.push(str(info.comment));
  if (body.repliedAt) head.push(say(ctx, "letter.repliedAt", { at: day(body.repliedAt) }));
  // One paragraph each.
  const view = [{ type: "text", id: "head", text: head.join("\n\n"), format: "markdown" }];
  // What is asked of each page, and whether it is done.
  const tasks = Array.isArray(info.tasks) ? info.tasks : [];
  // The pages' names (any plugin's: the subtree of the letter lists them).
  const names = new Map();
  try {
    for (const n of (await ctx.host.resources.tree(res.id, { limit: 2000 })).nodes) names.set(n.id, n.name);
  } catch {
    // Not readable: ids stand in.
  }
  const table = [];
  const targets = [];
  for (const t of tasks) {
    const name = names.get(t.page) || t.page;
    const s = await todoOf(ctx, t.page, t.task);
    table.push([name, str(t.label || t.task), s.state === "done" ? say(ctx, "todo.done", { what: str(s.summary) }) : say(ctx, "todo.todo")]);
    targets.push(`resource:${t.page}`);
  }
  view.push({ type: "text", id: "tasksTitle", text: `**${say(ctx, "letter.tasks")}**`, format: "markdown" });
  view.push({ type: "table", id: "tasks", columns: [{ key: "page", label: say(ctx, "col.page") }, { key: "task", label: say(ctx, "col.task") }, { key: "state", label: say(ctx, "col.state") }], rows: table, rowTargets: targets });
  view.push({
    type: "form",
    id: "response",
    layout: "stack",
    fields: [
      { name: "read", label: say(ctx, "response.read"), kind: "boolean", bind: "body.response.read" },
      { name: "agree", label: say(ctx, "field.agree"), kind: "enum", bind: "body.response.agree", options: [{ value: "", label: say(ctx, "response.none") }, { value: "agree", label: say(ctx, "response.agree") }, { value: "disagree", label: say(ctx, "response.disagree") }] },
      { name: "comment", label: say(ctx, "field.comment"), kind: "longtext", bind: "body.response.comment" },
    ],
  });
  return { view };
}

/** "Reply…": what each page's role gives back, and the response, signed and written where the user granted. */
export async function replyAction(ctx) {
  const res = ctx.resource;
  const info = await ctx.host.letters.info(res.id);
  if (!info || info.dir !== "in") return failed(ctx, "letter.notReceived");
  const b = bodyNow(ctx);
  const pages = [];
  const missing = [];
  for (const t of Array.isArray(info.tasks) ? info.tasks : []) {
    const r = await replyOf(ctx, t.page, t.task);
    if (r) pages.push({ page: t.page, task: t.task, data: r.data, summary: str(r.summary) });
    else missing.push(str(t.label || t.task));
  }
  const response = { read: b["response.read"] === true || (b.response && b.response.read === true), agree: str(b["response.agree"] ?? (b.response && b.response.agree)), comment: str(b["response.comment"] ?? (b.response && b.response.comment)) };
  const folder = await folderOf(ctx);
  if (!folder) return failed(ctx, "sent.pickFolder");
  const path = await freePath(ctx, folder, `${safeName(info.subject)}-${say(ctx, "letter.replyName")}`, ".odletter");
  const w = await ctx.host.letters.write(res.id, { reply: { pages, response }, path });
  await ctx.host.resources.update(res.id, { "body.repliedAt": Date.now() });
  const lines = [say(ctx, "letter.wrote", { path: w.path })];
  if (missing.length) lines.push(say(ctx, "letter.notDone", { what: missing.join("、") }));
  return { output: { type: "text", text: lines.join("\n") }, summary: { message: say(ctx, "letter.replied") } };
}
