// Notes plugin: one kind ("note"), one page ("editor"), one command ("duplicate").
// Runs in the sandbox: no console, timers or fetch; everything goes through ctx.host.
// A note is a template (D466): `{{name}}` in the text is filled from the tab's environment in the reading view.

import { filled, holeNames, holeStrip } from "./template.js";

const KIND = "org.onedesk.note:note";

// "read" or "edit" (the default): view state of the tab (`view.mode`, D467), switched only by the "toggle" action.
export function modeOf(ctx) {
  return ctx.params && ctx.params["view.mode"] === "read" ? "read" : "edit";
}

// The note text as the person sees it: the unsaved draft first, then the saved body.
export function textOf(ctx) {
  if (ctx.draft && typeof ctx.draft["body.text"] === "string") return ctx.draft["body.text"];
  const b = ctx.resource && ctx.resource.body;
  return b && typeof b.text === "string" ? b.text : "";
}

export default {
  activate(host) {
    host.pages.handle("editor", {
      async render(ctx) {
        const text = textOf(ctx);
        const view = [];
        // The placeholders and the environment's value of each; typing one overrides it on this tab.
        const strip = await holeStrip(ctx, holeNames(text));
        if (strip) view.push(strip);
        if (modeOf(ctx) === "read") {
          // Reading view: the unsaved draft, filled from the environment, rendered as Markdown.
          view.push({ type: "text", id: "reading", text: await filled(ctx, text), format: "markdown" });
          return { view };
        }
        view.push({
          type: "form",
          id: "content",
          layout: "stack",
          fields: [
            {
              name: "text",
              label: ctx.t("field.text"),
              kind: "longtext",
              bind: "body.text",
              fill: true,
              placeholder: ctx.t("field.placeholder"),
            },
          ],
        });
        return { view };
      },

      async onEvent(ctx, event) {
        if (event !== "toggle") throw new Error(`unknown event ${event}`);
        const next = modeOf(ctx) === "read" ? "edit" : "read";
        return { params: { "view.mode": next }, message: ctx.t(next === "read" ? "message.reading" : "message.editing") };
      },
    });

    host.commands.handle("duplicate", async (ctx, context) => {
      const id = context && context.nodeKey;
      if (!id) return [];
      const original = await ctx.host.resources.get(id);
      if (!original) {
        return [{ type: "toast", message: ctx.t("error.notFound"), tone: "danger" }];
      }
      const copy = await ctx.host.resources.create({
        kind: KIND,
        parent: original.parentId,
        name: `${original.name} (${suffix(ctx)})`,
        description: original.description,
        tags: original.tags,
        body: { text: (original.body && original.body.text) || "" },
      });
      await ctx.host.ui.open(`resource:${copy.id}`);
      return [];
    });
  },
};

// Plain text for a resource name: the current locale's word for "copy".
function suffix(ctx) {
  const label = ctx.t("copy.suffix");
  if (typeof label === "string") return label;
  return label[ctx.locale] || label["en-US"] || "copy";
}
