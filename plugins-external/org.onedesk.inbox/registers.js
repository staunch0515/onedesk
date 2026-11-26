// The registers (收文簿, 发文簿; docs/redesign/book.md §35.5): one line per letter received or sent, with its state.

import { day, overdue, say, str, whoText } from "./common.js";

async function kids(ctx, parent, kind) {
  return (await ctx.host.resources.list({ kind, parent })).sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
}

/** 收文簿: received date, from whom, what about, by when, state (to do, answered, overdue). */
export async function renderInbox(ctx) {
  const res = ctx.resource || {};
  if (!res.id) return { view: [{ type: "text", id: "new", text: say(ctx, "inbox.new"), tone: "muted" }] };
  const letters = await kids(ctx, res.id, "letter");
  const rows = [];
  const targets = [];
  let todo = 0;
  for (const l of letters) {
    const info = await ctx.host.letters.info(l.id);
    if (!info) continue;
    const replied = l.body && l.body.repliedAt;
    const state = replied ? say(ctx, "state.replied") : overdue(info.due, Date.now()) ? say(ctx, "state.overdue") : say(ctx, "state.todo");
    if (!replied) todo += 1;
    rows.push([day(info.at), whoText(ctx, info.from), str(info.subject), str(info.due), state]);
    targets.push(`resource:${l.id}`);
  }
  const view = [{ type: "text", id: "hint", text: say(ctx, rows.length ? "inbox.count" : "inbox.empty", { n: rows.length, todo }), tone: "muted" }];
  if (rows.length)
    view.push({
      type: "table",
      id: "letters",
      columns: ["at", "from", "subject", "due", "state"].map((k) => ({ key: k, label: say(ctx, `col.${k}`) })),
      rows,
      rowTargets: targets,
    });
  return { view };
}

/** 发文簿: sent date, what about, how many asked, how many answered. */
export async function renderOutbox(ctx) {
  const res = ctx.resource || {};
  if (!res.id) return { view: [{ type: "text", id: "new", text: say(ctx, "outbox.new"), tone: "muted" }] };
  const sent = await kids(ctx, res.id, "sent");
  const rows = [];
  const targets = [];
  for (const s of sent) {
    const b = s.body || {};
    if (!b.sentAt) {
      rows.push(["—", str(b.subject) || s.name, "", "", say(ctx, "state.draft")]);
    } else {
      const info = await ctx.host.letters.info(s.id);
      const n = info && Array.isArray(info.to) ? info.to.length : 0;
      const got = info && Array.isArray(info.replies) ? info.replies.length : 0;
      rows.push([day(b.sentAt), str(b.subject), n ? String(n) : say(ctx, "outbox.anyone"), String(got), overdue(b.due, Date.now()) && got < n ? say(ctx, "state.overdue") : str(b.due)]);
    }
    targets.push(`resource:${s.id}`);
  }
  const view = [];
  if (rows.length)
    view.push({
      type: "table",
      id: "sent",
      columns: ["at", "subject", "to", "answered", "due"].map((k) => ({ key: k, label: say(ctx, `col.${k}`) })),
      rows,
      rowTargets: targets,
    });
  else view.push({ type: "text", id: "empty", text: say(ctx, "outbox.empty"), tone: "muted" });
  return { view };
}
