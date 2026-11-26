// The setup page (账簿启用表), the catalog (存货目录, the ledger's contents), the register of vouchers (单据簿).

import { bodyNow, bookAbove, contentsOf, full, IFACE, PLUGIN, say, setupOf, str } from "./common.js";
import { balanceOf } from "./posting.js";
import { stateOf } from "./voucher.js";
import { stockState } from "./item.js";
import { ROLES } from "./roles.js";

export async function renderSetup(ctx) {
  const res = ctx.resource || {};
  const b = bodyNow(ctx);
  const book = res.id ? await bookAbove(ctx, res.id) : null;
  let posted = false;
  if (book) {
    const c = await contentsOf(ctx, book.id);
    for (const n of c.item) {
      const it = await ctx.host.resources.get(n.id);
      if (it && it.body && it.body.bal) {
        posted = true;
        break;
      }
    }
  }
  const f = (name, kind, extra = {}) => ({ name, label: ctx.t(`field.${name}`), kind, bind: `body.${name}`, ...extra });
  const view = [
    { type: "text", id: "title", text: book ? `**${book.name}**` : say(ctx, "setup.alone"), format: "markdown" },
    {
      type: "form",
      id: "setup",
      layout: "stack",
      fields: [
        f("unitName", "text"),
        f("started", "date"),
        f("method", "enum", { options: ["moving", "fifo"].map((v) => ({ value: v, label: ctx.t(`method.${v}`) })), ...(posted ? { readOnly: true, hint: ctx.t("field.method.locked") } : {}) }),
        f("qtyDecimals", "number"),
        f("amountDecimals", "number"),
        f("keepers", "longtext", { placeholder: ctx.t("field.keepers.placeholder") }),
        f("handover", "longtext", { placeholder: ctx.t("field.handover.placeholder") }),
      ],
    },
  ];
  const closed = Array.isArray(b.closed) ? b.closed : [];
  view.push({ type: "text", id: "closed", text: closed.length ? say(ctx, "setup.closed", { months: closed.join("、") }) : say(ctx, "setup.noneClosed"), tone: "muted" });
  return { view };
}

/** The items of a book with their balances, as table rows. */
async function itemRows(ctx, bookId) {
  const c = await contentsOf(ctx, bookId);
  const s = await setupOf(ctx, bookId);
  const rows = [];
  const targets = [];
  for (const n of c.item) {
    const it = await ctx.host.resources.get(n.id);
    if (!it) continue;
    const bal = balanceOf(it, s);
    const b = it.body || {};
    rows.push([str(b.code), it.name, str(b.spec), str(b.unit), String(bal.qty), bal.amount.toFixed(s.amountDecimals), stockState(ctx, b, bal.qty)]);
    targets.push(`resource:${it.id}`);
  }
  return { rows, targets };
}

export async function renderCatalog(ctx) {
  const res = ctx.resource || {};
  const book = res.id ? await bookAbove(ctx, res.id) : null;
  if (!book) return { view: [{ type: "text", id: "alone", text: say(ctx, "catalog.alone"), tone: "muted" }] };
  const { rows, targets } = await itemRows(ctx, book.id);
  if (rows.length === 0) return { view: [{ type: "text", id: "empty", text: say(ctx, "catalog.empty"), tone: "muted" }] };
  const view = [
    {
      type: "table",
      id: "items",
      columns: ["code", "name", "spec", "unit", "qty", "amount", "state"].map((k) => ({ key: k, label: say(ctx, `catalog.${k}`), numeric: k === "qty" || k === "amount" })),
      rows,
      rowTargets: targets,
    },
  ];
  // Read the whole ledger, numbered by the book's own plugin.
  const plugin = book.kind.slice(0, book.kind.lastIndexOf(":"));
  try {
    const r = await ctx.host.interfaces.call(IFACE, "entries", { book: book.id, roles: { [PLUGIN]: ROLES.kinds } }, { plugin });
    const items = (r && r.data && r.data.items) || [];
    if (items.length && ctx.params && ctx.params["view.mode"] === "read") view.push({ type: "sequence", id: "book", items, toc: true, mode: "scroll" });
  } catch {
    // no reading through
  }
  return { view };
}

export async function catalogEvent(ctx, event) {
  if (event === "toggle") return { params: { "view.mode": ctx.params && ctx.params["view.mode"] === "read" ? "" : "read" } };
  throw new Error(`unknown event ${event}`);
}

export async function catalogEntries(ctx, input) {
  const book = await bookAbove(ctx, ctx.resource.id);
  if (!book) return { items: [] };
  const plugin = book.kind.slice(0, book.kind.lastIndexOf(":"));
  try {
    const r = await ctx.host.interfaces.call(IFACE, "entries", { book: book.id, roles: { [PLUGIN]: ROLES.kinds } }, { plugin });
    const depth = input && Number.isInteger(input.depth) ? input.depth : 0;
    return { items: ((r && r.data && r.data.items) || []).map((x) => ({ ...x, level: Math.min(9, x.level + depth) })) };
  } catch {
    return { items: [] };
  }
}

export async function renderRegister(ctx) {
  const res = ctx.resource || {};
  if (!res.id) return { view: [{ type: "text", id: "new", text: say(ctx, "register.new"), tone: "muted" }] };
  const all = [];
  const walk = async (id) => {
    const r = await ctx.host.resources.tree(id, { limit: 2000 });
    for (const n of r.nodes) if (["receipt", "issue", "count"].some((k) => n.kind === full(k))) all.push(n);
  };
  await walk(res.id);
  const rows = [];
  const targets = [];
  for (const n of all) {
    const v = await ctx.host.resources.get(n.id);
    if (!v) continue;
    const st = stateOf(ctx, v);
    const kind = v.kind.slice(v.kind.lastIndexOf(":") + 1);
    rows.push([str(v.body.date), str(v.body.no), say(ctx, `kind.${kind}`), str(v.body.summary), st.reversed ? say(ctx, "status.reversed") : st.posted ? say(ctx, "status.posted") : st.audited ? say(ctx, "status.audited") : say(ctx, "status.draft")]);
    targets.push(`resource:${v.id}`);
  }
  if (rows.length === 0) return { view: [{ type: "text", id: "empty", text: say(ctx, "register.empty"), tone: "muted" }] };
  return { view: [{ type: "table", id: "vouchers", columns: ["date", "no", "kind", "summary", "state"].map((k) => ({ key: k, label: say(ctx, `register.${k}`) })), rows, rowTargets: targets }] };
}
