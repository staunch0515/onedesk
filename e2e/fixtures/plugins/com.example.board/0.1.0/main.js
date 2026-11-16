// Fixture: example "board" plugin. Owns two stored trees (board, hidden), exports "board" and the "card" page.
// The card page edits body.text; the "upper" event upper-cases the unsaved text and returns it through `changes`.
// It also renders cards of other plugins' kinds that use this page (ctx.resource is read-only then).
// Sandbox rules: no console, timers or fetch; everything goes through ctx.host.

export function tr(ctx, key, vars) {
  const label = ctx.t(key);
  let text = typeof label === "string" ? label : label[ctx.locale] || label["en-US"] || key;
  for (const k of Object.keys(vars || {})) text = text.split(`{${k}}`).join(String(vars[k]));
  return text;
}

export default {
  activate(host) {
    host.kinds.handle("card", {});

    host.pages.handle("card", {
      async render(ctx) {
        const ro = !!ctx.run;
        return {
          view: [
            {
              type: "form",
              id: "body",
              layout: "stack",
              fields: [{ name: "text", label: ctx.t("field.text"), kind: "longtext", bind: "body.text", ...(ro ? { readOnly: true } : {}) }],
            },
          ],
        };
      },

      async onEvent(ctx, event) {
        if (event !== "upper") throw new Error(`unknown event ${event}`);
        const draft = ctx.draft && typeof ctx.draft["body.text"] === "string" ? ctx.draft["body.text"] : String((ctx.resource && ctx.resource.body && ctx.resource.body.text) || "");
        return { changes: { "body.text": draft.toUpperCase() }, message: tr(ctx, "message.upper") };
      },
    });

  },
};
