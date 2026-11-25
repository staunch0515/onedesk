// The appendix (附录, docs/redesign/book.md §3.5, §13.7): a part at the back of the book holding pages like a chapter.
// It is numbered A, B, C — what it declares in its role; the contents puts the letters on.

import { bookOf, entriesOf, settingsOf, TOC } from "./toc.js";
import { say } from "./words.js";

/** Its title as the book's contents numbers it ("Appendix A  Tables"), and what is in it. */
export async function renderAppendix(ctx) {
  const me = ctx.resource;
  const book = await bookOf(ctx, me);
  if (!book) return { view: [{ type: "text", id: "alone", text: say(ctx, "appendix.alone"), tone: "muted" }] };
  const kids = await ctx.host.resources.tree(book.id, { limit: 2000 });
  const tocNode = kids.nodes.find((n) => n.depth === 1 && n.kind === TOC);
  let body = null;
  if (tocNode) {
    const t = await ctx.host.resources.get(tocNode.id);
    body = t && t.body;
  }
  const { items } = await entriesOf(ctx, book.id, settingsOf(ctx, body, null));
  const i = items.findIndex((x) => x.key === me.id);
  const view = [{ type: "text", id: "title", text: `## ${i >= 0 ? items[i].title : me.name}`, format: "markdown" }];
  const inside = [];
  for (let j = i + 1; i >= 0 && j < items.length && items[j].level > items[i].level; j++) inside.push(items[j]);
  if (inside.length === 0) {
    view.push({ type: "text", id: "empty", text: say(ctx, "appendix.empty"), tone: "muted" });
    return { view };
  }
  view.push({
    type: "table",
    id: "pages",
    columns: [{ key: "title", label: say(ctx, "appendix.column") }],
    rows: inside.map((x) => [`${"　".repeat(Math.max(0, x.level - items[i].level - 1))}${x.title}`]),
    rowTargets: inside.map((x) => (x.resource ? `resource:${x.resource}` : null)),
  });
  return { view };
}
