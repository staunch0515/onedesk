// Text pages of a book (docs/redesign/book.md §3.3, §3.4, §13.5): the body page, the preface and the afterword. Like a
// note — read or edit — plus two things a page in a book has: footnotes, and captions numbered by the book's contents.
// The writing of footnotes and captions is this plugin's own (rule 5).

import { filled, holeNames, holeStrip } from "./template.js";
import { say } from "./words.js";

export const TEXT_KINDS = ["page", "preface", "afterword"];

/** "read" or "edit" (the default): the tab's view state. */
export function modeOf(ctx) {
  return ctx.params && ctx.params["view.mode"] === "read" ? "read" : "edit";
}

/** The text as the person sees it: the unsaved draft first, then the saved body. */
export function textOf(ctx) {
  if (ctx.draft && typeof ctx.draft["body.text"] === "string") return ctx.draft["body.text"];
  const b = ctx.resource && ctx.resource.body;
  return b && typeof b.text === "string" ? b.text : "";
}

const FENCE = /^\s*(```|~~~)/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
// "图：…" / "Figure: …" / "図：…" and "表：…" / "Table: …", a line of their own.
const CAPTION = /^\s*(图|圖|図|Figure|Fig\.|表|Table)\s*[:：]\s*(.+?)\s*$/i;
const FOOTNOTE_DEF = /^\s*\[\^([^\]\s]{1,40})\]:\s*(.*)$/;
const FOOTNOTE_REF = /\[\^([^\]\s]{1,40})\](?!:)/g;
const SUPERSCRIPT = "⁰¹²³⁴⁵⁶⁷⁸⁹";
// D487 §15: citations `[@key]`, `[@key, note]`, `[@a; @b]`; index terms `{{索引:term}}`, `{{index:main/sub}}` (hidden
// in reading); an embed line right above a caption is what the caption is about.
const CITE = /\[@([^\]\n]{1,500})\]/g;
const TERM = /\{\{\s*(?:索引|index)\s*[:：]\s*([^{}\n]{1,200}?)\s*\}\}/gi;
const EMBED_LINE = /^\s*!\[\[([^[\]\n]{1,200})\]\]\s*$/;

/** The citations inside one `[@…]`: `{ keys, notes }` (a note is null when there is none). */
export function parseCite(inner) {
  const keys = [];
  const notes = [];
  for (const part of String(inner).split(/[;；]/)) {
    const p = part.trim().replace(/^@/, "");
    if (!p) continue;
    const i = p.search(/[,，]/);
    keys.push((i < 0 ? p : p.slice(0, i)).trim());
    notes.push(i < 0 ? null : p.slice(i + 1).trim() || null);
  }
  return { keys, notes };
}

/** One index term: `{ term, sub }` (`main/sub`: a term under a main term). */
export function parseTerm(raw) {
  const [term, ...rest] = String(raw).split("/");
  const sub = rest.join("/").trim();
  return { term: term.trim(), sub: sub || null };
}

function captionType(word) {
  return /^(表|table)$/i.test(word) ? "table" : "figure";
}

/** One section of the text (from the heading named `section` to the next of the same or a higher level), or null. */
export function sectionOf(text, section) {
  const want = String(section || "").trim().toLowerCase();
  const lines = String(text || "").split("\n");
  let fence = false;
  let from = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    if (FENCE.test(lines[i])) fence = !fence;
    if (fence) continue;
    const m = HEADING.exec(lines[i]);
    if (!m) continue;
    if (from >= 0 && m[1].length <= level) return lines.slice(from, i).join("\n").trimEnd();
    if (from < 0 && m[2].trim().toLowerCase() === want) {
      from = i;
      level = m[1].length;
    }
  }
  return from >= 0 ? lines.slice(from).join("\n").trimEnd() : null;
}

/** What is in a text (for the contents, §13.6 `outline`): its headings and its captions, in order. */
export function outlineOf(text) {
  const headings = [];
  const figures = [];
  const cites = [];
  const terms = [];
  let fence = false;
  let above = null;
  for (const line of String(text || "").split("\n")) {
    if (FENCE.test(line)) fence = !fence;
    if (fence) continue;
    const h = HEADING.exec(line);
    if (h) {
      headings.push({ text: h[2].trim(), level: h[1].length });
      above = null;
      continue;
    }
    const c = CAPTION.exec(line);
    if (c) {
      const f = { type: captionType(c[1]), caption: c[2] };
      if (above) f.of = above;
      figures.push(f);
      above = null;
      continue;
    }
    for (const m of line.matchAll(CITE)) {
      const one = parseCite(m[1]);
      if (one.keys.length > 0) cites.push(one);
    }
    for (const m of line.matchAll(TERM)) {
      const t = parseTerm(m[1]);
      if (t.term) terms.push(t);
    }
    const e = EMBED_LINE.exec(line);
    if (e) above = e[1].split("#")[0].trim();
    else if (line.trim()) above = null;
  }
  return { headings, figures, cites, terms };
}

/**
 * The text as read: captions numbered ("Figure 2-1  The circuit" in a book whose contents gave the prefix "2" and the
 * figures before this page; "Figure 1" alone), footnote marks as superscript numbers with the notes listed at the end.
 */
export function readable(ctx, text, at) {
  const prefix = at && typeof at.prefix === "string" ? at.prefix : "";
  const count = { figure: (at && Number(at.figure)) || 0, table: (at && Number(at.table)) || 0 };
  const lines = String(text || "").split("\n");
  const notes = new Map();
  for (const line of lines) {
    const d = FOOTNOTE_DEF.exec(line);
    if (d && !notes.has(d[1])) notes.set(d[1], d[2]);
  }
  const order = [];
  const out = [];
  let citeIndex = 0;
  let fence = false;
  for (const line of lines) {
    if (FENCE.test(line)) fence = !fence;
    if (fence) {
      out.push(line);
      continue;
    }
    if (FOOTNOTE_DEF.test(line)) continue;
    const c = CAPTION.exec(line);
    if (c) {
      const type = captionType(c[1]);
      count[type] += 1;
      const n = prefix ? `${prefix}-${count[type]}` : String(count[type]);
      out.push(`*${say(ctx, type === "table" ? "caption.table" : "caption.figure")} ${n}　${c[2]}*`);
      continue;
    }
    out.push(
      line
        .replace(TERM, "")
        .replace(CITE, (all, inner) => {
          const one = parseCite(inner);
          if (one.keys.length === 0) return all;
          const label = at && Array.isArray(at.cites) ? at.cites[citeIndex] : undefined;
          citeIndex += 1;
          return typeof label === "string" ? label : `[${one.keys.join("; ")}]`;
        })
        .replace(FOOTNOTE_REF, (all, id) => {
        if (!notes.has(id)) return all;
        if (!order.includes(id)) order.push(id);
        return String(order.indexOf(id) + 1)
          .split("")
          .map((d) => SUPERSCRIPT[Number(d)])
          .join("");
      }),
    );
  }
  let body = out.join("\n").trimEnd();
  if (order.length > 0) {
    body += `\n\n---\n\n**${say(ctx, "footnotes")}**\n\n`;
    body += order.map((id, i) => `${i + 1}. ${notes.get(id)}`).join("\n");
  }
  return body;
}

/** The page of a text page: a note's two modes; the preface also says which kind of preface it is. */
export function renderText(ctx) {
  return (async () => {
    const text = textOf(ctx);
    const view = [];
    const strip = await holeStrip(ctx, holeNames(text));
    if (strip) view.push(strip);
    if (modeOf(ctx) === "read") {
      view.push({ type: "text", id: "reading", text: readable(ctx, await filled(ctx, text), null), format: "markdown" });
      return { view };
    }
    const kind = String((ctx.resource && ctx.resource.kind) || "");
    if (kind.endsWith(":preface")) {
      view.push({
        type: "form",
        id: "variant",
        layout: "strip",
        fields: [
          {
            name: "variant",
            label: ctx.t("field.variant"),
            kind: "enum",
            bind: "body.variant",
            options: ["preface", "foreword", "acknowledgements"].map((v) => ({ value: v, label: ctx.t(`variant.${v}`) })),
          },
        ],
      });
    }
    view.push({
      type: "form",
      id: "content",
      layout: "stack",
      fields: [{ name: "text", label: ctx.t("field.text"), kind: "longtext", bind: "body.text", fill: true, placeholder: ctx.t("field.placeholder") }],
    });
    return { view };
  })();
}

/** Where a text page is embedded (in a book's contents, or `![[name]]`): read as above, numbered as `args.book` says. */
export async function embedText(ctx, ask) {
  const b = ctx.resource && ctx.resource.body;
  const text = b && typeof b.text === "string" ? b.text : "";
  const section = ask && typeof ask.section === "string" && ask.section ? ask.section : null;
  const part = section ? sectionOf(text, section) : text;
  if (part === null) return { view: [], sectionMissing: true };
  const at = ask && ask.args && typeof ask.args === "object" ? ask.args.book : null;
  const node = { type: "text", id: "embed", text: readable(ctx, await filled(ctx, part), at), format: "markdown" };
  // D487 §15: references to what the book numbers are shown with their numbers.
  if (at && at.labels && typeof at.labels === "object" && Object.keys(at.labels).length > 0) node.refLabels = at.labels;
  return { view: [node] };
}

/** The read/edit switch of the action bar. */
export function toggleText(ctx) {
  const next = modeOf(ctx) === "read" ? "edit" : "read";
  return { params: { "view.mode": next }, message: ctx.t(next === "read" ? "message.reading" : "message.editing") };
}
