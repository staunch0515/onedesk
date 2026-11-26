// The stock summary (收发存汇总表, docs/redesign/book.md §27.7): one month — each item's opening, in, out and closing
// balance, from its ledger pages. Month-end close is done here: every voucher of the month posted, a “this month”
// line on every item's page, the pages and this summary stamped, the month closed; only the last closed month can be
// opened again (with a reason), and only while nothing later is posted.

import { bodyNow, bookAbove, contentsOf, full, num, round, say, setupOf, str } from "./common.js";
import { monthOf, sheetsOf } from "./posting.js";
import { stateOf } from "./voucher.js";

const isMonth = (m) => /^\d{4}-\d{2}$/.test(str(m));

async function figures(ctx, bookId, month) {
  const c = await contentsOf(ctx, bookId);
  const s = await setupOf(ctx, bookId);
  const out = [];
  for (const n of c.item) {
    const item = await ctx.host.resources.get(n.id);
    if (!item) continue;
    const lines = [];
    const sheets = await sheetsOf(ctx, item);
    for (const sh of sheets) lines.push(...sh.lines);
    const m = monthOf(lines, month);
    const open = m.opening || (lines[0] && lines[0].type === "open" ? lines[0] : null);
    const openQty = open ? num(open.balQty) : 0;
    const openAmount = open ? num(open.balAmount) : 0;
    out.push({ item, sheets, lines, openQty, openAmount, inQty: m.inQty, inAmount: round(m.inAmount, s.amountDecimals), outQty: m.outQty, outAmount: round(m.outAmount, s.amountDecimals), closeQty: m.closing ? num(m.closing.balQty) : openQty, closeAmount: m.closing ? num(m.closing.balAmount) : openAmount });
  }
  return { rows: out, s, c };
}

export async function renderSummary(ctx) {
  const res = ctx.resource || {};
  const b = bodyNow(ctx);
  const view = [{ type: "form", id: "month", layout: "strip", fields: [{ name: "month", label: ctx.t("field.month"), kind: "text", bind: "body.month", placeholder: "2026-11" }] }];
  if (!res.id) return { view };
  const book = await bookAbove(ctx, res.id);
  if (!book) return { view: [...view, { type: "text", id: "alone", text: say(ctx, "summary.alone"), tone: "muted" }] };
  if (!isMonth(b.month)) return { view: [...view, { type: "text", id: "noMonth", text: say(ctx, "summary.noMonth"), tone: "muted" }] };
  const { rows, s } = await figures(ctx, book.id, b.month);
  const closed = s.closed.includes(b.month);
  view.push({ type: "text", id: "state", text: say(ctx, closed ? "summary.closed" : "summary.open", { month: b.month }), tone: "muted" });
  const fmt = (v) => num(v).toFixed(s.amountDecimals);
  const sum = (k) => rows.reduce((a, r) => a + r[k], 0);
  view.push({
    type: "table",
    id: "figures",
    columns: ["item", "openQty", "openAmount", "inQty", "inAmount", "outQty", "outAmount", "closeQty", "closeAmount"].map((k) => ({ key: k, label: say(ctx, `summary.${k}`), numeric: k !== "item" })),
    rows: [
      ...rows.map((r) => [r.item.name, String(r.openQty), fmt(r.openAmount), String(r.inQty), fmt(r.inAmount), String(r.outQty), fmt(r.outAmount), String(r.closeQty), fmt(r.closeAmount)]),
      [say(ctx, "summary.total"), "", fmt(sum("openAmount")), "", fmt(sum("inAmount")), "", fmt(sum("outAmount")), "", fmt(sum("closeAmount"))],
    ],
    rowTargets: [...rows.map((r) => `resource:${r.item.id}`), null],
  });
  view.push({ type: "form", id: "reasonForm", layout: "strip", fields: [{ name: "reason", label: ctx.t("field.reopenReason"), kind: "text", param: true }] });
  return { view, readOnly: (Array.isArray(res.stamps) && res.stamps.length > 0) || undefined };
}

async function signer(ctx) {
  try {
    const f = await ctx.host.params.get(say(ctx, "env.signer"));
    return f && f.found ? str(f.value) : say(ctx, "post.someone");
  } catch {
    return say(ctx, "post.someone");
  }
}

/** Vouchers dated in `month` not posted yet. */
async function unposted(ctx, c, month) {
  const out = [];
  for (const k of ["receipt", "issue", "count"])
    for (const n of c[k]) {
      const v = await ctx.host.resources.get(n.id);
      if (v && str(v.body && v.body.date).startsWith(month) && !stateOf(ctx, v).posted) out.push(str(v.body.no) || v.name);
    }
  return out;
}

async function close(ctx) {
  const res = ctx.resource;
  const month = str(res.body && res.body.month);
  if (!isMonth(month)) return { message: ctx.t("summary.noMonth") };
  const book = await bookAbove(ctx, res.id);
  if (!book) return { message: ctx.t("summary.alone") };
  const { rows, s, c } = await figures(ctx, book.id, month);
  if (s.closed.includes(month)) return { message: say(ctx, "close.already", { month }) };
  const open = await unposted(ctx, c, month);
  if (open.length) return { message: say(ctx, "close.unposted", { list: open.join("、") }) };
  const who = await signer(ctx);
  for (const r of rows) {
    if (r.sheets.length === 0) continue;
    const last = r.sheets[r.sheets.length - 1];
    if (last.stamped) continue;
    const add = [{ type: "total", date: `${month}-31`.slice(0, 10), month, summary: say(ctx, "line.monthTotal"), inQty: r.inQty, inAmount: r.inAmount, outQty: r.outQty, outAmount: r.outAmount, balQty: r.closeQty, balAmount: r.closeAmount }];
    if (month.endsWith("-12")) {
      const year = month.slice(0, 4);
      const ys = r.lines.filter((l) => l.type === "line" && str(l.date).startsWith(year));
      add.push({ type: "year", date: `${month}-31`, month, summary: say(ctx, "line.yearTotal"), inQty: ys.reduce((a, l) => a + num(l.inQty), 0), inAmount: round(ys.reduce((a, l) => a + num(l.inAmount), 0), s.amountDecimals), outQty: ys.reduce((a, l) => a + num(l.outQty), 0), outAmount: round(ys.reduce((a, l) => a + num(l.outAmount), 0), s.amountDecimals), balQty: r.closeQty, balAmount: r.closeAmount });
    }
    await ctx.host.resources.update(last.id, { "body.lines": [...last.lines, ...add] });
    await ctx.host.resources.stamp(last.id, { label: say(ctx, "stamp.closed"), signer: who });
  }
  if (s.id) await ctx.host.resources.update(s.id, { "body.closed": [...s.closed, month].sort() });
  await ctx.host.resources.stamp(res.id, { label: say(ctx, "stamp.closed"), signer: who });
  return { message: say(ctx, "close.done", { month }) };
}

async function reopen(ctx) {
  const res = ctx.resource;
  const month = str(res.body && res.body.month);
  const reason = str(ctx.params && ctx.params.reason).trim();
  if (!reason) return { message: ctx.t("reopen.noReason") };
  const book = await bookAbove(ctx, res.id);
  if (!book) return { message: ctx.t("summary.alone") };
  const { rows, s } = await figures(ctx, book.id, month);
  if (!s.closed.includes(month)) return { message: say(ctx, "reopen.notClosed", { month }) };
  if (s.closed[s.closed.length - 1] !== month) return { message: say(ctx, "reopen.notLast", { month: s.closed[s.closed.length - 1] }) };
  if (rows.some((r) => r.lines.some((l) => l.type === "line" && str(l.date).slice(0, 7) > month))) return { message: ctx.t("reopen.later") };
  for (const r of rows) {
    for (const sh of r.sheets) {
      if (!sh.lines.some((l) => (l.type === "total" || l.type === "year") && l.month === month)) continue;
      await ctx.host.resources.unstamp(sh.id, { reason });
      await ctx.host.resources.update(sh.id, { "body.lines": sh.lines.filter((l) => !((l.type === "total" || l.type === "year") && l.month === month)) });
    }
    // A page begun after the close that holds only “brought forward” goes away.
    for (const sh of r.sheets) if (!sh.stamped && sh.lines.length === 1 && sh.lines[0].type === "forward") await ctx.host.resources.remove(sh.id);
  }
  if (s.id) await ctx.host.resources.update(s.id, { "body.closed": s.closed.filter((m) => m !== month) });
  await ctx.host.resources.unstamp(res.id, { reason });
  return { params: { reason: "" }, message: say(ctx, "reopen.done", { month }) };
}

export async function summaryEvent(ctx, event) {
  if (event === "close") return close(ctx);
  if (event === "reopen") return reopen(ctx);
  throw new Error(`unknown event ${event}`);
}

const csvCell = (v) => {
  const t = str(v);
  return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};

/** “Export”: the summary as CSV into the first granted folder. */
export async function exportAction(ctx) {
  const res = ctx.resource;
  const month = str(res.body && res.body.month);
  const book = await bookAbove(ctx, res.id);
  const fail = (key) => ({ output: { type: "text", text: say(ctx, key) }, failed: { message: say(ctx, key) } });
  if (!book || !isMonth(month)) return fail("summary.noMonth");
  const roots = await ctx.host.files.roots();
  if (!roots || roots.length === 0) {
    try {
      await ctx.host.files.addRoot();
    } catch {
      // the message says what to do
    }
    return fail("export.pickFolder");
  }
  const { rows, s } = await figures(ctx, book.id, month);
  const head = ["item", "openQty", "openAmount", "inQty", "inAmount", "outQty", "outAmount", "closeQty", "closeAmount"].map((k) => say(ctx, `summary.${k}`));
  const body = rows.map((r) => [r.item.name, r.openQty, r.openAmount.toFixed(s.amountDecimals), r.inQty, r.inAmount.toFixed(s.amountDecimals), r.outQty, r.outAmount.toFixed(s.amountDecimals), r.closeQty, r.closeAmount.toFixed(s.amountDecimals)]);
  const text = [head, ...body].map((r) => r.map(csvCell).join(",")).join("\n") + "\n";
  let path = `${roots[0].path}/${book.name.replace(/[\\/:*?"<>|\n]/g, "-")} ${month}.csv`;
  for (let i = 2; i < 1000; i++) {
    try {
      await ctx.host.files.stat(path);
      path = `${roots[0].path}/${book.name.replace(/[\\/:*?"<>|\n]/g, "-")} ${month} ${i}.csv`;
    } catch {
      break;
    }
  }
  await ctx.host.files.writeText(path, text);
  return { output: { type: "text", text: say(ctx, "export.done", { path }) } };
}

export const SUMMARY = full("summary");
