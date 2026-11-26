// What an AI reads of a book (docs/redesign/book.md §29.4): its contents with each page's number and role, one page as
// it stands in the book, and the book's references. Only what the user let AI see reaches this code (the kernel
// filters every read of an AI's run); these tools read and never write — changes go through the tool `propose`.

import { allNodes, roleFinder, split } from "./roles.js";
import { outlineOf, TEXT_KINDS } from "./text-page.js";
import { BOOK, contentsOfBook } from "./toc.js";
import { entriesUnder, REFERENCES } from "./references.js";
import { say } from "./words.js";
import { checkForAi, conventionsForAi } from "./conventions.js";

/** Longest text of one answer (the kernel cuts what is longer and says so). */
const MAX_TEXT = 60000;

const out = (data) => ({ output: { type: "text", text: JSON.stringify(data, null, 1).slice(0, MAX_TEXT) } });

/** The roles this book knows, each in a sentence: what the page is for and whether one edits it. */
const ROLES = ["book", "cover", "toc", "preface", "body", "group", "afterword", "appendix", "references", "reference", "index", "figures", "colophon", "conventions"];

function roleWords(ctx, used) {
  const words = {};
  for (const r of ROLES) if (used.has(r)) words[r] = say(ctx, `ai.role.${r}`);
  for (const r of used) if (!words[r]) words[r] = say(ctx, "ai.role.other");
  return words;
}

/** One resource, or null when it is not there or not this plugin's to read. */
async function tryGet(ctx, id) {
  try {
    return await ctx.host.resources.get(id);
  } catch {
    return null;
  }
}

/** The book a resource is (or is in): the nearest book up from it, as far as this plugin can read; else null. */
async function bookFor(ctx, id) {
  let r = await tryGet(ctx, id);
  for (let i = 0; r && i < 64; i++) {
    if (r.kind === BOOK) return r;
    r = r.parentId ? await tryGet(ctx, r.parentId) : null;
  }
  return null;
}

const notABook = (ctx) => {
  throw new Error(say(ctx, "ai.notABook"));
};

/** `book_contents`: the reading order, numbered; each item's role, part and resource. */
export async function aiContents(ctx, input) {
  const id = input && typeof input.book === "string" ? input.book : "";
  const book = id ? await bookFor(ctx, id) : null;
  if (!book) return notABook(ctx);
  const nodes = await allNodes(ctx, book.id);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const role = roleFinder(ctx);
  const e = await contentsOfBook(ctx, book.id);
  const used = new Set();
  const entries = [];
  for (let i = 0; i < e.items.length; i++) {
    const x = e.items[i];
    const n = byId.get(x.key);
    const r = n ? await role(n.kind) : { role: "group", part: "body" };
    used.add(r.role);
    entries.push({ number: e.meta[i].full || e.meta[i].number || "", name: e.meta[i].name, level: x.level, id: x.key, kind: n ? n.kind : "", role: r.role, part: r.part, rev: n ? n.rev : undefined });
  }
  // Pages not read in order (the cover, the contents, entries of a list): there all the same.
  const listed = new Set(entries.map((x) => x.id));
  const others = [];
  for (const n of nodes) {
    if (listed.has(n.id)) continue;
    const r = await role(n.kind);
    used.add(r.role);
    others.push({ name: n.name, id: n.id, kind: n.kind, role: r.role, parent: n.parent, rev: n.rev });
  }
  return out({
    book: { id: book.id, name: book.name },
    entries,
    others,
    roles: roleWords(ctx, used),
    figures: e.figures.map((f) => ({ type: f.type, number: f.number, caption: f.caption, page: f.item })),
    // D487 §31: read and kept to before anything is written.
    conventions: await conventionsForAi(ctx, book.id),
    how: say(ctx, "ai.how"),
  });
}

/** `book_page`: one page as it stands in its book — number, role, outline, its text and what readers see. */
export async function aiPage(ctx, input) {
  const id = input && typeof input.id === "string" ? input.id : "";
  // The book given, or found going up (another plugin's page or group is not read here: give the book).
  const book = input && typeof input.book === "string" ? await bookFor(ctx, input.book) : id ? await bookFor(ctx, id) : null;
  const nodes = book ? await allNodes(ctx, book.id) : [];
  const node = nodes.find((n) => n.id === id);
  const own = await tryGet(ctx, id);
  const page = own || (node ? { id: node.id, name: node.name, kind: node.kind, rev: node.rev, body: {} } : null);
  if (!page) throw new Error(say(ctx, "ai.noPage"));
  const r = await roleFinder(ctx)(page.kind);
  let number = "";
  if (book && book.id !== page.id) {
    const e = await contentsOfBook(ctx, book.id);
    const i = e.items.findIndex((x) => x.key === page.id);
    if (i >= 0) number = e.meta[i].full || e.meta[i].number || "";
  }
  const [plugin, short] = split(page.kind);
  const text = page.body && typeof page.body.text === "string" ? page.body.text : null;
  let outline = null;
  if (plugin === "org.onedesk.book" && TEXT_KINDS.includes(short)) outline = outlineOf(text || "");
  let shown = null;
  try {
    const em = await ctx.host.resources.embed(page.id, {});
    shown = em && (em.text !== undefined ? em.text : em.view);
  } catch {
    shown = null;
  }
  return out({
    id: page.id,
    name: page.name,
    kind: page.kind,
    role: r.role,
    roleMeans: roleWords(ctx, new Set([r.role]))[r.role],
    book: book ? { id: book.id, name: book.name } : null,
    number,
    rev: page.rev,
    outline,
    text,
    shown,
  });
}

/** `book_refs`: every cross reference, citation and index term of a book, and which are broken. */
export async function aiRefs(ctx, input) {
  const id = input && typeof input.book === "string" ? input.book : "";
  const book = id ? await bookFor(ctx, id) : null;
  if (!book) return notABook(ctx);
  const nodes = await allNodes(ctx, book.id);
  const name = new Map(nodes.map((n) => [n.id, n.name]));
  const links = [];
  for (const n of nodes) {
    let refs = [];
    try {
      refs = await ctx.host.resources.refs(n.id);
    } catch {
      refs = [];
    }
    for (const x of refs) links.push({ page: n.id, pageName: n.name, text: x.text, to: x.target ? x.target.id : null, toName: x.target ? x.target.name : null, embed: !!x.embed, broken: !x.target });
  }
  const e = await contentsOfBook(ctx, book.id);
  const refsPage = nodes.find((n) => n.kind === REFERENCES);
  const entries = refsPage ? await entriesUnder(ctx, refsPage.id) : new Map();
  const cites = e.cites.map((c) => ({ page: c.item, pageName: name.get(c.item) || "", keys: c.keys, missing: c.keys.filter((k) => !entries.has(k)) }));
  const terms = e.terms.map((t) => ({ page: t.item, pageName: name.get(t.item) || "", term: t.term, sub: t.sub || null }));
  return out({
    book: { id: book.id, name: book.name },
    links,
    cites,
    terms,
    broken: { links: links.filter((l) => l.broken).length, cites: cites.filter((c) => c.missing.length > 0).length },
    references: refsPage ? refsPage.id : null,
  });
}

/** `book_check` (D487 §31.5): the places that use a word the conventions say not to use. */
export async function aiCheck(ctx, input) {
  const id = input && typeof input.book === "string" ? input.book : "";
  const book = id ? await bookFor(ctx, id) : null;
  if (!book) return notABook(ctx);
  return out({ book: { id: book.id, name: book.name }, ...(await checkForAi(ctx, book.id)) });
}
