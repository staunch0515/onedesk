// Conventions (凡例, docs/redesign/book.md §31): what a book's style is — written by its author as numbered points, a
// table of the words used and those not used, a table of symbols — and what the book itself says of its arrangement
// (numbering by the contents, citations by the references, and what the other roles say through `onedesk.book/1`).
// “Check against the conventions” lists the places that use a word the table says not to use; “Propose changes” turns
// them into one proposal of changes (§29) that the author accepts item by item. People read it; AI reads it first.

import { allNodes, full, GROUP, IFACE, roleFinder, split } from "./roles.js";
import { readable, TEXT_KINDS } from "./text-page.js";
import { appendixText, bookOf, contentsOfBook, numberText, settingsOf, TOC } from "./toc.js";
import { REFERENCES } from "./references.js";
import { say } from "./words.js";

export const CONVENTIONS = full("conventions");
export const MAX_TERMS = 200;
export const MAX_SYMBOLS = 100;
export const MAX_PAGES = 2000;
export const MAX_HITS_PER_PAGE = 100;
export const MAX_ITEMS = 50;
const SNIPPET = 20;
const MAX_LINES = 10;
const MAX_LINE = 200;
const NONE = { type: "none" };

const str = (v) => (typeof v === "string" ? v.trim() : "");

/** The table of words: `{ avoid, use, note }`, the empty ones left out, at most 200. */
export function termsOf(body) {
  const rows = body && Array.isArray(body.terms) ? body.terms : [];
  return rows
    .filter((r) => r && typeof r === "object" && str(r.avoid))
    .slice(0, MAX_TERMS)
    .map((r) => ({ avoid: str(r.avoid), use: str(r.use), note: str(r.note) }));
}

/** The table of symbols: `{ symbol, meaning }`, at most 100. */
export function symbolsOf(body) {
  const rows = body && Array.isArray(body.symbols) ? body.symbols : [];
  return rows
    .filter((r) => r && typeof r === "object" && str(r.symbol))
    .slice(0, MAX_SYMBOLS)
    .map((r) => ({ symbol: str(r.symbol), meaning: str(r.meaning) }));
}

/* ------------------------------------------------------------------ the book's arrangement */

/** The conventions page of a book (its first), or null. */
export async function conventionsOf(ctx, bookId) {
  const kids = await ctx.host.resources.tree(bookId, { limit: 2000 });
  const node = kids.nodes.find((n) => n.depth === 1 && n.kind === CONVENTIONS);
  if (!node) return null;
  try {
    return await ctx.host.resources.get(node.id);
  } catch {
    return null;
  }
}

/** How the contents numbers (the contents' own words: chapters, deeper levels, appendices, figures). */
function numberingLine(ctx, tocBody) {
  const s = settingsOf(ctx, tocBody, null);
  if (s.numbering === "none") return say(ctx, "conv.numbering.none");
  const one = numberText(ctx, s, [1]);
  const two = numberText(ctx, s, [1, 1]);
  const deep = s.numbering === "numbers" ? "1.1.1" : numberText(ctx, s, [1, 1, 1]);
  return say(ctx, "conv.numbering", { first: one, second: two, deep, appendix: appendixText(ctx, s, "A"), figure: `${say(ctx, "caption.figure")} 2-1` });
}

/**
 * What the book says of its own arrangement, line by line: its parts (front, how many chapters, back), how its contents
 * numbers, how its references cite, and what the other roles say of themselves (`conventions`, §31.6).
 */
export async function arrangementOf(ctx, bookId) {
  const nodes = await allNodes(ctx, bookId);
  const role = roleFinder(ctx);
  const lines = [];
  // The parts: the pages right under the book.
  const top = [];
  for (const n of nodes.filter((x) => x.depth === 1)) top.push({ n, r: await role(n.kind) });
  const named = (part) => top.filter((x) => x.r.part === part && x.r.role !== "book").map((x) => x.n.name);
  const chapters = top.filter((x) => x.r.part === "body").length;
  lines.push(say(ctx, "conv.parts", { front: named("front").join(say(ctx, "conv.sep")) || say(ctx, "conv.nothing"), chapters, back: named("back").join(say(ctx, "conv.sep")) || say(ctx, "conv.nothing") }));
  // Numbering: the contents says.
  const toc = top.find((x) => x.n.kind === TOC);
  if (toc) {
    let body = {};
    try {
      const t = await ctx.host.resources.get(toc.n.id);
      body = (t && t.body) || {};
    } catch {
      body = {};
    }
    lines.push(numberingLine(ctx, body));
  }
  // Citations: the references say.
  const refs = nodes.find((x) => x.kind === REFERENCES);
  if (refs) {
    let system = "numeric";
    try {
      const r = await ctx.host.resources.get(refs.id);
      if (r && r.body && r.body.system === "authorYear") system = "authorYear";
    } catch {
      system = "numeric";
    }
    lines.push(say(ctx, `conv.cite.${system}`));
  }
  // The other roles, each asked once (its first page), through the interface.
  const asked = new Set();
  for (const n of nodes) {
    const [plugin] = split(n.kind);
    if (plugin === "org.onedesk.book" || n.kind === GROUP) continue;
    const r = await role(n.kind);
    if (!r.declared) continue;
    const key = `${plugin}/${r.role}`;
    if (asked.has(key)) continue;
    asked.add(key);
    try {
      const out = await ctx.host.interfaces.call(IFACE, "conventions", {}, { resource: n.id });
      const said = out && out.data && Array.isArray(out.data.lines) ? out.data.lines : [];
      for (const l of said.slice(0, MAX_LINES)) {
        const line = typeof l === "string" ? l.trim().slice(0, MAX_LINE) : "";
        if (line && !lines.includes(line)) lines.push(line);
      }
    } catch {
      // Not implemented, or failed: nothing said.
    }
  }
  return lines;
}

/* ------------------------------------------------------------------ the page */

function termsTable(ctx, terms) {
  return { type: "table", id: "termsTable", columns: [{ key: "avoid", label: say(ctx, "conv.col.avoid") }, { key: "use", label: say(ctx, "conv.col.use") }, { key: "note", label: say(ctx, "conv.col.note") }], rows: terms.map((t) => [t.avoid, t.use, t.note]) };
}
function symbolsTable(ctx, symbols) {
  return { type: "table", id: "symbolsTable", columns: [{ key: "symbol", label: say(ctx, "conv.col.symbol") }, { key: "meaning", label: say(ctx, "conv.col.meaning") }], rows: symbols.map((s) => [s.symbol, s.meaning]) };
}
const arrangementText = (ctx, lines) => [`**${say(ctx, "conv.arrangement")}**`, "", ...lines.map((l) => `- ${l}`)].join("\n");

export async function renderConventions(ctx, renderText) {
  const base = await renderText(ctx);
  const view = base.view;
  const res = ctx.resource || {};
  const body = (ctx.draft && Object.keys(ctx.draft).length > 0 ? { ...(res.body || {}), ...Object.fromEntries(Object.entries(ctx.draft).filter(([k]) => k.startsWith("body.")).map(([k, v]) => [k.slice(5), v])) } : res.body) || {};
  const reading = view.some((n) => n.id === "reading");
  if (reading) {
    const terms = termsOf(body);
    const symbols = symbolsOf(body);
    if (terms.length > 0) view.push({ type: "text", id: "termsTitle", text: `**${say(ctx, "conv.terms")}**`, format: "markdown" }, termsTable(ctx, terms));
    if (symbols.length > 0) view.push({ type: "text", id: "symbolsTitle", text: `**${say(ctx, "conv.symbols")}**`, format: "markdown" }, symbolsTable(ctx, symbols));
  } else {
    view.push({
      type: "form",
      id: "tables",
      layout: "stack",
      fields: [
        { name: "terms", label: say(ctx, "conv.terms"), kind: "rows", bind: "body.terms", columns: [{ name: "avoid", label: say(ctx, "conv.col.avoid"), kind: "text" }, { name: "use", label: say(ctx, "conv.col.use"), kind: "text" }, { name: "note", label: say(ctx, "conv.col.note"), kind: "text" }] },
        { name: "symbols", label: say(ctx, "conv.symbols"), kind: "rows", bind: "body.symbols", columns: [{ name: "symbol", label: say(ctx, "conv.col.symbol"), kind: "text" }, { name: "meaning", label: say(ctx, "conv.col.meaning"), kind: "text" }] },
      ],
    });
  }
  const book = res.id ? await bookOf(ctx, res) : null;
  if (book) view.push({ type: "text", id: "arrangement", text: arrangementText(ctx, await arrangementOf(ctx, book.id)), format: "markdown" });
  else if (res.id) view.push({ type: "text", id: "alone", text: say(ctx, "conv.alone"), tone: "muted" });
  return { view };
}

/** Where the conventions are read in their book: the text, the two tables (when not empty), the arrangement. */
export async function embedConventions(ctx) {
  const res = ctx.resource || {};
  const body = res.body || {};
  const view = [{ type: "text", id: "embed", text: readable(ctx, str(body.text) ? body.text : "", null), format: "markdown" }];
  const terms = termsOf(body);
  const symbols = symbolsOf(body);
  if (terms.length > 0) view.push({ type: "text", id: "termsTitle", text: `**${say(ctx, "conv.terms")}**`, format: "markdown" }, termsTable(ctx, terms));
  if (symbols.length > 0) view.push({ type: "text", id: "symbolsTitle", text: `**${say(ctx, "conv.symbols")}**`, format: "markdown" }, symbolsTable(ctx, symbols));
  const book = res.id ? await bookOf(ctx, res) : null;
  if (book) view.push({ type: "text", id: "arrangement", text: arrangementText(ctx, await arrangementOf(ctx, book.id)), format: "markdown" });
  return { view };
}

/** A new conventions page starts from a skeleton of three points, in the user's language. */
export async function onConventionsCreated(ctx, event) {
  if (!event || event.change !== "created" || event.kind !== CONVENTIONS) return;
  const r = await ctx.host.resources.get(event.id);
  if (!r || str(r.body && r.body.text)) return;
  await ctx.host.resources.update(event.id, { "body.text": say(ctx, "conv.skeleton") });
}

/* ------------------------------------------------------------------ checking */

const ASCII = /^[\x20-\x7e]+$/;
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// What is not checked inside a line: inline code, references and embeds, fill-in fields, citation keys.
const SKIP = [/`[^`]*`/g, /!?\[\[[^\]]*\]\]/g, /\{\{[^}]*\}\}/g, /\[@[^\]]*\]/g];
const FENCE = /^\s*(```|~~~)/;

/** Each line with what is not checked blanked out (same length; code blocks entirely). */
function checkable(text) {
  let fence = false;
  return String(text || "")
    .split("\n")
    .map((line) => {
      if (FENCE.test(line)) {
        fence = !fence;
        return " ".repeat(line.length);
      }
      if (fence) return " ".repeat(line.length);
      let out = line;
      for (const re of SKIP) out = out.replace(re, (m) => " ".repeat(m.length));
      return out;
    });
}

/** Where the words not to use stand in one text: `[{ line, start, end, avoid, use }]` (offsets into the whole text). */
export function findTerms(text, terms) {
  const lines = checkable(text);
  const src = String(text || "").split("\n");
  const sorted = [...terms].sort((a, b) => b.avoid.length - a.avoid.length);
  const hits = [];
  let offset = 0;
  lines.forEach((line, i) => {
    const taken = [];
    for (const t of sorted) {
      const re = ASCII.test(t.avoid) ? new RegExp(`(?<![A-Za-z0-9_])${escape(t.avoid)}(?![A-Za-z0-9_])`, "gi") : new RegExp(escape(t.avoid), "g");
      for (const m of line.matchAll(re)) {
        const s = m.index;
        const e = s + m[0].length;
        if (taken.some(([a, b]) => s < b && e > a)) continue;
        taken.push([s, e]);
        hits.push({ line: i + 1, col: s, start: offset + s, end: offset + e, found: src[i].slice(s, e), avoid: t.avoid, use: t.use, text: src[i] });
      }
    }
    offset += src[i].length + 1;
  });
  return hits.sort((a, b) => a.start - b.start);
}

/** The text with every hit replaced by the word to use. */
export function replaceTerms(text, hits) {
  let out = String(text || "");
  for (const h of [...hits].sort((a, b) => b.start - a.start)) if (h.use) out = out.slice(0, h.start) + h.use + out.slice(h.end);
  return out;
}

/** Every page of the book to check (this plugin's text pages, in reading order), with its number. */
async function pagesToCheck(ctx, bookId) {
  const nodes = await allNodes(ctx, bookId);
  const text = new Set(TEXT_KINDS.map(full));
  return nodes.filter((n) => text.has(n.kind)).slice(0, MAX_PAGES);
}

/** The places that break the conventions: `{ terms, pages: [{ id, name, rev, text, hits }] }`; null when there are none. */
export async function checkBook(ctx, bookId) {
  const conv = await conventionsOf(ctx, bookId);
  const terms = termsOf(conv && conv.body);
  const out = { conventions: conv ? conv.id : null, terms, pages: [] };
  if (terms.length === 0) return out;
  // Each page by its number in the book, when it has one (“第一章 一”).
  const numbers = new Map();
  try {
    const e = await contentsOfBook(ctx, bookId);
    e.items.forEach((x, i) => e.meta[i].full && numbers.set(x.key, e.meta[i].full));
  } catch {
    // Unnumbered.
  }
  for (const n of await pagesToCheck(ctx, bookId)) {
    let r = null;
    try {
      r = await ctx.host.resources.get(n.id);
    } catch {
      r = null;
    }
    const text = r && r.body && typeof r.body.text === "string" ? r.body.text : "";
    const hits = findTerms(text, terms).slice(0, MAX_HITS_PER_PAGE);
    if (hits.length > 0) out.pages.push({ id: n.id, name: numbers.has(n.id) ? `${numbers.get(n.id)} ${n.name}` : n.name, rev: r.rev, text, hits });
  }
  return out;
}

const snippet = (h) => {
  const before = h.text.slice(Math.max(0, h.col - SNIPPET), h.col);
  const after = h.text.slice(h.col + h.found.length, h.col + h.found.length + SNIPPET);
  return `${before}【${h.found}】${after}`;
};

/** The hits as rows: page, line, the passage, the word, what to use. */
function hitRows(result) {
  const rows = [];
  for (const p of result.pages) for (const h of p.hits) rows.push([p.name, h.line, snippet(h), h.found, h.use]);
  return rows;
}

async function bookFromConventions(ctx) {
  const res = ctx.resource;
  return res && res.id ? bookOf(ctx, res) : null;
}

/** The action “Check against the conventions”: a table of the places. */
export async function checkAction(ctx) {
  const book = await bookFromConventions(ctx);
  if (!book) throw new Error(say(ctx, "conv.alone"));
  const r = await checkBook(ctx, book.id);
  const rows = hitRows(r);
  const columns = ["page", "line", "passage", "avoid", "use"].map((k) => ({ key: k, label: say(ctx, `conv.col.${k}`) }));
  const message = r.terms.length === 0 ? say(ctx, "conv.noTerms") : rows.length === 0 ? say(ctx, "conv.clean") : say(ctx, "conv.found", { count: rows.length, pages: r.pages.length });
  return { output: { type: "table", columns, rows, total: rows.length }, summary: { message } };
}

/** The action “Propose changes”: one proposal, one item per page (at most 50), each page's text with the words replaced. */
export async function proposeAction(ctx) {
  const book = await bookFromConventions(ctx);
  if (!book) throw new Error(say(ctx, "conv.alone"));
  const r = await checkBook(ctx, book.id);
  const pages = r.pages.filter((p) => p.hits.some((h) => h.use)).slice(0, MAX_ITEMS);
  if (pages.length === 0) return { output: NONE, summary: { message: r.terms.length === 0 ? say(ctx, "conv.noTerms") : say(ctx, "conv.clean") } };
  const used = [...new Map(pages.flatMap((p) => p.hits).filter((h) => h.use).map((h) => [h.avoid, h.use])).entries()];
  const comment = [say(ctx, "conv.fixComment"), ...used.map(([a, u]) => `${a} → ${u}`)].join("\n");
  const items = pages.map((p) => ({ op: "update", id: p.id, rev: p.rev, changes: { "body.text": replaceTerms(p.text, p.hits) } }));
  const made = await ctx.host.proposals.create({ title: say(ctx, "conv.fixTitle"), comment, items });
  return { output: { type: "link", label: say(ctx, "conv.proposalMade", { count: items.length }), target: `resource:${made.id}` }, summary: { message: say(ctx, "conv.proposalMade", { count: items.length }) } };
}

/** For AI (`book_contents`): the conventions of a book as text and tables, and the arrangement; null without them. */
export async function conventionsForAi(ctx, bookId) {
  const conv = await conventionsOf(ctx, bookId);
  if (!conv) return null;
  return { id: conv.id, text: str(conv.body && conv.body.text), terms: termsOf(conv.body), symbols: symbolsOf(conv.body), arrangement: await arrangementOf(ctx, bookId) };
}

/** For AI (`book_check`): the places, without the page texts. */
export async function checkForAi(ctx, bookId) {
  const r = await checkBook(ctx, bookId);
  return { conventions: r.conventions, terms: r.terms, places: r.pages.flatMap((p) => p.hits.map((h) => ({ page: p.id, pageName: p.name, rev: p.rev, line: h.line, passage: snippet(h), found: h.found, use: h.use }))) };
}

