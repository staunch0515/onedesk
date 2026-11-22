// e2e probe for round 19 (MCP): everything it does is deterministic; `calls` counts how often the AI-facing actions really ran.
let aiCalls = 0;
export default {
  activate(host) {
    host.actions.handle("rows", async (ctx) => {
      aiCalls++;
      const n = Math.max(0, Math.floor(Number((ctx.params && ctx.params.n) || 3)));
      const rows = [];
      for (let i = 0; i < n; i++) rows.push([i + 1, `${ctx.resource ? ctx.resource.name : "-"}`, i === 0 && ctx.params && ctx.params.mode === "b" ? "x".repeat(3000) : `cell-${i + 1}`]);
      return { output: { type: "table", columns: [{ key: "i", label: "I" }, { key: "item", label: "Item" }, { key: "cell", label: "Cell" }], rows, total: rows.length } };
    });
    host.actions.handle("write", async () => ({ output: { type: "text", text: "wrote" } }));
    host.actions.handle("aiPing", async (ctx, input) => {
      aiCalls++;
      return { output: { type: "text", text: JSON.stringify({ pong: input.text, mode: input.mode || null, client: (ctx.ai && ctx.ai.client) || null }) } };
    });
    host.actions.handle("aiFree", async () => {
      aiCalls++;
      return { output: { type: "text", text: "free-ran" } };
    });
    host.actions.handle("calls", async () => ({ output: { type: "text", text: String(aiCalls) } }));
  },
};
