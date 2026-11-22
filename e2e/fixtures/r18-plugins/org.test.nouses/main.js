// e2e probe: does NOT declare `uses`; tries the AI interface and reading a run outside a result-area click.
export default {
  activate(host) {
    host.actions.handle("probe", async (ctx, input) => {
      const out = {};
      const code = (e) => ({ code: e && e.code, reason: e && e.params && e.params.reason });
      try { await ctx.host.interfaces.call("onedesk.ai.chat/1", "chat", { messages: [] }, { resource: "x" }); out.call = "ok"; } catch (e) { out.call = code(e); }
      try { await ctx.host.interfaces.list("onedesk.ai.chat/1"); out.list = "ok"; } catch (e) { out.list = code(e); }
      try { await ctx.host.runs.read(String((input && input.runId) || "x")); out.read = "ok"; } catch (e) { out.read = code(e); }
      return { output: { type: "text", text: JSON.stringify(out) } };
    });
  },
};
