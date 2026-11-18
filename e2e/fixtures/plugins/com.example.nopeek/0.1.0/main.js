// Fixture: "nopeek". The action `peek` calls ctx.host.resources.search with the JSON in the resource's `query` field and
// outputs the raw result (or the host error as {"error": code, "reason": …}). Does NOT declare requires.resources.
// Sandbox rules: no console, timers or fetch; everything goes through ctx.host.

export default {
  activate(host) {
    host.actions.handle("peek", async (ctx, input) => {
      const raw = (input && input["body.query"]) || (ctx.resource && ctx.resource.body && ctx.resource.body.query) || "{}";
      try {
        const res = await ctx.host.resources.search(JSON.parse(raw));
        return { output: { type: "text", text: JSON.stringify(res) } };
      } catch (e) {
        if (e && e.code) return { output: { type: "text", text: JSON.stringify({ error: e.code, reason: (e.params && e.params.reason) || null }) } };
        throw e;
      }
    });
    host.pages.handle("editor", {
      async render(ctx) {
        return { view: [{ type: "form", id: "probe", layout: "stack", fields: [{ name: "query", label: ctx.t("field.query"), kind: "code", bind: "body.query", fill: true }] }] };
      },
    });
  },
};
