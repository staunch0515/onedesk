// The template (文书模板, docs/redesign/book.md §23.3): the form with its blanks — free text, fill-in items, the
// environment's values, embeds and calls — and how many signatures a document written from it takes. Below it, a
// preview: what a new document would look like in this tab's environment (try the controls; nothing is kept).

import { bodyNow, say, str } from "./common.js";
import { flowOf, prepared } from "./doc.js";

export async function renderTemplate(ctx) {
  const body = bodyNow(ctx);
  const view = [
    {
      type: "form",
      id: "template",
      layout: "stack",
      fields: [
        { name: "text", label: ctx.t("field.text"), kind: "longtext", bind: "body.text", placeholder: ctx.t("field.text.placeholder"), hint: ctx.t("field.text.hint") },
        { name: "levels", label: ctx.t("field.levels"), kind: "text", bind: "body.levels", hint: ctx.t("field.levels.hint") },
      ],
    },
  ];
  if (!str(body.text).trim()) return { view };
  // Tried values live in the tab only (`try.<name>`), never in the template.
  const entered = {};
  for (const [k, v] of Object.entries(ctx.params || {})) if (k.startsWith("try.")) entered[k.slice(4)] = v;
  const p = await prepared(ctx, body.text, entered);
  const flow = flowOf(ctx, p, "preview");
  flow.text = flow.text.replace(/\{\{field:([^{}]+)\}\}/g, (_, n) => `{{field:try.${n}}}`);
  flow.fields = flow.fields.map((f) => ({ ...f, name: `try.${f.name}`, bind: undefined, param: true }));
  view.push({ type: "text", id: "previewTitle", text: `**${say(ctx, "template.preview")}**`, format: "markdown" });
  const bad = p.items.filter((it) => it.error);
  if (bad.length) view.push({ type: "text", id: "errors", tone: "danger", text: bad.map((b) => say(ctx, `item.error.${b.error}`, { item: b.raw })).join("\n") });
  view.push(flow);
  return { view };
}
