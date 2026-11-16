// Fixture: a small well-behaved plugin for the market folder. One kind, one page, no permissions.
export default {
  activate(host) {
    host.kinds.handle("greeting", {});
    host.pages.handle("editor", {
      async render(ctx) {
        return {
          view: [{ type: "form", id: "text", layout: "stack", fields: [{ name: "text", label: ctx.t("field.text"), kind: "text", bind: "body.text" }] }],
        };
      },
    });
  },
};
