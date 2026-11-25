// The list of figures (图表目录, docs/redesign/book.md §3.7, §15.6): the book's figures and tables with their numbers
// and captions, and the chapter each is in — what the contents counted while numbering.

import { contentsOf, whereOf } from "./toc.js";
import { say } from "./words.js";

async function view(ctx) {
  const contents = ctx.resource && ctx.resource.id ? await contentsOf(ctx, ctx.resource) : null;
  if (!contents) return [{ type: "text", id: "alone", text: say(ctx, "figures.alone"), tone: "muted" }];
  const out = [];
  for (const type of ["figure", "table"]) {
    const list = contents.figures.filter((f) => f.type === type);
    if (list.length === 0) continue;
    out.push({ type: "text", id: `${type}Title`, text: `**${say(ctx, type === "figure" ? "figures.figures" : "figures.tables")}**`, format: "markdown" });
    out.push({
      type: "table",
      id: type,
      columns: [
        { key: "number", label: say(ctx, "figures.column.number") },
        { key: "caption", label: say(ctx, "figures.column.caption") },
        { key: "where", label: say(ctx, "figures.column.where") },
      ],
      rows: list.map((f) => [`${say(ctx, type === "figure" ? "caption.figure" : "caption.table")} ${f.number}`, f.caption, whereOf(contents, f.item)]),
      rowTargets: list.map((f) => {
        const it = contents.items.find((x) => x.key === f.item);
        return it && it.resource ? `resource:${it.resource}` : null;
      }),
    });
  }
  if (out.length === 0) out.push({ type: "text", id: "empty", text: say(ctx, "figures.empty"), tone: "muted" });
  return out;
}

export async function renderFigures(ctx) {
  return { view: await view(ctx) };
}

export async function embedFigures(ctx) {
  return { view: await view(ctx) };
}
