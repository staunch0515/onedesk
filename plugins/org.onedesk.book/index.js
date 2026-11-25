// The index (索引, docs/redesign/book.md §3.7, §15.4): the terms marked in the pages (`{{索引:term}}`,
// `{{索引:main/sub}}`), sorted for the reader's language (pinyin for Chinese), each with where it is in the book.

import { contentsOf, whereOf } from "./toc.js";
import { say } from "./words.js";

/** Rows of the index: a main term, then its sub-terms indented; each with the places (once each), and the first place opened. */
export async function indexRows(ctx, contents) {
  const groups = new Map();
  for (const t of contents.terms) {
    if (!groups.has(t.term)) groups.set(t.term, { items: [], subs: new Map() });
    const g = groups.get(t.term);
    const list = t.sub ? (g.subs.has(t.sub) ? g.subs.get(t.sub) : g.subs.set(t.sub, []).get(t.sub)) : g.items;
    if (!list.includes(t.item)) list.push(t.item);
  }
  const sorted = async (names) => (await ctx.host.util.collate(names, ctx.locale || "en-US")).map((i) => names[i]);
  const rows = [];
  const targets = [];
  const place = (items) => items.map((k) => whereOf(contents, k)).join("、");
  const open = (items) => {
    const it = contents.items.find((x) => x.key === items[0]);
    return it && it.resource ? `resource:${it.resource}` : null;
  };
  for (const term of await sorted([...groups.keys()])) {
    const g = groups.get(term);
    rows.push([term, place(g.items)]);
    targets.push(g.items.length > 0 ? open(g.items) : null);
    for (const sub of await sorted([...g.subs.keys()])) {
      rows.push([`　${sub}`, place(g.subs.get(sub))]);
      targets.push(open(g.subs.get(sub)));
    }
  }
  return { rows, targets };
}

async function view(ctx) {
  const contents = ctx.resource && ctx.resource.id ? await contentsOf(ctx, ctx.resource) : null;
  if (!contents) return [{ type: "text", id: "alone", text: say(ctx, "index.alone"), tone: "muted" }];
  const { rows, targets } = await indexRows(ctx, contents);
  if (rows.length === 0) return [{ type: "text", id: "empty", text: say(ctx, "index.empty"), tone: "muted" }];
  return [
    {
      type: "table",
      id: "index",
      columns: [
        { key: "term", label: say(ctx, "index.column.term") },
        { key: "where", label: say(ctx, "index.column.where") },
      ],
      rows,
      rowTargets: targets,
    },
  ];
}

export async function renderIndex(ctx) {
  return { view: await view(ctx) };
}

export async function embedIndex(ctx) {
  return { view: await view(ctx) };
}
