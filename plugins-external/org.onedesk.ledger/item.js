// An item (存货, docs/redesign/book.md §27.4): an account in the stock ledger — what it is (code, name, spec, unit,
// where it is kept, the limits, the opening stock) and, below, its ledger: the pages read one after another.
// A ledger page (账页): written only by posting; read only.

import { bodyNow, bookAbove, num, say, setupOf, str } from "./common.js";
import { balanceOf, sheetsOf } from "./posting.js";

const COLS = ["date", "no", "summary", "inQty", "inPrice", "inAmount", "outQty", "outPrice", "outAmount", "balQty", "balPrice", "balAmount"];

/** Ledger lines as table rows (empty cells for what a line does not have). */
export function ledgerTable(ctx, id, lines) {
  const cell = (l, k) => (l[k] === undefined || l[k] === null || l[k] === "" ? "" : String(l[k]));
  return {
    type: "table",
    id,
    columns: COLS.map((k) => ({ key: k, label: say(ctx, `ledger.${k}`), numeric: !["date", "no", "summary"].includes(k) })),
    rows: lines.map((l) => COLS.map((k) => cell(l, k))),
    rowTargets: lines.map((l) => (l.voucher ? `resource:${l.voucher}` : null)),
  };
}

export async function renderItem(ctx) {
  const res = ctx.resource || {};
  const posted = Boolean(res.body && res.body.bal);
  const f = (name, kind, extra = {}) => ({ name, label: ctx.t(`field.${name}`), kind, bind: `body.${name}`, ...extra });
  const view = [
    { type: "form", id: "item", layout: "strip", fields: [f("code", "text"), f("spec", "text"), f("unit", "text"), f("category", "text"), f("location", "text")] },
    {
      type: "form",
      id: "stock",
      layout: "strip",
      fields: [
        f("min", "number"), f("max", "number"),
        f("openQty", "number", posted ? { readOnly: true, hint: ctx.t("field.open.locked") } : {}),
        f("openPrice", "number", posted ? { readOnly: true } : {}),
      ],
    },
  ];
  if (!res.id) return { view };
  const book = await bookAbove(ctx, res.id);
  const s = book ? await setupOf(ctx, book.id) : { method: "moving", qtyDecimals: 2, amountDecimals: 2 };
  const bal = balanceOf({ body: bodyNow(ctx) }, s);
  view.push({ type: "text", id: "balance", text: say(ctx, "item.balance", { qty: bal.qty, amount: bal.amount.toFixed(s.amountDecimals), unit: str(res.body && res.body.unit) }) });
  const lines = [];
  for (const sh of await sheetsOf(ctx, res)) lines.push(...sh.lines);
  view.push({ type: "text", id: "ledgerTitle", text: `**${say(ctx, "item.ledger")}**`, format: "markdown" });
  if (lines.length === 0) view.push({ type: "text", id: "noLines", text: say(ctx, "item.noLines"), tone: "muted" });
  else view.push(ledgerTable(ctx, "ledger", lines));
  if (s.method === "fifo" && bal.layers.length) {
    view.push({ type: "text", id: "lotsTitle", text: `**${say(ctx, "item.lots")}**`, format: "markdown" });
    view.push({ type: "table", id: "lots", columns: [{ key: "qty", label: say(ctx, "ledger.balQty"), numeric: true }, { key: "price", label: say(ctx, "ledger.balPrice"), numeric: true }], rows: bal.layers.map((l) => [String(l.qty), String(l.price)]) });
  }
  return { view };
}

export async function renderSheet(ctx) {
  const lines = Array.isArray(ctx.resource && ctx.resource.body && ctx.resource.body.lines) ? ctx.resource.body.lines : [];
  if (lines.length === 0) return { view: [{ type: "text", id: "empty", text: say(ctx, "item.noLines"), tone: "muted" }], readOnly: true };
  return { view: [ledgerTable(ctx, "lines", lines)], readOnly: true };
}

/** In the book: an item shows its balance; a page its lines. */
export async function embedItem(ctx) {
  const r = ctx.resource;
  const book = await bookAbove(ctx, r.id);
  const s = book ? await setupOf(ctx, book.id) : { method: "moving", qtyDecimals: 2, amountDecimals: 2 };
  const bal = balanceOf(r, s);
  const b = r.body || {};
  const lines = [`${str(b.code)} ${str(b.spec)}`.trim(), say(ctx, "item.balance", { qty: bal.qty, amount: bal.amount.toFixed(s.amountDecimals), unit: str(b.unit) })].filter(Boolean);
  return { view: [{ type: "text", id: "item", text: lines.join("\n\n"), format: "markdown" }] };
}

export async function embedSheet(ctx) {
  const lines = Array.isArray(ctx.resource.body && ctx.resource.body.lines) ? ctx.resource.body.lines : [];
  return { view: lines.length ? [ledgerTable(ctx, "lines", lines)] : [] };
}

/** Low or high stock (for the catalog). */
export function stockState(ctx, body, qty) {
  const min = num(body && body.min);
  const max = num(body && body.max);
  if (str(body && body.min) !== "" && qty < min) return say(ctx, "item.low");
  if (str(body && body.max) !== "" && max > 0 && qty > max) return say(ctx, "item.high");
  return "";
}
