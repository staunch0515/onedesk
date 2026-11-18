// Prompt plugin: one kind ("prompt"), one page ("editor") with an input per {{name}} in the text,
// an event "copy" (fills the text and puts it on the clipboard) and an action "preview".
// The placeholder syntax is this plugin's own (the core only hands out values by name).

export function tr(ctx, key, vars) {
  const label = ctx.t(key);
  let text = typeof label === "string" ? label : label[ctx.locale] || label["en-US"] || key;
  for (const k of Object.keys(vars || {})) text = text.split(`{${k}}`).join(String(vars[k]));
  return text;
}

// {{name}}: letters, digits, '_', '-' and Chinese characters, 1 to 40 of them. "{{secret:x}}" has a colon, so it is not one.
const HOLE = /\{\{([A-Za-z0-9_\-一-鿿]{1,40})\}\}/g;

export function holeNames(text) {
  const out = [];
  for (const m of String(text || "").matchAll(HOLE)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

// Typed values go in; a placeholder without a value stays as written.
export function fillHoles(text, values) {
  return String(text || "").replace(HOLE, (all, name) => {
    const v = values && values[name];
    return typeof v === "string" && v !== "" ? v : all;
  });
}

function textOf(ctx, input) {
  if (input && typeof input["body.text"] === "string") return input["body.text"];
  if (ctx.run && ctx.run.input && typeof ctx.run.input["body.text"] === "string") return ctx.run.input["body.text"];
  if (ctx.draft && typeof ctx.draft["body.text"] === "string") return ctx.draft["body.text"];
  const b = ctx.resource && ctx.resource.body;
  return b && typeof b.text === "string" ? b.text : "";
}

// A first-version body field as text: strings as they are, numbers and booleans as written, anything else empty.
function legacyText(value) {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function legacyRest(body, used) {
  const rest = {};
  for (const k of Object.keys(body)) if (!used.includes(k)) rest[k] = body[k];
  return rest;
}

// First-version body { template, parameters: [{ name, label?, default?, required? }] } becomes { text }.
// The old syntax allowed spaces inside the braces ({{ name }}); this plugin's does not, so they are removed.
// Parameter definitions have no field any more (the page lists the placeholders itself): they stay in the body
// as `parameters` so nothing is lost, unused by this plugin.
export function upgradeBody(body) {
  const old = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const source = typeof old.text === "string" ? old.text : legacyText(old.template);
  const text = source.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, "{{$1}}");
  return { ...legacyRest(old, ["template", "text"]), text };
}

export default {
  activate(host) {
    host.kinds.handle("prompt", {
      upgrade(ctx, args) {
        return { body: upgradeBody(args && args.body) };
      },
    });
    host.pages.handle("editor", {
      async render(ctx) {
        const text = textOf(ctx);
        const ro = ctx.run ? { readOnly: true } : {};
        const view = [];
        const names = holeNames(text);
        if (names.length > 0) {
          view.push({
            type: "form",
            id: "params",
            layout: "strip",
            fields: names.map((name) => {
              const f = { name, label: name, kind: "text", param: true };
              if (ctx.run) {
                f.envValue = (ctx.run.params && ctx.run.params[name]) || "";
                f.readOnly = true;
              }
              return f;
            }),
          });
        }
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
        await ctx.host.ui.copy(fillHoles(textOf(ctx), ctx.params));
        return { message: tr(ctx, "message.copied") };
      },
    });

    host.actions.handle("preview", async (ctx, input) => {
      const text = textOf(ctx, input);
      const names = holeNames(text);
      const values = ctx.params || {};
      const filled = names.filter((n) => typeof values[n] === "string" && values[n] !== "").length;
      return {
        output: { type: "text", text: fillHoles(text, values) },
        summary: { message: tr(ctx, "summary.preview", { count: names.length, filled }) },
      };
    });
  },
};
