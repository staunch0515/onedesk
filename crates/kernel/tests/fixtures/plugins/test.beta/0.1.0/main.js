export default {
  activate(host) {
    host.pages.handle("view", { async render(ctx) { return { view: [{ type: "text", id: "t", text: ctx.resource.name }] }; } });
    host.commands.handle("probe", async (ctx, context) => {
      const a = context.args || {};
      const [cap, op] = String(a.method).split(".");
      try {
        const r = await ctx.host[cap][op](...(a.args || []));
        return [{ type: "copy", text: JSON.stringify({ ok: r === undefined ? null : r }) }];
      } catch (e) {
        return [{ type: "copy", text: JSON.stringify({ error: e.code || String(e) }) }];
      }
    });
  },
};
