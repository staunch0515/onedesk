// The contents (目录, docs/redesign/book.md §4, §13.4): everything about reading the book as a whole is here — which
// items it has and in what order, how they are numbered, reading through (one after another or page by page), where
// the reader stopped, sub-books, a chapter shown elsewhere, and printing the book to a file.

import { allNodes, childrenMap, full, GROUP, IFACE, PART_RANK, PLUGIN, roleFinder, split } from "./roles.js";
import { outlineOf, TEXT_KINDS } from "./text-page.js";
import { chineseNumber, letter, say, usesChineseNumerals } from "./words.js";

export const TOC = full("toc");
export const BOOK = full("book");
/** Sub-books inside sub-books are read this deep; deeper ones show only their title. */
export const MAX_NEST = 8;

/* ------------------------------------------------------------------ settings */

/**
 * The numbering settings of a contents page: `words` (第一章 / Chapter 1, by the level names), `numbers` (1.2.3) or
 * `none`; the level names; what a sub-book is called. What is not set comes from `inherited` (the outer book's), else
 * from the language.
 */
export function settingsOf(ctx, body, inherited) {
  const b = body || {};
  const base = inherited || {};
  const numbering = ["words", "numbers", "none"].includes(b.numbering) ? b.numbering : base.numbering || "words";
  const levelsText = typeof b.levels === "string" && b.levels.trim() ? b.levels : base.levelsText || say(ctx, "default.levels");
  const volume = typeof b.volume === "string" && b.volume.trim() ? b.volume.trim() : base.volume || say(ctx, "default.volume");
  const levels = levelsText
    .split(/[,，、]/)
    .map((s) => s.trim())
    .filter(Boolean);
  return { numbering, levelsText, levels, volume };
}

/** The number of an item at `path` (numbers from the book down; an appendix path starts with its letter). */
export function numberText(ctx, s, path) {
  if (s.numbering === "none") return "";
  if (typeof path[0] === "string" || s.numbering === "numbers") return path.join(".");
  const name = s.levels[path.length - 1];
  if (!name) return path.join(".");
  const n = path[path.length - 1];
  return usesChineseNumerals(ctx) ? `第${chineseNumber(n)}${name}` : `${name} ${n}`;
}

/** 第一册 / Volume 1 (none: no number). */
export function volumeText(ctx, s, n) {
  if (s.numbering === "none") return "";
  if (s.numbering === "words" && usesChineseNumerals(ctx)) return `第${chineseNumber(n)}${s.volume}`;
  return `${s.volume} ${n}`;
}

/** 附录 A / Appendix A. */
export function appendixText(ctx, s, l) {
  return s.numbering === "none" ? "" : `${say(ctx, "number.appendix")} ${l}`;
}

/* ------------------------------------------------------------------ outlines */

// What each page holds (its captions), by revision: asked again only when the page changed.
const outlines = new Map();
const MAX_OUTLINES = 5000;

async function outlineFor(ctx, node, role) {
  const hit = outlines.get(node.id);
  if (hit && hit.rev === node.rev) return hit.outline;
  let outline = { headings: [], figures: [] };
  const [plugin, short] = split(node.kind);
  try {
    if (plugin === PLUGIN && TEXT_KINDS.includes(short)) {
      const r = await ctx.host.resources.get(node.id);
      outline = outlineOf(r && r.body ? r.body.text : "");
    } else if (role.declared) {
      const r = await ctx.host.interfaces.call(IFACE, "outline", { resource: node.id }, { resource: node.id });
      if (r && r.data && Array.isArray(r.data.figures)) outline = { headings: r.data.headings || [], figures: r.data.figures };
    }
  } catch {
    // Not readable: no captions.
  }
  if (outlines.size >= MAX_OUTLINES) [...outlines.keys()].slice(0, MAX_OUTLINES / 2).forEach((k) => outlines.delete(k));
  outlines.set(node.id, { rev: node.rev, outline });
  return outline;
}

/* ------------------------------------------------------------------ entries */

/**
 * The items of the book `bookId` in reading order, numbered (§13.4.3–§13.4.5): `{ items, meta }` — `items` as the
 * `sequence` node takes them (`key`, `title`, `level`, `resource`, `args`, `book`), `meta` beside them (`name`,
 * `number`) to find a chapter by name or number.
 */
export async function entriesOf(ctx, bookId, settings, opts = {}) {
  const nodes = opts.nodes || (await allNodes(ctx, bookId));
  const env = { ctx, kids: childrenMap(nodes), role: opts.role || roleFinder(ctx), counts: new Map(), items: [], meta: [] };
  await walkBook(env, bookId, settings, opts.level || 1, 0);
  return { items: env.items, meta: env.meta };
}

async function rolesOf(env, nodes) {
  const out = [];
  for (const n of nodes) out.push({ n, r: await env.role(n.kind) });
  return out;
}

async function walkBook(env, bookId, s, level, nest) {
  const rows = (await rolesOf(env, env.kids.get(bookId) || [])).filter((x) => x.r.part !== "none");
  rows.sort((a, b) => PART_RANK[a.r.part] - PART_RANK[b.r.part]);
  let chapter = 0;
  let volume = 0;
  let appendix = 0;
  for (const { n, r } of rows) {
    if (r.role === "book") {
      volume += 1;
      await subBook(env, n, s, level, nest, volume);
    } else if (r.numbering === "letter") {
      appendix += 1;
      const l = letter(appendix);
      await walkNode(env, n, r, s, [l], level, nest, l);
    } else if (r.numbering === "none") {
      add(env, n, r, "", level, r.part, s);
      await addFigures(env, n, r, r.part, s);
    } else {
      chapter += 1;
      await walkNode(env, n, r, s, [chapter], level, nest, String(chapter));
    }
  }
}

async function walkNode(env, n, r, s, path, level, nest, chapterKey) {
  const number = typeof path[0] === "string" && path.length === 1 ? appendixText(env.ctx, s, path[0]) : numberText(env.ctx, s, path);
  add(env, n, r, number, level, chapterKey, s);
  await addFigures(env, n, r, chapterKey, s);
  if (!r.container) return;
  let i = 0;
  let volume = 0;
  for (const { n: k, r: kr } of await rolesOf(env, env.kids.get(n.id) || [])) {
    if (kr.part === "none") continue;
    if (kr.role === "book") {
      volume += 1;
      await subBook(env, k, s, level + 1, nest, volume);
      continue;
    }
    i += 1;
    await walkNode(env, k, { ...kr, numbering: "level" }, s, [...path, i], level + 1, nest, chapterKey);
  }
}

function add(env, n, r, number, level, chapterKey, s) {
  const item = { key: n.id, title: number ? `${number} ${n.name}` : n.name, level: Math.min(Math.max(level, 1), 9) };
  if (n.kind !== GROUP) {
    item.resource = n.id;
    const key = countKey(s, chapterKey);
    const c = env.counts.get(key) || { figure: 0, table: 0 };
    item.args = { book: { prefix: prefixOf(s, chapterKey), figure: c.figure, table: c.table } };
  }
  env.items.push(item);
  env.meta.push({ name: n.name, number });
}

/** Captions are numbered by chapter ("Figure 2-1"); without numbers, through the whole book; front and back by themselves. */
function countKey(s, chapterKey) {
  return s.numbering === "none" ? "all" : chapterKey;
}

function prefixOf(s, chapterKey) {
  return s.numbering === "none" || chapterKey === "front" || chapterKey === "back" ? "" : chapterKey;
}

async function addFigures(env, n, r, chapterKey, s) {
  if (n.kind === GROUP) return;
  const key = countKey(s, chapterKey);
  const c = env.counts.get(key) || { figure: 0, table: 0 };
  const o = await outlineFor(env.ctx, n, r);
  for (const f of o.figures) c[f.type === "table" ? "table" : "figure"] += 1;
  env.counts.set(key, c);
}

async function subBook(env, n, s, level, nest, index) {
  const v = volumeText(env.ctx, s, index);
  env.items.push({ key: n.id, title: v ? `${v} ${n.name}` : n.name, level: Math.min(Math.max(level, 1), 9), book: true });
  env.meta.push({ name: n.name, number: v });
  if (nest + 1 >= MAX_NEST) return;
  const kids = await rolesOf(env, env.kids.get(n.id) || []);
  const contents = kids.find((x) => x.r.role === "toc");
  const saved = env.counts;
  env.counts = new Map();
  try {
    if (contents && contents.n.kind !== TOC) {
      // Another plugin's contents: it numbers its book itself.
      try {
        const r = await env.ctx.host.interfaces.call(IFACE, "entries", { resource: contents.n.id, depth: level, settings: s }, { resource: contents.n.id });
        const items = (r && r.data && Array.isArray(r.data.items) ? r.data.items : []).filter((x) => x && typeof x.key === "string");
        for (const x of items) {
          env.items.push(x);
          env.meta.push({ name: x.title, number: "" });
        }
        return;
      } catch {
        // Fall back to numbering it here.
      }
    }
    let sub = s;
    if (contents && contents.n.kind === TOC) {
      const t = await env.ctx.host.resources.get(contents.n.id);
      sub = settingsOf(env.ctx, t && t.body, s);
    }
    await walkBook(env, n.id, sub, level + 1, nest + 1);
  } finally {
    env.counts = saved;
  }
}

/** One chapter (by name, number or title) and everything below it; null when there is none. */
export function chapterOf(entries, section) {
  const want = String(section || "").trim().toLowerCase();
  const i = entries.items.findIndex(
    (x, j) => x.title.toLowerCase() === want || entries.meta[j].name.toLowerCase() === want || (entries.meta[j].number && entries.meta[j].number.toLowerCase() === want),
  );
  if (i < 0) return null;
  const out = [entries.items[i]];
  for (let j = i + 1; j < entries.items.length && entries.items[j].level > entries.items[i].level; j++) out.push(entries.items[j]);
  return out;
}

/* ------------------------------------------------------------------ the page */

/** The book a contents page belongs to (its parent), or null. */
export async function bookOf(ctx, res) {
  const parent = res && res.parentId;
  if (!parent) return null;
  try {
    const b = await ctx.host.resources.get(parent);
    return b && b.kind === BOOK ? b : null;
  } catch {
    return null;
  }
}

/** The settings as the person sees them now (the unsaved draft first). */
function draftSettings(ctx) {
  const b = Object.assign({}, (ctx.resource && ctx.resource.body) || {});
  for (const k of ["numbering", "levels", "volume"]) if (ctx.draft && typeof ctx.draft[`body.${k}`] === "string") b[k] = ctx.draft[`body.${k}`];
  return b;
}

export async function renderToc(ctx) {
  const settingsForm = {
    type: "form",
    id: "settings",
    layout: "strip",
    fields: [
      {
        name: "numbering",
        label: ctx.t("field.numbering"),
        kind: "enum",
        bind: "body.numbering",
        options: ["words", "numbers", "none"].map((v) => ({ value: v, label: ctx.t(`numbering.${v}`) })),
      },
      { name: "levels", label: ctx.t("field.levels"), kind: "text", bind: "body.levels", placeholder: say(ctx, "default.levels") },
      { name: "volume", label: ctx.t("field.volume"), kind: "text", bind: "body.volume", placeholder: say(ctx, "default.volume") },
    ],
  };
  const book = await bookOf(ctx, ctx.resource);
  if (!book) return { view: [settingsForm, { type: "text", id: "alone", text: say(ctx, "toc.alone"), tone: "muted" }] };
  const { items } = await entriesOf(ctx, book.id, settingsOf(ctx, draftSettings(ctx), null));
  if (items.length === 0) return { view: [settingsForm, { type: "text", id: "empty", text: say(ctx, "toc.empty"), tone: "muted" }] };
  const pos = await ctx.host.storage.get(`pos:${ctx.resource.id}`);
  const node = { type: "sequence", id: "book", items, toc: true, mode: ctx.params && ctx.params["view.mode"] === "pages" ? "pages" : "scroll", positionEvent: "position" };
  if (typeof pos === "string" && items.some((x) => x.key === pos)) node.start = pos;
  return { view: [settingsForm, node] };
}

export async function tocEvent(ctx, event) {
  if (event === "position") {
    if (typeof ctx.row === "string" && ctx.row) await ctx.host.storage.set(`pos:${ctx.resource.id}`, ctx.row);
    return undefined;
  }
  if (event === "toggle") {
    const next = ctx.params && ctx.params["view.mode"] === "pages" ? "scroll" : "pages";
    return { params: { "view.mode": next }, message: ctx.t(next === "pages" ? "message.pages" : "message.scroll") };
  }
  throw new Error(`unknown event ${event}`);
}

/** `![[contents]]`: the numbered list of what the book holds. */
export async function embedToc(ctx) {
  const book = await bookOf(ctx, ctx.resource);
  if (!book) return { view: [{ type: "text", id: "alone", text: say(ctx, "toc.alone"), tone: "muted" }] };
  const { items } = await entriesOf(ctx, book.id, settingsOf(ctx, ctx.resource.body, null));
  const lines = items.map((x) => `${"  ".repeat(Math.max(0, x.level - 1))}- ${x.book ? `**${x.title}**` : x.title}`);
  return { view: [{ type: "text", id: "toc", text: lines.join("\n") || say(ctx, "toc.empty"), format: "markdown" }] };
}

/* ------------------------------------------------------------------ export */

const BAD_NAME = /[/\\:*?"<>|]/g;

function safeName(name) {
  const s = String(name || "").replace(BAD_NAME, "-").trim();
  return s || "book";
}

async function exists(ctx, path) {
  try {
    await ctx.host.files.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** `<folder>/<name><ext>`, or with " 2", " 3"… when that is taken. */
async function freePath(ctx, folder, name, ext) {
  for (let i = 1; i <= 1000; i++) {
    const p = `${folder}/${name}${i === 1 ? "" : ` ${i}`}${ext}`;
    if (!(await exists(ctx, p))) return p;
  }
  throw new Error("no free name");
}

function labelText(ctx, l) {
  return typeof l === "string" ? l : (l && (l[ctx.locale] || l["en-US"])) || "";
}

function tableMarkdown(node) {
  const cell = (v) => (v === null || v === undefined ? "" : String(typeof v === "object" ? JSON.stringify(v) : v)).replace(/\|/g, "\\|").replace(/\n/g, " ");
  const head = `| ${node.columns.map((c) => cell(c.label)).join(" | ")} |`;
  const rule = `| ${node.columns.map(() => "---").join(" | ")} |`;
  const rows = node.rows.map((r) => `| ${r.map(cell).join(" | ")} |`);
  return [head, rule, ...rows].join("\n");
}

const BLOB_REF = /\(blob:([0-9a-f]{64})\)/g;

/** Prints the book (in contents order, numbered) to `<granted folder>/<book>.md`, its images beside it (§13.4.7). */
export async function exportBook(ctx) {
  const book = await bookOf(ctx, ctx.resource);
  if (!book) return { output: { type: "text", text: say(ctx, "toc.alone") }, failed: { message: say(ctx, "toc.alone") } };
  const roots = await ctx.host.files.roots();
  if (!roots || roots.length === 0) {
    try {
      await ctx.host.files.addRoot();
    } catch {
      // The dialog could not be shown: the message says what to do.
    }
    return { output: { type: "text", text: say(ctx, "export.pickFolder") }, failed: { message: say(ctx, "export.pickFolder") } };
  }
  const folder = roots[0].path;
  const { items } = await entriesOf(ctx, book.id, settingsOf(ctx, ctx.resource.body, null));
  const md = await freePath(ctx, folder, safeName(book.name), ".md");
  const stem = md.slice(folder.length + 1, -".md".length);
  const imageDir = `${folder}/${stem}-${say(ctx, "export.images")}`;
  const written = new Map();
  let made = false;
  const image = async (blob) => {
    if (written.has(blob)) return written.get(blob);
    if (!made) {
      await ctx.host.files.mkdir(imageDir, { recursive: true });
      made = true;
    }
    const r = await ctx.host.files.writeBlob(blob, `${imageDir}/${written.size + 1}`);
    const rel = r.path.slice(folder.length + 1);
    written.set(blob, rel);
    return rel;
  };
  const withImages = async (text) => {
    let out = String(text);
    for (const m of [...out.matchAll(BLOB_REF)]) out = out.split(m[0]).join(`(<${await image(m[1])}>)`);
    return out;
  };

  const out = [`# ${book.name}`, ""];
  const kids = await ctx.host.resources.tree(book.id, { limit: 2000 });
  const coverNode = kids.nodes.find((n) => n.depth === 1 && n.kind === full("cover"));
  if (coverNode) {
    const c = await ctx.host.resources.get(coverNode.id);
    const b = (c && c.body) || {};
    for (const k of ["subtitle", "authors", "blurb"]) if (typeof b[k] === "string" && b[k].trim()) out.push(b[k].trim(), "");
  }
  out.push(`## ${say(ctx, "export.contents")}`, "");
  for (const x of items) out.push(`${"  ".repeat(Math.max(0, x.level - 1))}- ${x.title}`);
  out.push("");
  for (const x of items) {
    out.push(`${"#".repeat(Math.min(x.level + 1, 6))} ${x.title}`, "");
    if (!x.resource) continue;
    let e;
    try {
      e = await ctx.host.resources.embed(x.resource, { args: x.args });
    } catch {
      continue;
    }
    for (const n of (e && e.view) || []) {
      if (n.type === "text") out.push(await withImages(n.text), "");
      else if (n.type === "table") out.push(tableMarkdown(n), "");
      else if (n.type === "image") out.push(`![${n.alt || ""}](<${await image(n.blob)}>)`, "");
      else if (n.type === "link") out.push(labelText(ctx, n.label), "");
    }
    if ((!e || !e.view) && e && e.description) out.push(e.description, "");
  }
  await ctx.host.files.writeText(md, out.join("\n").replace(/\n{3,}/g, "\n\n"));
  const text = say(ctx, "export.done", { path: md, images: written.size });
  return { output: { type: "text", text }, summary: { message: text } };
}
