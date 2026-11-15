// Test plugin for runs: behaviour is chosen by the first word of the job's text.
const table = (rows) => ({ type: "table", columns: [{ key: "n", label: "n", numeric: true }, { key: "v", label: "v" }], rows });

async function run(ctx, input) {
  const text = String(input["body.text"] || "");
  const [word, arg] = text.split(/\s+/);
  const h = ctx.host;
  if (word === "fail") throw new Error("boom from plugin");
  if (word === "wrongtype") return { output: { type: "text", text: "not a table" } };
  if (word === "extra") return { output: table([]), surprise: 1 };
  if (word === "rows") {
    const n = Number(arg);
    const rows = [];
    for (let i = 0; i < n; i++) rows.push([i, "r" + i]);
    return { output: { ...table(rows), total: n }, summary: { message: "made " + n } };
  }
  if (word === "slow") {
    for (let i = 0; i < 200; i++) {
      ctx.progress(i / 200, "step " + i);
      if (ctx.cancelled()) {
        // A host call after cancellation must be refused.
        try { await h.storage.set("afterCancel", true); } catch (e) { /* refused */ }
        return { output: table([]) };
      }
      try { await h.util.sleep(50); } catch (e) { /* refused once cancelled; checked above next turn */ }
    }
    return { output: table([]) };
  }
  if (word === "sleepy") {
    for (;;) await h.util.sleep(10000);
  }
  if (word === "locale") return { output: table([[1, String(ctx.locale)]]) };
  if (word === "limit") {
    const limit = Number(await h.settings.get("rowLimit"));
    const rows = [];
    for (let i = 0; i < 100 && i < limit; i++) rows.push([i, "x"]);
    return { output: table(rows) };
  }
  // Default: the environment's `host` and the run parameters.
  const p = await h.params.get("host");
  ctx.progress(0.5, "half");
  return {
    output: table([[1, p.found ? p.value + "@" + p.sourceName : "-"], [2, JSON.stringify(ctx.params)], [3, text]]),
    summary: { rows: 3 },
  };
}

async function probe(ctx, context) {
  const a = (context && context.args) || {};
  const [cap, op] = String(a.method).split(".");
  try {
    const r = await ctx.host[cap][op](...(a.args || []));
    return [{ type: "copy", text: JSON.stringify({ ok: r === undefined ? null : r }) }];
  } catch (e) {
    return [{ type: "copy", text: JSON.stringify({ error: e.code || String(e), params: e.params || {} }) }];
  }
}

export default {
  activate(host) {
    host.actions.handle("run", run);
    host.actions.handle("say", async (ctx) => ({ output: { type: "text", text: "said " + (ctx.resource ? ctx.resource.name : "-") } }));
    host.pages.handle("editor", {
      async render(ctx) {
        const text = String((ctx.draft && ctx.draft["body.text"]) ?? (ctx.resource ? ctx.resource.body.text : "") ?? "");
        const params = [...text.matchAll(/:([a-z_]+)/g)].map((m) => ({ name: m[1], label: m[1], kind: "text", param: true }));
        const view = [{ type: "form", id: "main", layout: "stack",
                        fields: [{ name: "text", label: "Text", kind: "code", bind: "body.text", fill: true }] }];
        if (params.length) view.unshift({ type: "form", id: "params", layout: "strip", fields: params });
        if (ctx.run) view.push({ type: "text", id: "run", text: "run " + ctx.run.seq });
        return { view };
      },
      async onEvent(ctx, event) {
        if (event === "sneaky") {
          // Tries to change fields the page does not show; the kernel keeps only bound ones (D294).
          return { changes: { name: "hacked", tags: ["x"], "body.other": "x", "body.text": "kept" } };
        }
        if (event !== "tidy") return {};
        const text = String((ctx.draft && ctx.draft["body.text"]) || "");
        return { changes: { "body.text": text.toUpperCase() }, message: ctx.t("msg.tidied") };
      },
      async renderResultTab(ctx, tab) {
        const loc = ctx.locale ? "@" + ctx.locale : "";
        return [{ type: "text", id: "final", text: tab + ":" + ctx.run.input["body.text"] + loc }];
      },
    });
    host.commands.handle("probe", probe);
    host.commands.handle("inspect", async () => []);
  },
};
