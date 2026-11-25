// Images (D484 §16, docs/redesign/documents.md): one kind, "image", whose field holds a file kept by its content. The
// interface draws the field (drop, paste or choose an image) and reads the file; this plugin never sees its bytes.
// Embedded elsewhere (`![[name]]`, `![[name | 宽=小]]` once parameters arrive) it shows the image.

const WIDTHS = { small: "small", medium: "medium", large: "large", original: "original", 小: "small", 中: "medium", 大: "large", 原始: "original" };

/** The width asked for with the embed's parameters (`宽` or `width`), else medium. */
export function widthOf(args) {
  const a = args || {};
  const w = String(a["宽"] ?? a.width ?? "").trim().toLowerCase();
  return WIDTHS[w] || "medium";
}

/** The image of a resource: the field's value when it names a stored file. */
export function imageOf(body) {
  const v = body && body.image;
  return v && typeof v === "object" && typeof v.blob === "string" ? v : null;
}

export default {
  activate(host) {
    host.pages.handle("image", {
      render(ctx) {
        return {
          view: [{ type: "form", id: "image", layout: "stack", fields: [{ name: "image", label: ctx.t("field.image"), kind: "attachment", bind: "body.image" }] }],
        };
      },
    });

    host.kinds.handle("image", {
      embed(ctx, ask) {
        const r = ctx.resource || {};
        const img = imageOf(r.body);
        if (!img) return { view: [{ type: "text", id: "empty", text: ctx.t("embed.empty"), tone: "muted" }] };
        const view = [{ type: "image", id: "image", blob: img.blob, alt: String(r.name || img.name || ""), width: widthOf(ask && ask.args) }];
        if (r.description) view.push({ type: "text", id: "caption", text: String(r.description), tone: "muted" });
        return { view };
      },
    });
  },
};
