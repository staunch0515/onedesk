// The cover (封面, docs/redesign/book.md §3.1, §13.3): what the book looks like — where it is opened, where it is
// embedded (`![[book]]`), and in lists. The book's title is the book's own name (not written here).

import { say } from "./words.js";
import { BOOK } from "./toc.js";

/** The book a cover belongs to, or null. */
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

export async function renderCover(ctx) {
  const book = await bookOf(ctx, ctx.resource);
  const view = [
    {
      type: "text",
      id: "title",
      text: book ? say(ctx, "cover.titleIs", { name: book.name }) : say(ctx, "cover.alone"),
      tone: "muted",
    },
    {
      type: "form",
      id: "cover",
      layout: "stack",
      fields: [
        { name: "subtitle", label: ctx.t("field.subtitle"), kind: "text", bind: "body.subtitle" },
        { name: "authors", label: ctx.t("field.authors"), kind: "text", bind: "body.authors", placeholder: ctx.t("field.authors.placeholder") },
        { name: "image", label: ctx.t("field.image"), kind: "attachment", bind: "body.image" },
        { name: "blurb", label: ctx.t("field.blurb"), kind: "longtext", bind: "body.blurb" },
      ],
    },
  ];
  return { view };
}

/** The face of the book: the cover image, then the subtitle, the authors and the blurb. */
export function face(ctx, body) {
  const b = body || {};
  const view = [];
  if (b.image && typeof b.image.blob === "string") view.push({ type: "image", id: "image", blob: b.image.blob, alt: b.image.name || "", width: "medium" });
  const lines = [];
  if (typeof b.subtitle === "string" && b.subtitle.trim()) lines.push(`**${b.subtitle.trim()}**`);
  if (typeof b.authors === "string" && b.authors.trim()) lines.push(b.authors.trim());
  if (typeof b.blurb === "string" && b.blurb.trim()) lines.push(b.blurb.trim());
  if (lines.length > 0) view.push({ type: "text", id: "face", text: lines.join("\n\n"), format: "markdown" });
  if (view.length === 0) view.push({ type: "text", id: "empty", text: say(ctx, "cover.empty"), tone: "muted" });
  return view;
}

export function embedCover(ctx) {
  return { view: face(ctx, ctx.resource && ctx.resource.body) };
}
