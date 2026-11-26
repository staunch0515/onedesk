// Vouchers (单据, docs/redesign/book.md §27.3): receipts, issues and stocktakes. Filled in as a draft; audited
// (checked, then signed — a stamp, K6); posted into the items' ledger pages (another stamp); a posted one is never
// changed: a red reversing voucher takes it back.

import { allWords, bodyNow, bookAbove, contentsOf, full, monthOf, num, round, say, setupOf, str, today, VOUCHERS } from "./common.js";
import { balanceOf, ITEM, newPending, sendOut, sheetsOf, takeIn, undo, writeLines } from "./posting.js";

const PREFIX = { receipt: "RK", issue: "CK", count: "PD" };

/** Where a voucher stands, from its stamps: audited, posted, reversed. */
export function stateOf(ctx, res) {
  const labels = (Array.isArray(res && res.stamps) ? res.stamps : []).map((s) => s.label);
  const has = (key) => labels.some((l) => allWords(ctx, key).includes(l));
  return { audited: has("stamp.audit"), posted: has("stamp.posted"), reversed: has("stamp.reversed"), stamps: labels.length };
}

const shortKind = (res) => str(res && res.kind).slice(str(res && res.kind).lastIndexOf(":") + 1);

function columnsOf(ctx, kind) {
  const item = { name: "item", label: ctx.t("col.item"), kind: "ref", kinds: ["item"] };
  if (kind === "receipt") return [item, { name: "qty", label: ctx.t("col.qty"), kind: "number" }, { name: "price", label: ctx.t("col.price"), kind: "number" }, { name: "amount", label: ctx.t("col.amount"), kind: "number" }];
  if (kind === "issue") return [item, { name: "qty", label: ctx.t("col.qty"), kind: "number" }];
  return [item, { name: "actual", label: ctx.t("col.actual"), kind: "number" }];
}

const mdCell = (v) => String(v ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
const mdTable = (head, rows) => [`| ${head.map(mdCell).join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.map(mdCell).join(" | ")} |`)].join("\n");

const linesOf = (body) => (Array.isArray(body && body.lines) ? body.lines.filter((l) => l && typeof l === "object") : []);

/** The items' names and balances, by id. */
async function itemsById(ctx, ids, s) {
  const out = new Map();
  for (const id of new Set(ids.filter(Boolean))) {
    let r = null;
    try {
      r = await ctx.host.resources.get(id);
    } catch {
      r = null;
    }
    if (r && r.kind === ITEM) out.set(id, { res: r, bal: balanceOf(r, s) });
  }
  return out;
}

function statusLine(ctx, res, body) {
  const st = stateOf(ctx, res);
  const parts = [st.reversed ? say(ctx, "status.reversed") : st.posted ? say(ctx, "status.posted") : st.audited ? say(ctx, "status.audited") : say(ctx, "status.draft")];
  if (body.reverses) parts.push(say(ctx, "status.reversing", { no: str(body.reversesNo) }));
  return parts.join("　");
}

export async function renderVoucher(ctx) {
  const res = ctx.resource || {};
  const kind = shortKind(res) || "receipt";
  const body = bodyNow(ctx);
  const st = stateOf(ctx, res);
  const view = [];
  if (res.id) view.push({ type: "text", id: "status", text: statusLine(ctx, res, body), tone: body.reverses ? "danger" : "muted" });
  view.push({
    type: "form",
    id: "head",
    layout: "strip",
    fields: [
      { name: "date", label: ctx.t("field.date"), kind: "date", bind: "body.date" },
      { name: "no", label: ctx.t("field.no"), kind: "text", bind: "body.no", placeholder: ctx.t("field.no.placeholder") },
      { name: "handler", label: ctx.t("field.handler"), kind: "text", bind: "body.handler" },
      ...(kind === "count" ? [] : [{ name: "party", label: ctx.t(kind === "receipt" ? "field.supplier" : "field.department"), kind: "text", bind: "body.party" }]),
      { name: "summary", label: ctx.t("field.summary"), kind: "text", bind: "body.summary" },
    ],
  });
  view.push({ type: "form", id: "linesForm", layout: "stack", fields: [{ name: "lines", label: ctx.t("field.lines"), kind: "rows", bind: "body.lines", columns: columnsOf(ctx, kind) }] });
  // What is worked out: amounts, book quantities, differences, prices when posted.
  const book = res.id ? await bookAbove(ctx, res.id) : null;
  const s = book ? await setupOf(ctx, book.id) : { method: "moving", qtyDecimals: 2, amountDecimals: 2, closed: [] };
  const lines = linesOf(body);
  const items = await itemsById(ctx, lines.map((l) => l.item), s);
  const rows = [];
  let total = 0;
  for (const l of lines) {
    const it = items.get(l.item);
    const name = it ? it.res.name : "—";
    if (kind === "receipt") {
      const amount = str(l.amount) !== "" ? num(l.amount) : round(num(l.qty) * num(l.price), s.amountDecimals);
      total += amount;
      rows.push([name, String(num(l.qty)), String(num(l.price)), amount.toFixed(s.amountDecimals)]);
    } else if (kind === "issue") {
      const bal = it ? it.bal.qty : 0;
      rows.push([name, String(num(l.qty)), String(bal), num(l.qty) > bal ? say(ctx, "voucher.short") : ""]);
    } else {
      const bookQty = l.book !== undefined && st.audited ? num(l.book) : it ? it.bal.qty : 0;
      const diff = round(num(l.actual) - bookQty, s.qtyDecimals);
      rows.push([name, String(bookQty), String(num(l.actual)), diff > 0 ? `+${diff}` : String(diff)]);
    }
  }
  if (rows.length) {
    const cols = kind === "receipt" ? ["item", "qty", "price", "amount"] : kind === "issue" ? ["item", "qty", "balance", "note"] : ["item", "book", "actual", "diff"];
    // A small Markdown table: it takes the room it needs below the form.
    view.push({ type: "text", id: "worked", format: "markdown", text: mdTable(cols.map((c) => say(ctx, `col.${c}`)), rows) });
    if (kind === "receipt") view.push({ type: "text", id: "total", text: say(ctx, "voucher.total", { amount: round(total, s.amountDecimals).toFixed(s.amountDecimals) }) });
  }
  // Posted: what went into the ledger (prices of issues by the costing method).
  if (st.posted && book) {
    const posted = await postedLinesOf(ctx, res.id, lines);
    if (posted.length) view.push({ type: "text", id: "posted", format: "markdown", text: mdTable(["item", "in", "out", "balance"].map((c) => say(ctx, `col.posted.${c}`)), posted) });
  }
  if (res.id && !st.posted) view.push({ type: "form", id: "sign", layout: "strip", fields: [await signerField(ctx), ...(st.audited ? [{ name: "reason", label: ctx.t("field.reason"), kind: "text", param: true }] : [])] });
  return { view, readOnly: st.stamps > 0 || undefined };
}

async function postedLinesOf(ctx, voucherId, lines) {
  const out = [];
  for (const id of new Set(lines.map((l) => l.item).filter(Boolean))) {
    let item;
    try {
      item = await ctx.host.resources.get(id);
    } catch {
      continue;
    }
    if (!item) continue;
    for (const sh of await sheetsOf(ctx, item))
      for (const l of sh.lines)
        if (l.voucher === voucherId) out.push([item.name, l.inQty ? `${l.inQty} × ${l.inPrice} = ${l.inAmount}` : "", l.outQty ? `${l.outQty} × ${l.outPrice} = ${l.outAmount}` : "", `${l.balQty} / ${l.balAmount}`]);
  }
  return out;
}

async function signerField(ctx) {
  const f = { name: "signer", label: ctx.t("field.signer"), kind: "text", param: true };
  try {
    const found = await ctx.host.params.get(say(ctx, "env.signer"));
    if (found && found.found) {
      f.envValue = String(found.value);
      f.envSource = found.sourceName;
    }
  } catch {
    // no environment
  }
  return f;
}

async function signerOf(ctx) {
  const typed = str(ctx.params && ctx.params.signer).trim();
  if (typed) return typed;
  try {
    const f = await ctx.host.params.get(say(ctx, "env.signer"));
    return f && f.found ? str(f.value).trim() : "";
  } catch {
    return "";
  }
}

function unsaved(ctx) {
  const saved = (ctx.resource && ctx.resource.body) || {};
  return Object.entries(ctx.draft || {}).some(([k, v]) => k.startsWith("body.") && JSON.stringify(v ?? "") !== JSON.stringify(saved[k.slice(5)] ?? ""));
}

/** “Audit”: checked, then signed (the voucher is fixed from now on). */
async function audit(ctx) {
  const res = ctx.resource;
  const kind = shortKind(res);
  const st = stateOf(ctx, res);
  if (st.audited) return { message: ctx.t("audit.already") };
  if (unsaved(ctx)) return { message: ctx.t("audit.saveFirst") };
  const signer = await signerOf(ctx);
  if (!signer) return { message: ctx.t("audit.noSigner") };
  const body = res.body || {};
  const book = await bookAbove(ctx, res.id);
  if (!book) return { message: ctx.t("voucher.alone") };
  const s = await setupOf(ctx, book.id);
  if (!str(body.date)) return { message: ctx.t("audit.noDate") };
  if (s.closed.includes(monthOf(body.date))) return { message: say(ctx, "audit.closed", { month: monthOf(body.date) }) };
  const lines = linesOf(body);
  if (lines.length === 0) return { message: ctx.t("audit.noLines") };
  const items = await itemsById(ctx, lines.map((l) => l.item), s);
  const bad = [];
  lines.forEach((l, i) => {
    if (!items.has(l.item)) bad.push(say(ctx, "audit.lineNoItem", { n: i + 1 }));
    else if (kind !== "count" && (body.reverses ? num(l.qty) === 0 : num(l.qty) <= 0)) bad.push(say(ctx, "audit.lineQty", { n: i + 1 }));
    else if (kind === "count" && (str(l.actual) === "" || num(l.actual) < 0)) bad.push(say(ctx, "audit.lineActual", { n: i + 1 }));
  });
  if (bad.length) return { message: bad.join("；") };
  if (kind === "issue" && !body.reverses && !(ctx.params && ctx.params["view.force"] === "1")) {
    const need = new Map();
    for (const l of lines) need.set(l.item, (need.get(l.item) || 0) + num(l.qty));
    const short = [...need].filter(([id, q]) => q > items.get(id).bal.qty).map(([id, q]) => say(ctx, "audit.shortItem", { name: items.get(id).res.name, qty: q, bal: items.get(id).bal.qty }));
    if (short.length) return { params: { "view.force": "1" }, message: say(ctx, "audit.short", { list: short.join("、") }) };
  }
  // A stocktake keeps the book quantity it was counted against.
  if (kind === "count" && !body.reverses) await ctx.host.resources.update(res.id, { "body.lines": lines.map((l) => ({ ...l, book: items.get(l.item).bal.qty })) });
  await ctx.host.resources.stamp(res.id, { label: say(ctx, "stamp.audit"), signer });
  return { params: { "view.force": "" }, message: say(ctx, "audit.done", { signer }) };
}

async function revise(ctx) {
  const st = stateOf(ctx, ctx.resource);
  if (st.posted) return { message: ctx.t("revise.posted") };
  if (!st.audited) return { message: ctx.t("revise.notAudited") };
  const reason = str(ctx.params && ctx.params.reason).trim();
  if (!reason) return { message: ctx.t("revise.noReason") };
  await ctx.host.resources.unstamp(ctx.resource.id, { reason });
  return { params: { reason: "" }, message: ctx.t("revise.done") };
}

/** “Reverse”: a red voucher that takes a posted one back, opened to be audited and posted. */
async function reverse(ctx) {
  const res = ctx.resource;
  const st = stateOf(ctx, res);
  if (!st.posted) return { message: ctx.t("reverse.notPosted") };
  if (st.reversed) return { message: ctx.t("reverse.already") };
  if (res.body && res.body.reverses) return { message: ctx.t("reverse.ofReversal") };
  const kind = shortKind(res);
  // A stocktake is taken back by swapping what was counted and what the book said.
  const lines = linesOf(res.body).map((l) => (kind === "count" ? { item: l.item, actual: num(l.book), book: num(l.actual) } : { ...l, qty: -num(l.qty), ...(l.amount !== undefined && str(l.amount) !== "" ? { amount: -num(l.amount) } : {}) }));
  const made = await ctx.host.resources.create({
    kind,
    parent: res.parentId || undefined,
    name: say(ctx, "reverse.name", { name: res.name }),
    body: { date: today(), no: "", handler: str(res.body.handler), party: str(res.body.party), summary: say(ctx, "reverse.summary", { no: str(res.body.no) }), lines, reverses: res.id, reversesNo: str(res.body.no) },
  });
  await ctx.host.ui.open(`resource:${made.id}`);
  return { message: ctx.t("reverse.made") };
}

export async function voucherEvent(ctx, event) {
  if (event === "audit") return audit(ctx);
  if (event === "revise") return revise(ctx);
  if (event === "reverse") return reverse(ctx);
  throw new Error(`unknown event ${event}`);
}

/** The amount each line of an issue went out at, from the ledger pages (to take it back at the same price). */
async function issuedAmounts(ctx, voucherId, lines) {
  const out = new Map();
  for (const id of new Set(lines.map((l) => l.item))) {
    const item = await ctx.host.resources.get(id);
    if (!item) continue;
    const list = [];
    for (const sh of await sheetsOf(ctx, item)) for (const l of sh.lines) if (l.voucher === voucherId) list.push(l);
    out.set(id, list);
  }
  return out;
}

function words(ctx) {
  return {
    opening: say(ctx, "line.opening"),
    carried: say(ctx, "line.carried"),
    forward: say(ctx, "line.forward"),
    pageName: (n) => say(ctx, "sheet.name", { n }),
  };
}

/** “Post” (a run): every line into its item's pages, all or nothing; the voucher gets its “posted” stamp. */
export async function postAction(ctx) {
  const res = ctx.resource;
  const fail = (key, vars) => {
    const text = say(ctx, key, vars);
    return { output: { type: "text", text }, failed: { message: text } };
  };
  const st = stateOf(ctx, res);
  if (!st.audited) return fail("post.notAudited");
  if (st.posted) return fail("post.already");
  const book = await bookAbove(ctx, res.id);
  if (!book) return fail("voucher.alone");
  const s = await setupOf(ctx, book.id);
  const body = res.body || {};
  if (s.closed.includes(monthOf(body.date))) return fail("audit.closed", { month: monthOf(body.date) });
  const kind = shortKind(res);
  const lines = linesOf(body);
  const signer = (await signerOf(ctx)) || say(ctx, "post.someone");
  const reversed = body.reverses ? await issuedAmounts(ctx, body.reverses, lines) : null;
  const pending = newPending();
  const w = words(ctx);
  try {
    // Lines of one item go in one after another, in the voucher's order.
    const byItem = new Map();
    lines.forEach((l) => byItem.set(l.item, [...(byItem.get(l.item) || []), l]));
    for (const [id, ls] of byItem) {
      const item = await ctx.host.resources.get(id);
      if (!item) throw new Error(say(ctx, "post.noItem"));
      let bal = balanceOf(item, s);
      pending.items.set(id, item.body && item.body.bal ? item.body.bal : null);
      const opening = { date: str(s.started) || str(body.date), bal };
      const out = [];
      const takenBack = reversed ? (reversed.get(id) || []).slice() : null;
      for (const l of ls) {
        const base = { type: "line", date: str(body.date), no: str(body.no), voucher: res.id, summary: str(body.summary) || say(ctx, `kind.${kind}`) };
        if (kind === "receipt") {
          const qty = num(l.qty);
          const amount = str(l.amount) !== "" ? num(l.amount) : round(qty * num(l.price), s.amountDecimals);
          bal = takeIn(bal, qty, amount, s);
          out.push({ ...base, inQty: qty, inPrice: qty ? round(amount / qty, 4) : 0, inAmount: amount, balQty: bal.qty, balAmount: bal.amount, balPrice: bal.qty ? round(bal.amount / bal.qty, 4) : 0 });
        } else if (kind === "issue") {
          const qty = num(l.qty);
          const orig = takenBack ? takenBack.shift() : null;
          const r = sendOut(bal, qty, s, orig ? -num(orig.outAmount) : undefined);
          bal = r.bal;
          out.push({ ...base, outQty: qty, outPrice: r.price, outAmount: r.amount, balQty: bal.qty, balAmount: bal.amount, balPrice: bal.qty ? round(bal.amount / bal.qty, 4) : 0 });
        } else {
          const diff = round(num(l.actual) - num(l.book), s.qtyDecimals);
          if (diff === 0) continue;
          const summary = say(ctx, diff > 0 ? "line.gain" : "line.loss");
          if (diff > 0) {
            const price = bal.qty ? bal.amount / bal.qty : num(item.body && item.body.openPrice);
            const amount = round(diff * price, s.amountDecimals);
            bal = takeIn(bal, diff, amount, s);
            out.push({ ...base, summary, inQty: diff, inPrice: round(price, 4), inAmount: amount, balQty: bal.qty, balAmount: bal.amount, balPrice: bal.qty ? round(bal.amount / bal.qty, 4) : 0 });
          } else {
            const r = sendOut(bal, -diff, s);
            bal = r.bal;
            out.push({ ...base, summary, outQty: -diff, outPrice: r.price, outAmount: r.amount, balQty: bal.qty, balAmount: bal.amount, balPrice: bal.qty ? round(bal.amount / bal.qty, 4) : 0 });
          }
        }
      }
      await writeLines(ctx, item, out, w, pending, opening);
      await ctx.host.resources.update(id, { "body.bal": bal });
    }
    await ctx.host.resources.stamp(res.id, { label: say(ctx, "stamp.posted"), signer });
  } catch (e) {
    await undo(ctx, pending);
    return fail("post.failed", { error: String((e && e.message) || e) });
  }
  // A reversing voucher posted: the one it takes back is marked.
  if (body.reverses) {
    try {
      await ctx.host.resources.stamp(body.reverses, { label: say(ctx, "stamp.reversed"), signer });
    } catch {
      // already marked
    }
  }
  return { output: { type: "text", text: say(ctx, "post.done", { n: lines.length }) } };
}

/** A new voucher gets the next number of its kind for its month (RK-202611-001). */
export async function numberVoucher(ctx, event) {
  if (!event || event.change !== "created" || !VOUCHERS.some((k) => event.kind === full(k))) return;
  const v = await ctx.host.resources.get(event.id);
  if (!v || str(v.body && v.body.no)) return;
  const kind = shortKind(v);
  const date = str(v.body && v.body.date) || today();
  const book = await bookAbove(ctx, v.id);
  const c = book ? await contentsOf(ctx, book.id) : { [kind]: [] };
  const prefix = `${PREFIX[kind]}-${date.slice(0, 4)}${date.slice(5, 7)}-`;
  let n = 0;
  for (const node of c[kind] || []) {
    if (node.id === v.id) continue;
    const other = await ctx.host.resources.get(node.id);
    const no = str(other && other.body && other.body.no);
    if (no.startsWith(prefix)) n = Math.max(n, num(no.slice(prefix.length)));
  }
  await ctx.host.resources.update(v.id, { "body.no": `${prefix}${String(n + 1).padStart(3, "0")}`, ...(str(v.body && v.body.date) ? {} : { "body.date": date }) });
}
