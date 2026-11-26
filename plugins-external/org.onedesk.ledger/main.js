// Ledger plugin (docs/redesign/book.md §27, D489): a stock ledger as a book — the setup page, the catalog of items, each
// item's ledger pages, receipts, issues and stocktakes (audited, posted, reversed in red), and the monthly summary
// where the month is closed. Its kinds play roles in books through the interface `onedesk.book/1`.
// Runs in the sandbox: no console, timers or fetch; everything goes through ctx.host.

import { NONE, say } from "./common.js";
import { embedItem, embedSheet, renderItem, renderSheet } from "./item.js";
import { catalogEntries, catalogEvent, renderCatalog, renderRegister, renderSetup } from "./pages.js";
import { numberVoucher, postAction, renderVoucher, voucherEvent } from "./voucher.js";
import { exportAction, renderSummary, summaryEvent } from "./summary.js";
import { ROLES } from "./roles.js";

export default {
  activate(host) {
    host.kinds.handle("item", { embed: embedItem });
    host.kinds.handle("sheet", { embed: embedSheet });

    host.pages.handle("setup", { render: renderSetup });
    host.pages.handle("catalog", { render: renderCatalog, onEvent: catalogEvent });
    host.pages.handle("item", { render: renderItem });
    host.pages.handle("sheet", { render: renderSheet });
    host.pages.handle("voucher", { render: renderVoucher, onEvent: voucherEvent });
    host.pages.handle("vouchers", { render: renderRegister });
    host.pages.handle("summary", { render: renderSummary, onEvent: summaryEvent });

    host.actions.handle("post", postAction);
    host.actions.handle("export", exportAction);

    // `onedesk.book/1`.
    host.actions.handle("roles", async () => ({ output: NONE, data: ROLES }));
    host.actions.handle("outline", async () => ({ output: NONE, data: { headings: [], figures: [], cites: [], terms: [] } }));
    host.actions.handle("entries", async (ctx, input) => ({ output: NONE, data: await catalogEntries(ctx, input) }));
    // D487 §31.6: what the book's conventions say of this ledger (asked of the setup page).
    host.actions.handle("conventions", async (ctx) => {
      const r = ctx.resource;
      if (!r || !String(r.kind).endsWith(":setup")) return { output: NONE, data: { lines: [] } };
      const b = r.body || {};
      const dec = (v) => (Number.isInteger(v) ? v : 2);
      const lines = [say(ctx, b.method === "fifo" ? "conv.method.fifo" : "conv.method.moving"), say(ctx, "conv.decimals", { qty: dec(b.qtyDecimals), amount: dec(b.amountDecimals) }), say(ctx, "conv.numbers"), say(ctx, "conv.closed")];
      return { output: NONE, data: { lines } };
    });

    host.events.on("resource.changed", numberVoucher);
  },
};
