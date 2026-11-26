// The colophon (版权页, docs/redesign/book.md §21.3): who published the book, which edition and printing it is, and the
// one place a book is published from. "Publish a new edition" keeps the book as it is now as that edition and prints
// it; "Reprint" prints a kept edition again. With a student's and a teacher's edition, pages whose role says
// `edition: "teacher"` go only into the teacher's. Publishing itself is the kernel's (a subtree, K9): the colophon only
// says what to print, and keeps the record.

import { full, teacherOnly } from "./roles.js";
import { BOOK, freePath, safeName } from "./toc.js";
import { say } from "./words.js";

export const COLOPHON = full("colophon");
const NONE = { type: "none" };
const VARIANTS = ["student", "teacher"];
/** Most history rows kept (the oldest go). */
const MAX_HISTORY = 200;

async function bookOf(ctx, res) {
  const parent = res && res.parentId;
  if (!parent) return null;
  try {
    const b = await ctx.host.resources.get(parent);
    return b && b.kind === BOOK ? b : null;
  } catch {
    return null;
  }
}

function historyOf(body) {
  return Array.isArray(body && body.history) ? body.history.filter((h) => h && Number.isInteger(h.edition) && Number.isInteger(h.printing)) : [];
}

/** The last printing of `edition` in the record (0: never printed). */
function lastPrinting(history, edition) {
  return history.filter((h) => h.edition === edition).reduce((m, h) => Math.max(m, h.printing), 0);
}

async function authorsOf(ctx, bookId) {
  const kids = await ctx.host.resources.tree(bookId, { limit: 200 });
  const cover = kids.nodes.find((n) => n.depth === 1 && n.kind === full("cover"));
  if (!cover) return "";
  const c = await ctx.host.resources.get(cover.id);
  return c && c.body && typeof c.body.authors === "string" ? c.body.authors.trim() : "";
}

function stamp(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* ------------------------------------------------------------------ the page */

export async function renderColophon(ctx) {
  const c = ctx.resource;
  const body = (c && c.body) || {};
  const book = await bookOf(ctx, c);
  const view = [];
  if (!book) view.push({ type: "text", id: "alone", text: say(ctx, "colophon.alone"), tone: "muted" });
  // A read-only copy says which printing it is (the copy knows, not the page's own record).
  if (c && c.copy) {
    view.push({ type: "text", id: "copy", text: say(ctx, c.copy.variant === "teacher" ? "colophon.copyTeacher" : "colophon.copyStudent", { edition: c.copy.edition, printing: c.copy.printing }) });
    view.push(...(await face(ctx, c, book)));
    return { view, readOnly: true };
  }
  view.push(...(await face(ctx, c, book)));
  const edition = Number.isInteger(body.edition) ? body.edition : 0;
  view.push({
    type: "text",
    id: "now",
    text: edition > 0 ? say(ctx, "colophon.current", { edition, printing: lastPrinting(historyOf(body), edition) }) : say(ctx, "colophon.never"),
    tone: edition > 0 ? undefined : "muted",
  });
  const editions = [...new Set(historyOf(body).map((h) => h.edition))].sort((a, b) => b - a);
  view.push({
    type: "form",
    id: "colophon",
    layout: "stack",
    fields: [
      { name: "publisher", label: ctx.t("field.publisher"), kind: "text", bind: "body.publisher" },
      { name: "isbn", label: ctx.t("field.isbn"), kind: "text", bind: "body.isbn" },
      { name: "note", label: ctx.t("field.editionNote"), kind: "longtext", bind: "body.note" },
      { name: "split", label: ctx.t("field.split"), kind: "boolean", bind: "body.split", hint: ctx.t("field.split.hint") },
      ...(editions.length > 0
        ? [{ name: "reprintEdition", label: ctx.t("field.reprintEdition"), kind: "enum", param: true, options: editions.map((e) => ({ value: String(e), label: say(ctx, "colophon.editionN", { edition: e }) })) }]
        : []),
    ],
  });
  const history = historyOf(body);
  if (history.length > 0) {
    const rows = history.slice().reverse();
    view.push({ type: "text", id: "historyTitle", text: `### ${say(ctx, "colophon.history")}`, format: "markdown" });
    view.push({
      type: "table",
      id: "history",
      columns: [
        { key: "edition", label: say(ctx, "col.edition"), numeric: true },
        { key: "printing", label: say(ctx, "col.printing"), numeric: true },
        { key: "variant", label: say(ctx, "col.variant") },
        { key: "at", label: say(ctx, "col.at") },
        { key: "file", label: say(ctx, "col.file") },
        { key: "note", label: say(ctx, "col.note") },
      ],
      rows: rows.map((h) => [String(h.edition), String(h.printing), say(ctx, `colophon.${VARIANTS.includes(h.variant) ? h.variant : "student"}`), stamp(h.at), String(h.path || "").split("/").pop(), h.note || "—"]),
      rowKeys: rows.map((_, i) => String(history.length - 1 - i)),
      rowActions: [{ id: "reveal", label: ctx.t("action.reveal"), icon: "folder-search" }],
    });
  }
  return { view };
}

/** Title, authors, publisher and book number, as printed. */
async function face(ctx, c, book) {
  const b = (c && c.body) || {};
  const lines = [];
  if (book) lines.push(`**${book.name}**`);
  const authors = book ? await authorsOf(ctx, book.id) : "";
  const bits = [];
  if (authors) bits.push(say(ctx, "colophon.authors", { authors }));
  if (typeof b.publisher === "string" && b.publisher.trim()) bits.push(say(ctx, "colophon.publisher", { publisher: b.publisher.trim() }));
  if (typeof b.isbn === "string" && b.isbn.trim()) bits.push(say(ctx, "colophon.isbn", { isbn: b.isbn.trim() }));
  if (bits.length) lines.push(bits.join(say(ctx, "colophon.sep")));
  if (typeof b.note === "string" && b.note.trim()) lines.push(b.note.trim());
  return lines.length ? [{ type: "text", id: "face", text: lines.join("\n\n"), format: "markdown" }] : [];
}

/** In a book being read: the colophon as printed. */
export async function embedColophon(ctx) {
  const c = ctx.resource;
  const view = await face(ctx, c, await bookOf(ctx, c));
  const b = (c && c.body) || {};
  const ed = c && c.copy ? c.copy : Number.isInteger(b.edition) && b.edition > 0 ? { edition: b.edition, printing: lastPrinting(historyOf(b), b.edition) } : null;
  if (ed) view.push({ type: "text", id: "printing", text: say(ctx, "colophon.printed", { edition: ed.edition, printing: ed.printing }), tone: "muted" });
  return { view };
}

export async function colophonEvent(ctx, event) {
  if (event === "reveal") {
    const h = historyOf(ctx.resource && ctx.resource.body)[Number(ctx.row)];
    if (!h || !h.path) return { message: ctx.t("colophon.noFile") };
    try {
      await ctx.host.files.reveal(h.path);
    } catch {
      return { message: ctx.t("colophon.noFile") };
    }
    return {};
  }
  throw new Error(`unknown event ${event}`);
}

/* ------------------------------------------------------------------ printing (runs) */

function failed(ctx, key) {
  const text = say(ctx, key);
  return { output: { type: "text", text }, failed: { message: text } };
}

async function folderOf(ctx) {
  const roots = await ctx.host.files.roots();
  if (roots && roots.length > 0) return roots[0].path;
  try {
    await ctx.host.files.addRoot();
  } catch {
    // The dialog could not be shown: the message says what to do.
  }
  return null;
}

/**
 * Prints `edition` (its `printing`): the student's edition (without the teacher's pages; `reveal`: withheld fields
 * printed this time) and, if the book is split and `variants` asks, the teacher's. `keep`: keep the book as it is now as
 * that edition first. Writes the record.
 */
async function print(ctx, { book, edition, printing, variants, reveal, keep, note }) {
  const c = ctx.resource;
  const folder = await folderOf(ctx);
  if (!folder) return { error: "export.pickFolder" };
  const exclude = c.body && c.body.split === false ? [] : await teacherOnly(ctx, book.id);
  const at = Date.now();
  const written = [];
  for (const [i, v] of variants.entries()) {
    const path = await freePath(ctx, folder, `${safeName(book.name)}-${edition}.${printing}-${say(ctx, `colophon.${v}`)}`, ".odpack");
    const opts = { edition, printing, variant: v, exclude: v === "student" ? exclude : [], reveal: v === "student" ? reveal || {} : {}, path };
    const r = await ctx.host.packages[keep && i === 0 ? "publish" : "reprint"](book.id, opts);
    written.push({ edition, printing, variant: v, at, path: r.path, note: note || "" });
  }
  const history = [...historyOf(c.body), ...written].slice(-MAX_HISTORY);
  const changes = { "body.history": history };
  if (keep) changes["body.edition"] = edition;
  await ctx.host.resources.update(c.id, changes);
  return { written };
}

function variantsOf(c) {
  return c.body && c.body.split === false ? ["student"] : ["student", "teacher"];
}

function doneOutput(ctx, written) {
  const lines = written.map((w) => say(ctx, "colophon.wrote", { variant: say(ctx, `colophon.${w.variant}`), path: w.path }));
  return { output: { type: "text", text: [say(ctx, "colophon.printedNow", { edition: written[0].edition, printing: written[0].printing }), ...lines].join("\n") } };
}

/** “Publish a new edition”: the next edition, printing 1, kept as it is now. */
export async function publishAction(ctx) {
  const c = ctx.resource;
  const book = await bookOf(ctx, c);
  if (!book) return failed(ctx, "colophon.alone");
  const edition = (Number.isInteger(c.body && c.body.edition) ? c.body.edition : 0) + 1;
  const r = await print(ctx, { book, edition, printing: 1, variants: variantsOf(c), keep: true });
  if (r.error) return failed(ctx, r.error);
  return doneOutput(ctx, r.written);
}

/** “Reprint”: the edition chosen (the current one by default) printed again from what was kept. */
export async function reprintAction(ctx, input) {
  const c = ctx.resource;
  const book = await bookOf(ctx, c);
  if (!book) return failed(ctx, "colophon.alone");
  const current = Number.isInteger(c.body && c.body.edition) ? c.body.edition : 0;
  if (current === 0) return failed(ctx, "colophon.never");
  const asked = Number(input && input.reprintEdition);
  const edition = Number.isInteger(asked) && asked >= 1 && asked <= current ? asked : current;
  const r = await print(ctx, { book, edition, printing: lastPrinting(historyOf(c.body), edition) + 1, variants: variantsOf(c) });
  if (r.error) return failed(ctx, r.error);
  return doneOutput(ctx, r.written);
}

/**
 * `print` (exported, §21.6): another role asks for a printing of one edition (the current one by default) — the
 * student's by default — with `reveal`ed withheld fields and a note for the record. Answers `{ edition, printing,
 * paths }`.
 */
export async function printAction(ctx, input) {
  const c = ctx.resource;
  const book = c && c.kind === COLOPHON ? await bookOf(ctx, c) : null;
  if (!book) return { ...failed(ctx, "colophon.alone"), output: NONE };
  const current = Number.isInteger(c.body && c.body.edition) ? c.body.edition : 0;
  if (current === 0) return { ...failed(ctx, "colophon.never"), output: NONE };
  const asked = Number(input && input.edition);
  const edition = Number.isInteger(asked) && asked >= 1 && asked <= current ? asked : current;
  const variant = input && input.variant === "teacher" ? "teacher" : "student";
  const reveal = input && input.reveal && typeof input.reveal === "object" ? input.reveal : {};
  const note = input && typeof input.note === "string" ? input.note.slice(0, 200) : "";
  const r = await print(ctx, { book, edition, printing: lastPrinting(historyOf(c.body), edition) + 1, variants: [variant], reveal, note });
  if (r.error) return { ...failed(ctx, r.error), output: NONE };
  return { output: NONE, data: { edition, printing: r.written[0].printing, paths: r.written.map((w) => w.path) } };
}
