// Notes plugin: one kind ("note"), one page ("editor"), one command ("duplicate").
// Runs in the sandbox: no console, timers or fetch; everything goes through ctx.host.

const KIND = "org.onedesk.note:note";

export default {
  activate(host) {
    host.pages.handle("editor", {
      async render(ctx) {
        return {
          view: [
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
