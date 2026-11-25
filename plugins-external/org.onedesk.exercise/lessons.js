// The textbook contents (课本目录, docs/redesign/book.md §19.10): another contents — reads the book the same way, its
// numbers asked of the book's own plugin (by book), each lesson marked with the reader's progress.

import { attemptsOf, full, IFACE, PLUGIN, say } from "./common.js";
import { ROLES } from "./roles.js";
import { standing } from "./test.js";

export const LESSONS = full("lessons");

async function bookOf(ctx, res) {
  if (!res || !res.parentId) return null;
  try {
    const r = await ctx.host.resources.search({ ids: [res.parentId] });
    const info = (Array.isArray(r) ? r : r.items || [])[0];
    return info ? { id: info.id, name: info.name, kind: info.kind } : null;
  } catch {
    return null;
  }
}

/** The book's numbered items, as its own plugin numbers them; null when the parent is no book. */
export async function entriesOfBook(ctx, book) {
  if (!book) return null;
  const plugin = book.kind.slice(0, book.kind.lastIndexOf(":"));
  try {
    // Our own roles go along: the book's plugin must not ask them back (a call cycle).
    const r = await ctx.host.interfaces.call(IFACE, "entries", { book: book.id, roles: { [PLUGIN]: ROLES.kinds } }, { plugin });
    return r && r.data && Array.isArray(r.data.items) ? r.data : null;
  } catch {
    return null;
  }
}

/** How far the reader is with a practice (right of all) or a test (the score that counts). */
export async function progressOf(ctx, id) {
  let res;
  try {
    res = await ctx.host.resources.get(id);
  } catch {
    return "";
  }
  if (!res) return "";
  if (res.kind === full("practice")) {
    const a = (await attemptsOf(ctx, id))[0];
    if (!a) return "";
    const r = Object.values(a.body.results || {});
    const right = r.filter((x) => x.state === "right").length;
    return r.length > 0 && right === r.length ? say(ctx, "progress.allRight") : say(ctx, "progress.some", { right, of: r.length });
  }
  if (res.kind === full("test")) {
    const st = await standing(ctx, res);
    return st.counts ? say(ctx, "progress.score", { score: st.counts.body.score }) : say(ctx, "progress.notYet");
  }
  return "";
}

/** The items with progress after their titles. */
async function withProgress(ctx, items) {
  const out = [];
  for (const it of items) {
    const p = it.resource ? await progressOf(ctx, it.resource) : "";
    out.push(p ? { ...it, title: `${it.title}　· ${p}` } : it);
  }
  return out;
}

export async function renderLessons(ctx) {
  const book = await bookOf(ctx, ctx.resource);
  const e = await entriesOfBook(ctx, book);
  if (!e) return { view: [{ type: "text", id: "alone", text: say(ctx, "lessons.alone"), tone: "muted" }] };
  const items = await withProgress(ctx, e.items);
  if (items.length === 0) return { view: [{ type: "text", id: "empty", text: say(ctx, "lessons.empty"), tone: "muted" }] };
  const pos = await ctx.host.storage.get(`pos:${ctx.resource.id}`);
  const node = { type: "sequence", id: "book", items, toc: true, mode: ctx.params && ctx.params["view.mode"] === "pages" ? "pages" : "scroll", positionEvent: "position" };
  if (typeof pos === "string" && items.some((x) => x.key === pos)) node.start = pos;
  return { view: [node] };
}

export async function lessonsEvent(ctx, event) {
  if (event === "position") {
    if (typeof ctx.row === "string" && ctx.row) await ctx.host.storage.set(`pos:${ctx.resource.id}`, ctx.row);
    return undefined;
  }
  if (event === "toggle") {
    const next = ctx.params && ctx.params["view.mode"] === "pages" ? "scroll" : "pages";
    return { params: { "view.mode": next } };
  }
  throw new Error(`unknown event ${event}`);
}

/** `![[textbook contents]]`: the list with progress. */
export async function embedLessons(ctx) {
  const e = await entriesOfBook(ctx, await bookOf(ctx, ctx.resource));
  if (!e) return { view: [{ type: "text", id: "alone", text: say(ctx, "lessons.alone"), tone: "muted" }] };
  const items = await withProgress(ctx, e.items);
  return { view: [{ type: "text", id: "list", text: items.map((x) => `${"  ".repeat(Math.max(0, x.level - 1))}- ${x.title}`).join("\n"), format: "markdown" }] };
}

/** The interface's `entries` for a textbook contents (a sub-book's): the book's own, with progress. */
export async function lessonsEntries(ctx, input) {
  const e = await entriesOfBook(ctx, await bookOf(ctx, ctx.resource));
  if (!e) return { items: [] };
  const depth = input && Number.isInteger(input.depth) ? input.depth : 0;
  const items = (await withProgress(ctx, e.items)).map((x) => ({ ...x, level: Math.min(9, x.level + depth) }));
  return { items };
}
