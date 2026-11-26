// Book plugin (docs/redesign/book.md, D487): a book only binds pages; every role a page plays brings its own logic and
// lives in its own file — the book (book.js), the cover (cover.js), the contents (toc.js), text pages (text-page.js),
// the appendix (appendix.js). The roles are told to other plugins through the interface `onedesk.book/1` (roles.js).
// Runs in the sandbox: no console, timers or fetch; everything goes through ctx.host.

import { renderAppendix } from "./appendix.js";
import { embedBook, onBookCreated, place, renderBook } from "./book.js";
import { embedCover, renderCover } from "./cover.js";
import { full, rolesData, split } from "./roles.js";
import { embedText, outlineOf, renderText, TEXT_KINDS, toggleText } from "./text-page.js";
import { bookOf, contentsOf, contentsOfBook, embedToc, entriesOf, exportBook, renderToc, settingsOf, tocEvent } from "./toc.js";
import { citeLabels, embedReference, embedReferences, renderReference, renderReferences } from "./references.js";
import { embedIndex, renderIndex } from "./index.js";
import { embedFigures, renderFigures } from "./figures.js";
import { aiContents, aiPage, aiRefs } from "./ai.js";
import { colophonEvent, embedColophon, printAction, publishAction, renderColophon, reprintAction } from "./colophon.js";

const NONE = { type: "none" };

export default {
  activate(host) {
    host.kinds.handle("book", { place, embed: embedBook });
    host.kinds.handle("cover", { embed: embedCover });
    host.kinds.handle("toc", { embed: embedToc });
    for (const k of TEXT_KINDS) host.kinds.handle(k, { embed: embedText });
    // D487 §15
    const here = async (ctx) => (ctx.resource && ctx.resource.id ? contentsOf(ctx, ctx.resource) : null);
    host.kinds.handle("references", { embed: async (ctx) => embedReferences(ctx, await here(ctx)) });
    host.kinds.handle("reference", { embed: embedReference });
    host.kinds.handle("index", { embed: embedIndex });
    host.kinds.handle("figures", { embed: embedFigures });
    // D487 §21
    host.kinds.handle("colophon", { embed: embedColophon });

    host.pages.handle("book", { render: renderBook });
    host.pages.handle("cover", { render: renderCover });
    host.pages.handle("toc", { render: renderToc, onEvent: tocEvent });
    host.pages.handle("text", {
      render: renderText,
      onEvent(ctx, event) {
        if (event !== "toggle") throw new Error(`unknown event ${event}`);
        return toggleText(ctx);
      },
    });
    host.pages.handle("appendix", { render: renderAppendix });
    host.pages.handle("references", { render: async (ctx) => renderReferences(ctx, await here(ctx)) });
    host.pages.handle("reference", { render: renderReference });
    host.pages.handle("index", { render: renderIndex });
    host.pages.handle("figures", { render: renderFigures });
    host.pages.handle("colophon", { render: renderColophon, onEvent: colophonEvent });

    host.actions.handle("export", exportBook);
    host.actions.handle("publish", publishAction);
    host.actions.handle("reprint", reprintAction);
    host.actions.handle("print", printAction);

    // `onedesk.book/1` (§13.6): what this plugin's kinds are in a book; what a page holds; a book's numbered items.
    host.actions.handle("roles", async () => ({ output: NONE, data: rolesData() }));
    host.actions.handle("outline", async (ctx) => {
      const r = ctx.resource;
      const [, short] = split(r && r.kind);
      const text = r && r.body && typeof r.body.text === "string" ? r.body.text : "";
      return { output: NONE, data: TEXT_KINDS.includes(short) ? outlineOf(text) : { headings: [], figures: [] } };
    });
    host.actions.handle("entries", async (ctx, input) => {
      // D487 §19: by book (`{ book }`, called with `{ plugin }`): numbered as this plugin numbers, for another contents.
      if (input && typeof input.book === "string") {
        const b = await ctx.host.resources.get(input.book);
        if (!b || b.kind !== full("book")) return { output: NONE, data: { items: [] } };
        const e = await contentsOfBook(ctx, b.id, input.roles);
        return { output: NONE, data: { items: e.items, figures: e.figures, terms: e.terms, cites: e.cites.map(({ keys, notes, item }) => ({ keys, notes, item })) } };
      }
      const toc = ctx.resource;
      const book = toc && toc.kind === full("toc") ? await bookOf(ctx, toc) : null;
      if (!book) return { output: NONE, data: { items: [] } };
      const depth = input && Number.isInteger(input.depth) ? input.depth : 0;
      const inherited = input && input.settings && typeof input.settings === "object" ? input.settings : null;
      const e = await entriesOf(ctx, book.id, settingsOf(ctx, toc.body, inherited), { level: depth + 1 });
      return { output: NONE, data: { items: e.items, figures: e.figures, terms: e.terms, cites: e.cites.map(({ keys, notes, item }) => ({ keys, notes, item })) } };
    });

    // D487 §15: a book's numbers for resources in it; how citations are shown.
    host.actions.handle("number", async (ctx, input) => {
      const toc = ctx.resource;
      const book = toc && toc.kind === full("toc") ? await bookOf(ctx, toc) : null;
      if (!book) return { output: NONE, data: { labels: {} } };
      const e = await entriesOf(ctx, book.id, settingsOf(ctx, toc.body, null));
      const labels = {};
      for (const id of (input && Array.isArray(input.targets) ? input.targets : [])) if (e.labels.has(id)) labels[id] = e.labels.get(id);
      return { output: NONE, data: { labels } };
    });
    host.actions.handle("cite", async (ctx, input) => {
      const cites = (input && Array.isArray(input.cites) ? input.cites : []).filter((c) => c && Array.isArray(c.keys));
      const r = await citeLabels(ctx, ctx.resource, cites.map((c) => ({ keys: c.keys, notes: Array.isArray(c.notes) ? c.notes : c.keys.map(() => null) })));
      return { output: NONE, data: { labels: r.labels } };
    });

    // D487 §29.4: what an AI reads of a book (tools; read only).
    host.actions.handle("aiContents", aiContents);
    host.actions.handle("aiPage", aiPage);
    host.actions.handle("aiRefs", aiRefs);

    host.events.on("resource.changed", onBookCreated);
  },
};
