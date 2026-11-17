// Welcome plugin: one standalone startup page. It lists the four "new" entries of the built-in plugins.
// There is no host interface yet to ask which plugins are enabled, so every entry is always shown
// (an entry whose plugin is off simply cannot create anything) — see the hand-over note.

export const ENTRIES = [
  { id: "note", label: "entry.note", target: "new:org.onedesk.note:note" },
  { id: "link", label: "entry.link", target: "new:org.onedesk.link:link" },
  { id: "prompt", label: "entry.prompt", target: "new:org.onedesk.prompt:prompt" },
  { id: "http", label: "entry.http", target: "new:org.onedesk.http:request" },
];

function tr(ctx, key) {
  const label = ctx.t(key);
  return typeof label === "string" ? label : label[ctx.locale] || label["en-US"] || key;
}

export default {
  activate(host) {
    host.pages.handle("welcome", {
      async render(ctx) {
        return {
          title: tr(ctx, "page.title"),
          view: [
            { type: "text", id: "intro", text: tr(ctx, "intro"), format: "markdown" },
            ...ENTRIES.map((e) => ({ type: "link", id: e.id, label: ctx.t(e.label), target: e.target })),
          ],
        };
      },
    });
  },
};
