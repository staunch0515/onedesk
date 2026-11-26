// Posting (记账, docs/redesign/book.md §27.5): a voucher's lines written into each item's ledger pages — receipts
// in, issues out at the costing method's price, the balance carried on line by line; a page holds 100 lines and then
// goes on to the next (“carried forward” / “brought forward”); a closed month's page is never written again.

import { full, num, round, str } from "./common.js";

export const ITEM = full("item");
export const SHEET = full("sheet");
/** Lines on one ledger page (the last one is “carried forward” when it goes on). */
export const PAGE_LINES = 100;
const PRICE_DECIMALS = 4;

/** An item's balance now: quantity, amount, and (first in, first out) its lots. */
export function balanceOf(item, s) {
  const b = (item && item.body) || {};
  if (b.bal && typeof b.bal === "object") return { qty: num(b.bal.qty), amount: num(b.bal.amount), layers: Array.isArray(b.bal.layers) ? b.bal.layers.map((l) => ({ qty: num(l.qty), price: num(l.price) })) : [] };
  const qty = num(b.openQty);
  const price = num(b.openPrice);
  return { qty, amount: round(qty * price, s.amountDecimals), layers: qty > 0 ? [{ qty, price }] : [] };
}

const priceOf = (amount, qty) => (qty ? round(amount / qty, PRICE_DECIMALS) : 0);

/** Taking in `qty` at `amount` (a negative quantity takes back a receipt). */
export function takeIn(bal, qty, amount, s) {
  const next = { qty: round(bal.qty + qty, s.qtyDecimals), amount: round(bal.amount + amount, s.amountDecimals), layers: bal.layers.map((l) => ({ ...l })) };
  if (s.method === "fifo") {
    if (qty > 0) next.layers.push({ qty, price: priceOf(amount, qty) });
    else {
      // Taking a receipt back: from the newest lots.
      let left = -qty;
      for (let i = next.layers.length - 1; i >= 0 && left > 0; i--) {
        const take = Math.min(left, next.layers[i].qty);
        next.layers[i].qty = round(next.layers[i].qty - take, s.qtyDecimals);
        left = round(left - take, s.qtyDecimals);
      }
      next.layers = next.layers.filter((l) => l.qty > 0);
    }
  }
  return next;
}

/**
 * Sending out `qty` at the costing method's price: `{ amount, price, bal }`. `fixed`: the amount to use (taking back an
 * issue at its own price).
 */
export function sendOut(bal, qty, s, fixed) {
  const layers = bal.layers.map((l) => ({ ...l }));
  let amount;
  if (fixed !== undefined) {
    amount = fixed;
    if (s.method === "fifo" && qty < 0) layers.unshift({ qty: -qty, price: priceOf(-fixed, -qty) });
  } else if (s.method === "fifo") {
    amount = 0;
    let left = qty;
    while (left > 0 && layers.length) {
      const take = Math.min(left, layers[0].qty);
      amount += take * layers[0].price;
      layers[0].qty = round(layers[0].qty - take, s.qtyDecimals);
      left = round(left - take, s.qtyDecimals);
      if (layers[0].qty <= 0) layers.shift();
    }
    // More than there is: the rest at the last price known.
    if (left > 0) amount += left * (bal.layers.length ? bal.layers[bal.layers.length - 1].price : priceOf(bal.amount, bal.qty));
    amount = round(amount, s.amountDecimals);
  } else {
    // Moving average; all of it takes all of the amount (no rounding left behind).
    amount = qty === bal.qty ? bal.amount : round(qty * (bal.qty ? bal.amount / bal.qty : 0), s.amountDecimals);
  }
  const next = { qty: round(bal.qty - qty, s.qtyDecimals), amount: round(bal.amount - amount, s.amountDecimals), layers: layers.filter((l) => l.qty > 0) };
  return { amount, price: priceOf(amount, qty), bal: next };
}

/** A balance line's last three columns. */
const balCols = (bal) => ({ balQty: bal.qty, balAmount: bal.amount, balPrice: priceOf(bal.amount, bal.qty) });

/** The item's ledger pages, in order: `[{ id, page, lines, stamped }]`. */
export async function sheetsOf(ctx, item) {
  const kids = await ctx.host.resources.list({ kind: "sheet", parent: item.id });
  return kids
    .map((k) => ({ id: k.id, page: num(k.body && k.body.page), lines: Array.isArray(k.body && k.body.lines) ? k.body.lines : [], stamped: Array.isArray(k.stamps) && k.stamps.length > 0, name: k.name }))
    .sort((a, b) => a.page - b.page);
}

/**
 * Writes lines into an item's pages: on its last page while there is room and it is not closed; otherwise a new page
 * “brought forward”. `pending` collects what was written (to undo it). `words`: the summaries of the special lines.
 */
export async function writeLines(ctx, item, lines, words, pending, opening) {
  const sheets = await sheetsOf(ctx, item);
  let last = sheets[sheets.length - 1];
  const newPage = async (first) => {
    const page = last ? last.page + 1 : 1;
    const made = await ctx.host.resources.create({ kind: "sheet", parent: item.id, name: words.pageName(page), body: { item: item.id, page, lines: [first] } });
    pending.created.push(made.id);
    last = { id: made.id, page, lines: [first], stamped: false, fresh: true };
  };
  if (!last) await newPage({ type: "open", date: opening.date, summary: words.opening, ...balCols(opening.bal) });
  for (const line of lines) {
    if (last.stamped || last.lines.length >= PAGE_LINES - 1) {
      const prev = last.lines[last.lines.length - 1];
      if (!last.stamped) {
        // The page is full: its 100th line says it goes on.
        const carried = { type: "carried", date: prev.date, summary: words.carried, balQty: prev.balQty, balAmount: prev.balAmount, balPrice: prev.balPrice };
        last.lines.push(carried);
        await saveSheet(ctx, last, last.lines, pending);
      }
      const p = last.lines[last.lines.length - 1];
      await newPage({ type: "forward", date: p.date, summary: words.forward, balQty: p.balQty, balAmount: p.balAmount, balPrice: p.balPrice });
    }
    last.lines.push(line);
    await saveSheet(ctx, last, last.lines, pending);
  }
}

async function saveSheet(ctx, sheet, lines, pending) {
  if (!sheet.fresh && !pending.sheets.has(sheet.id)) {
    const before = await ctx.host.resources.get(sheet.id);
    pending.sheets.set(sheet.id, (before && before.body && before.body.lines) || []);
  }
  await ctx.host.resources.update(sheet.id, { "body.lines": lines.slice() });
}

/** Undoes what a posting wrote: pages made are removed, pages changed get their lines back, balances restored. */
export async function undo(ctx, pending) {
  for (const id of pending.created) {
    try {
      await ctx.host.resources.remove(id);
    } catch {
      // already gone
    }
  }
  // Each one on its own: one that cannot be put back does not keep the others from it.
  for (const [id, lines] of pending.sheets) await ctx.host.resources.update(id, { "body.lines": lines }).catch(() => undefined);
  for (const [id, bal] of pending.items) await ctx.host.resources.update(id, { "body.bal": bal }).catch(() => undefined);
}

/** A fresh record of what a posting writes. */
export const newPending = () => ({ created: [], sheets: new Map(), items: new Map() });

/** The balance of an item at the end of `month` (from its pages), and what went in and out during the month. */
export function monthOf(lines, month) {
  let opening = null;
  let closing = null;
  let inQty = 0;
  let inAmount = 0;
  let outQty = 0;
  let outAmount = 0;
  for (const l of lines) {
    const m = str(l.date).slice(0, 7);
    if (l.type === "line") {
      if (m < month) opening = l;
      if (m === month) {
        inQty += num(l.inQty);
        inAmount += num(l.inAmount);
        outQty += num(l.outQty);
        outAmount += num(l.outAmount);
      }
    } else if (l.type === "open" && m <= month && !opening) opening = l;
    if (m <= month && (l.type === "line" || l.type === "open")) closing = l;
  }
  return { opening, closing, inQty, inAmount, outQty, outAmount };
}
