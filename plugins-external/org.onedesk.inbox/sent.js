// A letter sent (发件, docs/redesign/book.md §35.5): to whom (from the contacts, or anyone), what about, by when, which
// pages and what is asked of each (each page's role says what it can be asked); "Send…" writes the signed letter file;
// once sent it is fixed, and shows who has answered and what came back.

import { bodyNow, day, failed, folderOf, freePath, full, NONE, safeName, say, str, tasksOf, whoText } from "./common.js";

const rows = (v) => (Array.isArray(v) ? v.filter((r) => r && typeof r === "object") : []);

export async function renderSent(ctx) {
  const res = ctx.resource || {};
  const body = bodyNow(ctx);
  if (res.id && res.body && res.body.sentAt) return renderAfter(ctx, res);
  // What can be asked: the union of what the chosen pages offer.
  const options = new Map();
  for (const r of rows(body.pages)) if (r.page) for (const t of await tasksOf(ctx, r.page)) options.set(t.task, t.label);
  const taskOptions = [...options.entries()].map(([value, label]) => ({ value, label }));
  const view = [
    {
      type: "form",
      id: "head",
      layout: "stack",
      fields: [
        { name: "subject", label: say(ctx, "field.subject"), kind: "text", bind: "body.subject" },
        { name: "comment", label: say(ctx, "field.note"), kind: "longtext", bind: "body.comment" },
        { name: "due", label: say(ctx, "field.due"), kind: "date", bind: "body.due" },
        { name: "to", label: say(ctx, "field.to"), kind: "rows", bind: "body.to", columns: [{ name: "who", label: say(ctx, "col.who"), kind: "ref", kinds: ["core:contact"] }] },
        {
          name: "pages",
          label: say(ctx, "field.pages"),
          kind: "rows",
          bind: "body.pages",
          columns: [
            { name: "page", label: say(ctx, "col.page"), kind: "ref", kinds: ["@implements:onedesk.letter/1"] },
            { name: "task", label: say(ctx, "col.task"), kind: "enum", options: taskOptions },
          ],
        },
      ],
    },
  ];
  view.push({ type: "text", id: "hint", text: say(ctx, rows(body.to).some((r) => r.who) ? "sent.hint" : "sent.anyone"), tone: "muted" });
  return { view };
}

async function renderAfter(ctx, res) {
  const info = await ctx.host.letters.info(res.id);
  const b = res.body || {};
  const lines = [`**${str(b.subject)}**`, say(ctx, "sent.sentAt", { at: day(b.sentAt), file: str(b.file) })];
  if (b.due) lines.push(say(ctx, "letter.due", { due: b.due }));
  if (b.comment) lines.push(str(b.comment));
  const view = [{ type: "text", id: "head", text: lines.join("\n\n"), format: "markdown" }];
  const replies = (info && Array.isArray(info.replies) ? info.replies : []);
  const to = info && Array.isArray(info.to) ? info.to : [];
  const table = [];
  const seen = new Set();
  for (const t of to) {
    const r = replies.find((x) => x.from && x.from.fingerprint === t.fingerprint);
    if (r) seen.add(r.from.fingerprint);
    table.push([t.name || t.fingerprint, r ? say(ctx, "sent.replied", { at: day(r.at) }) : say(ctx, "sent.waiting"), r ? summaryOf(ctx, r) : ""]);
  }
  for (const r of replies) if (!seen.has(r.from && r.from.fingerprint)) table.push([whoText(ctx, r.from), say(ctx, "sent.replied", { at: day(r.at) }), summaryOf(ctx, r)]);
  view.push({ type: "text", id: "answersTitle", text: `**${say(ctx, "sent.answers", { n: replies.length, of: to.length || "—" })}**`, format: "markdown" });
  view.push({
    type: "table",
    id: "answers",
    columns: [
      { key: "who", label: say(ctx, "col.who") },
      { key: "state", label: say(ctx, "col.state") },
      { key: "what", label: say(ctx, "col.what") },
    ],
    rows: table,
  });
  return { view, readOnly: true };
}

function summaryOf(ctx, r) {
  const parts = (Array.isArray(r.pages) ? r.pages : []).map((p) => str(p.summary)).filter(Boolean);
  const resp = r.response || {};
  if (resp.agree === "agree") parts.push(say(ctx, "response.agree"));
  if (resp.agree === "disagree") parts.push(say(ctx, "response.disagree"));
  if (resp.read) parts.push(say(ctx, "response.read"));
  if (str(resp.comment)) parts.push(say(ctx, "sent.quoted", { text: str(resp.comment) }));
  return parts.join(say(ctx, "sent.sep"));
}

/** "Send…": the letter file, written where the user granted; then the letter is fixed. */
export async function sendAction(ctx) {
  const res = ctx.resource;
  const b = res.body || {};
  if (b.sentAt) return failed(ctx, "sent.already");
  if (!str(b.subject).trim()) return failed(ctx, "sent.noSubject");
  const chosen = rows(b.pages).filter((r) => r.page);
  if (chosen.length === 0) return failed(ctx, "sent.noPages");
  const tasks = [];
  for (const r of chosen) {
    const offered = await tasksOf(ctx, r.page);
    const t = offered.find((x) => x.task === r.task) || offered[0];
    if (!t) return failed(ctx, "sent.cannotAsk");
    tasks.push({ page: r.page, task: t.task, label: t.label });
  }
  const folder = await folderOf(ctx);
  if (!folder) return failed(ctx, "sent.pickFolder");
  const path = await freePath(ctx, folder, safeName(b.subject), ".odletter");
  const to = rows(b.to).map((r) => r.who).filter(Boolean);
  let w;
  try {
    w = await ctx.host.letters.write(res.id, { pages: chosen.map((r) => r.page), to, subject: str(b.subject), comment: str(b.comment), due: str(b.due), tasks, rootKind: "letter", path });
  } catch (e) {
    if (e && e.params && e.params.reason === "noIdentity") return failed(ctx, "sent.noIdentity");
    throw e;
  }
  await ctx.host.resources.update(res.id, { "body.sentAt": Date.now(), "body.file": w.path });
  await ctx.host.resources.stamp(res.id, { label: say(ctx, "stamp.sent"), signer: "" });
  return { output: { type: "text", text: say(ctx, "sent.wrote", { path: w.path }) }, summary: { message: say(ctx, "sent.done") } };
}

export const SENT = full("sent");
export { NONE };
