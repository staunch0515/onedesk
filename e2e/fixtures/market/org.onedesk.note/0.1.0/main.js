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

// First-version body { content } becomes { text }. An existing `text` wins; other keys are kept.
export function upgradeBody(body) {
  const old = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const text = typeof old.text === "string" ? old.text : legacyText(old.content);
  return { ...legacyRest(old, ["content", "text"]), text };
}

export default {
  activate(host) {
    host.kinds.handle("note", {
      upgrade(ctx, args) {
        return { body: upgradeBody(args && args.body) };
      },
    });
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
              envValue: "edit", // the shown value until a mode has been chosen (the page starts in edit mode)
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
