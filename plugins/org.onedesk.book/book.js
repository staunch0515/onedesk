// The book (书, docs/redesign/book.md §2, §13.2): it only binds — which pages it has, in what order, and what role
// each plays. How it is read, numbered or shown is up to the pages that play those roles: opening the book shows its
// cover; reading it is its contents.

import { allNodes, full, PART_RANK, roleFinder } from "./roles.js";
import { chapterOf, entriesOf, settingsOf } from "./toc.js";
import { say } from "./words.js";

export const COVER = full("cover");
export const TOC_KIND = full("toc");

/** The pages directly in the book (depth 1). */
async function topPages(ctx, bookId) {
  return (await allNodes(ctx, bookId)).filter((n) => n.depth === 1);
}

/**
 * Binding (§13.2): where a page dropped into the book lands — within its own part (not read → front → body → back), as
 * near as can be to where it was dropped; a second cover or contents is refused.
 */
export async function place(ctx, ask) {
  const role = roleFinder(ctx);
  const node = ask && ask.node ? ask.node : {};
  const siblings = (await topPages(ctx, ctx.resource.id)).filter((n) => n.id !== node.id);
  const mine = await role(node.kind);
  const ranks = [];
  for (const s of siblings) {
    const r = await role(s.kind);
    if (mine.single && r.role === mine.role) {
      const key = mine.role === "toc" ? "place.hasToc" : mine.role === "cover" ? "place.hasCover" : "place.hasOne";
      return { refuse: ctx.t(key) };
    }
    ranks.push(PART_RANK[r.part] ?? PART_RANK.body);
  }
  const rank = PART_RANK[mine.part] ?? PART_RANK.body;
  let lo = 0;
  ranks.forEach((x, i) => {
    if (x < rank) lo = i + 1;
  });
  let hi = ranks.length;
  for (let i = ranks.length - 1; i >= 0; i--) if (ranks[i] > rank) hi = i;
  if (hi < lo) hi = lo;
  const asked = ask && ask.before ? siblings.findIndex((s) => s.id === ask.before) : -1;
  const want = asked >= 0 ? asked : siblings.length;
  const at = Math.min(Math.max(want, lo), hi);
  return { before: at < siblings.length ? siblings[at].id : null };
}

/** A new book gets the two pages every book has: a cover and a contents. */
export async function onBookCreated(ctx, event) {
  if (!event || event.change !== "created" || event.kind !== full("book")) return;
  await ctx.host.resources.create({ kind: "cover", parent: event.id });
  await ctx.host.resources.create({ kind: "toc", parent: event.id });
}

/** The cover of a book shown as the book's face: one item (the title) whose content is the cover's own. */
function coverView(book, cover) {
  return { type: "sequence", id: "cover", items: [{ key: "cover", title: book.name, level: 1, resource: cover.id }] };
}

/** Opening the book: its cover, and the way into reading it (its contents, where the reader left off). */
export async function renderBook(ctx) {
  const book = ctx.resource;
  // Not saved yet: its cover and contents come once it is.
  if (!book || !book.id) return { view: [{ type: "text", id: "unsaved", text: say(ctx, "book.unsaved"), tone: "muted" }] };
  const pages = await topPages(ctx, book.id);
  const cover = pages.find((n) => n.kind === COVER);
  // Whichever page plays the contents (this plugin's, or another's such as a textbook's).
  const role = roleFinder(ctx);
  let toc = null;
  for (const n of pages) if ((await role(n.kind)).role === "toc") {
    toc = n;
    break;
  }
  const view = [];
  if (toc) {
    const pos = await ctx.host.storage.get(`pos:${toc.id}`);
    view.push({ type: "link", id: "read", label: ctx.t(typeof pos === "string" && pos ? "book.continue" : "book.start"), target: `resource:${toc.id}` });
  } else {
    view.push({ type: "text", id: "noToc", text: say(ctx, "book.noToc"), tone: "muted" });
  }
  view.push(cover ? coverView(book, cover) : { type: "text", id: "title", text: `# ${book.name}`, format: "markdown" });
  return { view };
}

/** `![[book]]` shows its cover; `![[book#chapter]]` that chapter, read through (the contents finds it). */
export async function embedBook(ctx, ask) {
  const book = ctx.resource;
  const pages = await topPages(ctx, book.id);
  const section = ask && typeof ask.section === "string" && ask.section ? ask.section : null;
  if (!section) {
    const cover = pages.find((n) => n.kind === COVER);
    return { view: [cover ? coverView(book, cover) : { type: "text", id: "title", text: book.name }] };
  }
  const tocNode = pages.find((n) => n.kind === TOC_KIND);
  let body = null;
  if (tocNode) {
    const t = await ctx.host.resources.get(tocNode.id);
    body = t && t.body;
  }
  const entries = await entriesOf(ctx, book.id, settingsOf(ctx, body, null));
  const items = chapterOf(entries, section);
  if (!items) return { view: [], sectionMissing: true };
  return { view: [{ type: "sequence", id: "chapter", items }] };
}
