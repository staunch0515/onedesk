// e2e probe: declares `uses` for the chat interface and an interface nobody implements.
export default {
  activate(host) {
    host.actions.handle("probe", async (ctx, input) => {
      const out = {};
      const i = input || {};
      const code = (e) => ({ code: e && e.code, reason: e && e.params && e.params.reason });
      try { out.list = (await ctx.host.interfaces.list("onedesk.ai.chat/1")).map((x) => x.kind).sort(); } catch (e) { out.list = code(e); }
      try { await ctx.host.interfaces.call("x.none/1", "chat", {}, { resource: String(i.good || "x") }); out.none = "ok"; } catch (e) { out.none = code(e); }
      try { await ctx.host.interfaces.call("onedesk.ai.chat/1", "chat", { messages: [{ role: "user", text: "hi" }] }, { resource: String(i.wrong || "x") }); out.wrong = "ok"; } catch (e) { out.wrong = code(e); }
      try { await ctx.host.interfaces.call("onedesk.ai.chat/1", "chat", { messages: [] }, { resource: "no-such-resource" }); out.missing = "ok"; } catch (e) { out.missing = code(e); }
      try { const r = await ctx.host.interfaces.call("onedesk.ai.chat/1", "chat", { messages: [{ role: "user", text: "hi" }] }, { resource: String(i.good || "x") }); out.good = r && r.data ? r.data.text : "no data"; } catch (e) { out.good = code(e); }
      return { output: { type: "text", text: JSON.stringify(out) } };
    });
  },
};
