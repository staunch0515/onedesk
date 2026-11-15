// Demo plugin for the spike: a SQL-like resource page.
import { tokenizeParams } from "./params.js";

export default {
  activate(host) {
    host.kinds.handle("sql", {
      // (b) recompute parameters from unsaved text
      parameters(ctx, input) {
        return tokenizeParams(input.sql).map((name) => ({ name, type: "text" }));
      },
    });

    host.pages.handle("editor", {
      // (a) render: ~60 nodes
      render(ctx) {
        const sql = (ctx.body && ctx.body.sql) || "";
        const params = tokenizeParams(sql);
        const fields = [
          { name: "sql", label: "SQL", type: "code", bind: "body.sql", value: sql, fill: true },
          { name: "datasource", label: "Data source", type: "resource", bind: "body.datasource", fill: false },
          { name: "limit", label: "Limit", type: "number", bind: "body.limit", value: 100, fill: false },
        ];
        for (const p of params) fields.push({ name: "p_" + p, label: p, type: "text", fill: false });
        const columns = [];
        for (let i = 0; i < 8; i++) columns.push({ key: "c" + i, title: "Column " + i });
        const rows = [];
        for (let r = 0; r < 20; r++) {
          const row = [];
          for (let i = 0; i < 8; i++) row.push(i === 0 ? r : "value " + r + "-" + i);
          rows.push(row);
        }
        const children = [
          { type: "form", fields },
          { type: "text", text: ctx.name + " (" + ctx.lang + ", " + ctx.env + ")" },
          { type: "table", columns, rows, onRow: "pick" },
          { type: "link", label: "Docs", href: "https://example.com/docs" },
        ];
        for (let i = 0; i < 41; i++) {
          children.push({ type: "text", text: "log line " + i, tone: i % 7 === 0 ? "error" : "normal" });
        }
        return { type: "stack", children };
      },
      async onEvent(ctx, ev) {
        if (ev.event === "slow") { await ctx.host.test.sleep(5000); return { done: true }; }
        if (ev.event === "spin") { while (true) {} }
        if (ev.event === "badView") return { type: "iframe", src: "x" };
        if (ev.event === "count") {
          const n = ((await ctx.host.storage.get("count")) || 0) + 1;
          await ctx.host.storage.set("count", n);
          return { count: n };
        }
        return { echo: ev };
      },
    });
  },
};
