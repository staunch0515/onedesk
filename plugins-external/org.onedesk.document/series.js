// The series (系列, docs/redesign/book.md §23.6): in a book (a patient's file), many documents written from one template
// — the progress notes — kept in order (by when they were written, or by one of their items) and added one more at a
// time. In the book it is a container: the contents reads what is in it.

import { full, say, str } from "./common.js";
import { DOCUMENT, stateOf } from "./doc.js";

export const SERIES = full("series");

function sortKey(doc, order) {
  if (!order) return String(doc.createdAt ?? "").padStart(16, "0");
  return str(doc.body && doc.body[`v.${order}`]);
}

async function docsOf(ctx, seriesId) {
  return (await ctx.host.resources.list({ kind: "document", parent: seriesId })) || [];
}

export async function renderSeries(ctx) {
  const s = ctx.resource || {};
  const view = [
    {
      type: "form",
      id: "series",
      layout: "strip",
      fields: [
        { name: "template", label: ctx.t("field.template"), kind: "ref", kinds: ["template"], bind: "body.template" },
        { name: "order", label: ctx.t("field.order"), kind: "text", bind: "body.order", hint: ctx.t("field.order.hint") },
      ],
    },
  ];
  if (!s.id) return { view };
  const kids = await ctx.host.resources.tree(s.id, { limit: 2000 });
  const rows = [];
  const targets = [];
  for (const n of kids.nodes.filter((x) => x.depth === 1 && x.kind === DOCUMENT)) {
    const d = await ctx.host.resources.get(n.id);
    const st = stateOf(ctx, d);
    rows.push([d.name, st.voided ? say(ctx, "status.void") : st.signed.length === 0 ? say(ctx, "status.draft") : st.done ? say(ctx, "status.done") : say(ctx, "status.waiting", { level: st.next })]);
    targets.push(`resource:${d.id}`);
  }
  if (rows.length === 0) view.push({ type: "text", id: "empty", text: say(ctx, "series.empty"), tone: "muted" });
  else view.push({ type: "table", id: "docs", columns: [{ key: "name", label: say(ctx, "col.document") }, { key: "state", label: say(ctx, "col.state") }], rows, rowTargets: targets });
  return { view };
}

/** “Add one”: a document from the series' template, in the series, opened. */
export async function seriesEvent(ctx, event) {
  if (event !== "add") throw new Error(`unknown event ${event}`);
  const s = ctx.resource;
  const tplId = s.body && s.body.template;
  if (!tplId) return { message: ctx.t("series.noTemplate") };
  const tpl = await ctx.host.resources.get(tplId);
  if (!tpl) return { message: ctx.t("series.noTemplate") };
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const name = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${tpl.name}`;
  const made = await ctx.host.resources.create({ kind: "document", parent: s.id, name, body: { template: tpl.id, text: str(tpl.body && tpl.body.text), levels: str(tpl.body && tpl.body.levels), templateRev: tpl.rev ?? null } });
  await ctx.host.ui.open(`resource:${made.id}`);
  return undefined;
}

/** Binding: a document lands where its order puts it. */
export async function placeInSeries(ctx, ask) {
  const s = ctx.resource;
  const order = str(s.body && s.body.order).trim();
  const node = (ask && ask.node) || {};
  if (node.kind !== DOCUMENT) return { refuse: ctx.t("series.onlyDocuments") };
  if (!node.id) return { before: null };
  const me = await ctx.host.resources.get(node.id);
  const key = sortKey(me, order);
  const kids = (await docsOf(ctx, s.id)).filter((d) => d.id !== node.id);
  for (const d of kids) if (sortKey(d, order) > key) return { before: d.id };
  return { before: null };
}

/** A document's ordering item changed: it moves to its place in the series. */
export async function keepInOrder(ctx, event) {
  if (!event || event.kind !== DOCUMENT || (event.change !== "updated" && event.change !== "created")) return;
  let d;
  try {
    d = await ctx.host.resources.get(event.id);
  } catch {
    return;
  }
  if (!d || !d.parentId) return;
  let s;
  try {
    s = await ctx.host.resources.get(d.parentId);
  } catch {
    return;
  }
  if (!s || s.kind !== SERIES || !str(s.body && s.body.order).trim()) return;
  const order = str(s.body.order).trim();
  const kids = (await ctx.host.resources.tree(s.id, { limit: 2000 })).nodes.filter((n) => n.depth === 1);
  const docs = [];
  for (const n of kids) docs.push(await ctx.host.resources.get(n.id));
  const i = docs.findIndex((x) => x.id === d.id);
  const sorted = docs.slice().sort((a, b) => (sortKey(a, order) < sortKey(b, order) ? -1 : sortKey(a, order) > sortKey(b, order) ? 1 : 0));
  const j = sorted.findIndex((x) => x.id === d.id);
  if (j === i) return;
  const after = sorted[j + 1];
  await ctx.host.resources.move(d.id, after ? { before: after.id } : { parent: s.id });
}
