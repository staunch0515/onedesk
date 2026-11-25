// Book plugin (docs/redesign/book.md, D487): a book only binds pages; every role a page plays brings its own logic and
// lives in its own file — the book (book.js), the cover (cover.js), the contents (toc.js), text pages (text-page.js),
// the appendix (appendix.js). The roles are told to other plugins through the interface `onedesk.book/1` (roles.js).
// Runs in the sandbox: no console, timers or fetch; everything goes through ctx.host.

import { renderAppendix } from "./appendix.js";
import { embedBook, onBookCreated, place, renderBook } from "./book.js";
import { embedCover, renderCover } from "./cover.js";
import { full, rolesData, split } from "./roles.js";
import { embedText, outlineOf, renderText, TEXT_KINDS, toggleText } from "./text-page.js";
import { bookOf, embedToc, entriesOf, exportBook, renderToc, settingsOf, tocEvent } from "./toc.js";

const NONE = { type: "none" };

export default {
  activate(host) {
    host.kinds.handle("book", { place, embed: embedBook });
    host.kinds.handle("cover", { embed: embedCover });
    host.kinds.handle("toc", { embed: embedToc });
    for (const k of TEXT_KINDS) host.kinds.handle(k, { embed: embedText });

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

    host.actions.handle("export", exportBook);

    // `onedesk.book/1` (§13.6): what this plugin's kinds are in a book; what a page holds; a book's numbered items.
    host.actions.handle("roles", async () => ({ output: NONE, data: rolesData() }));
    host.actions.handle("outline", async (ctx) => {
      const r = ctx.resource;
      const [, short] = split(r && r.kind);
      const text = r && r.body && typeof r.body.text === "string" ? r.body.text : "";
      return { output: NONE, data: TEXT_KINDS.includes(short) ? outlineOf(text) : { headings: [], figures: [] } };
    });
    host.actions.handle("entries", async (ctx, input) => {
      const toc = ctx.resource;
      const book = toc && toc.kind === full("toc") ? await bookOf(ctx, toc) : null;
      if (!book) return { output: NONE, data: { items: [] } };
      const depth = input && Number.isInteger(input.depth) ? input.depth : 0;
      const inherited = input && input.settings && typeof input.settings === "object" ? input.settings : null;
      const { items } = await entriesOf(ctx, book.id, settingsOf(ctx, toc.body, inherited), { level: depth + 1 });
      return { output: NONE, data: { items } };
    });

    host.events.on("resource.changed", onBookCreated);
  },
};
