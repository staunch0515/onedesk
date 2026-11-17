// Notes plugin: one kind ("note"), one page ("editor"), one command ("duplicate").
// Runs in the sandbox: no console, timers or fetch; everything goes through ctx.host.

const KIND = "org.onedesk.note:note";

// "read" or "edit" (the default), from the page parameter `mode`.
export function modeOf(ctx) {
  return ctx.params && ctx.params.mode === "read" ? "read" : "edit";
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
        const reading = modeOf(ctx) === "read";
        // The mode is a page parameter (never part of the draft). It is declared as a `param: true` field so the shell keeps it.
        const modeForm = {
          type: "form",
          id: "mode",
          layout: "strip",
          fields: [
            {
              name: "mode",
              label: ctx.t("field.mode"),
              kind: "enum",
              param: true,
              options: [
                { value: "edit", label: ctx.t("mode.edit") },
                { value: "read", label: ctx.t("mode.read") },
              ],
            },
          ],
        };
        if (reading) {
          // Reading view: the unsaved draft, rendered as Markdown.
          return { view: [modeForm, { type: "text", id: "reading", text: textOf(ctx), format: "markdown" }] };
        }
        return {
          view: [
            modeForm,
            {
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
            },
          ],
        };
      },

      async onEvent(ctx, event) {
        if (event !== "toggle") throw new Error(`unknown event ${event}`);
        const next = modeOf(ctx) === "read" ? "edit" : "read";
        return { params: { mode: next }, message: ctx.t(next === "read" ? "message.reading" : "message.editing") };
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
