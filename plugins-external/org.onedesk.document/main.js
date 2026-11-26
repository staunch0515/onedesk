// Document plugin (docs/redesign/book.md §23, D487): templates (the form with its blanks), documents written from them
// (filled in right in the text, signed, revised, voided) and series (many documents from one template, in order, in a
// book). Its kinds play roles in books through the interface `onedesk.book/1`.
// Runs in the sandbox: no console, timers or fetch; everything goes through ctx.host.

import { NONE, say } from "./common.js";
import { copyTemplate, documentEvent, embedDocument, renderDocument } from "./doc.js";
import { renderTemplate } from "./template-page.js";
import { keepInOrder, placeInSeries, renderSeries, seriesEvent } from "./series.js";
import { ROLES } from "./roles.js";
import { letterReply, letterTasks, letterTodo, onLetterReply, renderSignoff } from "./signoff.js";

export default {
  activate(host) {
    host.kinds.handle("document", { embed: embedDocument });
    host.kinds.handle("series", { place: placeInSeries });

    host.pages.handle("template", { render: renderTemplate });
    host.pages.handle("document", { render: renderDocument, onEvent: documentEvent });
    host.pages.handle("series", { render: renderSeries, onEvent: seriesEvent });
    host.pages.handle("signoff", { render: renderSignoff });

    // D487 §35: `onedesk.letter/1` — a document sent for review or reading.
    host.actions.handle("tasks", letterTasks);
    host.actions.handle("todo", letterTodo);
    host.actions.handle("reply", letterReply);
    host.events.on("letter.reply", onLetterReply);

    // `onedesk.book/1`.
    host.actions.handle("roles", async () => ({ output: NONE, data: ROLES }));
    // D487 §31.6: what the book's conventions say of documents.
    host.actions.handle("conventions", async (ctx) => {
      const short = String((ctx.resource && ctx.resource.kind) || "").split(":").pop();
      return { output: NONE, data: { lines: short === "document" || short === "series" ? [say(ctx, "conv.document")] : [] } };
    });
    host.actions.handle("outline", async () => ({ output: NONE, data: { headings: [], figures: [], cites: [], terms: [] } }));

    host.events.on("resource.changed", async (ctx, event) => {
      await copyTemplate(ctx, event);
      await keepInOrder(ctx, event);
    });
  },
};
