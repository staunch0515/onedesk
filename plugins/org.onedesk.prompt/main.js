// Prompt plugin: one kind ("prompt"), one page ("editor") with an input per {{name}} in the text (showing the
// environment's value, which a typed value overrides), an event "copy" (fills the text and puts it on the clipboard)
// and an action "preview".
// The placeholder syntax is this plugin's own (the core only hands out values by name).

export function tr(ctx, key, vars) {
  const label = ctx.t(key);
  let text = typeof label === "string" ? label : label[ctx.locale] || label["en-US"] || key;
  for (const k of Object.keys(vars || {})) text = text.split(`{${k}}`).join(String(vars[k]));
  return text;
}

// {{name}} placeholders (template.js, shared with the other template plugins, D466): a typed value first, else the
// tab's environment.
import { fillHoles, holeNames, holeStrip, holeValues } from "./template.js";
export { fillHoles, holeNames };

function textOf(ctx, input) {
  if (input && typeof input["body.text"] === "string") return input["body.text"];
  if (ctx.run && ctx.run.input && typeof ctx.run.input["body.text"] === "string") return ctx.run.input["body.text"];
  if (ctx.draft && typeof ctx.draft["body.text"] === "string") return ctx.draft["body.text"];
  const b = ctx.resource && ctx.resource.body;
  return b && typeof b.text === "string" ? b.text : "";
}

export default {
  activate(host) {
    host.pages.handle("editor", {
      async render(ctx) {
        const text = textOf(ctx);
        const ro = ctx.run ? { readOnly: true } : {};
        const view = [];
        const strip = await holeStrip(ctx, holeNames(text), "params");
        if (strip) view.push(strip);
        view.push({
          type: "form",
          id: "content",
          layout: "stack",
          fields: [{ name: "text", label: ctx.t("field.text"), kind: "longtext", bind: "body.text", fill: true, placeholder: ctx.t("field.text.placeholder"), ...ro }],
        });
        return { view };
      },

      async onEvent(ctx, event) {
        if (event !== "copy") throw new Error(`unknown event ${event}`);
        const text = textOf(ctx);
        const { values } = await holeValues(ctx, holeNames(text));
        await ctx.host.ui.copy(fillHoles(text, values));
        return { message: tr(ctx, "message.copied") };
      },
    });

    host.actions.handle("preview", async (ctx, input) => {
      const text = textOf(ctx, input);
      const names = holeNames(text);
      const { values } = await holeValues(ctx, names);
      const filled = names.filter((n) => typeof values[n] === "string" && values[n] !== "").length;
      return {
        output: { type: "text", text: fillHoles(text, values) },
        summary: { message: tr(ctx, "summary.preview", { count: names.length, filled }) },
      };
    });
  },
};
