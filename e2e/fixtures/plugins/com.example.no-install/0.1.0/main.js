// Fixture: asks the host to install a plugin without declaring requires.plugins.install. The host refuses
// (denied / notRequested); the error is not caught, so the run fails with the host's code and params.
export default {
  activate(host) {
    host.kinds.handle("thing", {});
    host.pages.handle("editor", {
      async render(ctx) {
        return { view: [{ type: "form", id: "f", layout: "stack", fields: [{ name: "text", label: ctx.t("kind.thing"), kind: "text", bind: "body.text" }] }] };
      },
    });
    host.actions.handle("try", async (ctx, input) => {
      const res = await ctx.host.plugins.requestInstall({ folder: String((input && input["body.text"]) || "/") });
      return { output: { type: "text", text: String(res.outcome) } };
    });
  },
};
