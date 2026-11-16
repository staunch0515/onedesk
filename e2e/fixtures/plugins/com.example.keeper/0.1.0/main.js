// Fixture: "keeper". Checks idle release (draft kept in ctx.host.storage survives) and stale host contexts: the
// `stash` action keeps that run's ctx.host in a module variable, the page event `abuse` then uses it
// (network.request is only allowed inside a run) and returns the host's error as the message.
// Sandbox rules: no console, timers or fetch; everything goes through ctx.host.

const DRAFT_KEY = "draft";
const SLOW_MS = 20000;
let stashed = null;

export function tr(ctx, key, vars) {
  const label = ctx.t(key);
  let text = typeof label === "string" ? label : label[ctx.locale] || label["en-US"] || key;
  for (const k of Object.keys(vars || {})) text = text.split(`{${k}}`).join(String(vars[k]));
  return text;
}

const draftText = (ctx) => (ctx.draft && typeof ctx.draft["body.text"] === "string" ? ctx.draft["body.text"] : String((ctx.resource && ctx.resource.body && ctx.resource.body.text) || ""));

export default {
  activate(host) {
    host.kinds.handle("box", {});

    host.pages.handle("editor", {
      async render(ctx) {
        const field = { name: "text", label: ctx.t("field.text"), kind: "text", bind: "body.text" };
        if (ctx.run) field.readOnly = true;
        return { view: [{ type: "form", id: "text", layout: "stack", fields: [field] }] };
      },

      async onEvent(ctx, event) {
        if (event === "remember") {
          await ctx.host.storage.set(DRAFT_KEY, draftText(ctx));
          return { message: tr(ctx, "message.remembered") };
        }
        if (event === "recall") {
          const text = await ctx.host.storage.get(DRAFT_KEY);
          if (text === null || text === undefined) return { message: tr(ctx, "message.nothing") };
          return { changes: { "body.text": text } };
        }
        if (event === "abuse") {
          if (!stashed) return { message: tr(ctx, "message.nothingStashed") };
          try {
            await stashed.network.request({ method: "GET", url: "https://example.com/" });
            return { message: "request went through" };
          } catch (err) {
            return { message: String(err && err.message) };
          }
        }
        throw new Error(`unknown event ${event}`);
      },
    });

    host.pages.handle("tree", {
      async render(ctx) {
        return { view: [{ type: "text", id: "t", text: tr(ctx, "page.tree") }] };
      },
    });

    host.actions.handle("stash", async (ctx) => {
      stashed = ctx.host;
      return { output: { type: "text", text: "stashed" } };
    });

    host.actions.handle("slow", async (ctx) => {
      await ctx.host.util.sleep(SLOW_MS);
      return { output: { type: "text", text: tr(ctx, "result.slow") } };
    });

    host.trees.handle("keeper", {
      async children(ctx, parentKey) {
        if (parentKey) return { nodes: [] };
        return {
          nodes: [{ key: "node", label: tr(ctx, "node.label", { locale: ctx.locale }), icon: "archive", expandable: false, target: "node:com.example.keeper:keeper/node" }],
        };
      },
      async path(ctx, key) {
        return [key];
      },
    });
  },
};
