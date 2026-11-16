// Fixture: example plugin that depends on the note plugin. It adds two actions to notes (kind
// "org.onedesk.note:note", exported with actions + read): "count" reads the note and reports word and
// line counts; "stamp" tries to change the note and must be refused by the host (read-only export).
// Sandbox rules: no console, timers or fetch; everything goes through ctx.host.

export function tr(ctx, key, vars) {
  const label = ctx.t(key);
  let text = typeof label === "string" ? label : label[ctx.locale] || label["en-US"] || key;
  for (const k of Object.keys(vars || {})) text = text.split(`{${k}}`).join(String(vars[k]));
  return text;
}

// Words are runs of non-whitespace; each CJK character also counts as one word.
export function countText(text) {
  const s = String(text || "");
  const cjk = (s.match(/[㐀-鿿぀-ヿ가-힯]/g) || []).length;
  const rest = s.replace(/[㐀-鿿぀-ヿ가-힯]/g, " ");
  const latin = rest.split(/\s+/).filter(Boolean).length;
  const lines = s === "" ? 0 : s.split("\n").length;
  return { words: cjk + latin, lines };
}

export default {
  activate(host) {
    host.actions.handle("count", async (ctx, input) => {
      const res = ctx.resource;
      if (!res) throw new Error("no resource");
      const { words, lines } = countText(res.body ? res.body.text : input && input["body.text"]);
      return {
        output: { type: "text", text: tr(ctx, "count.line", { words, lines }) },
        summary: { message: tr(ctx, "count.summary", { words }) },
      };
    });

    // Tries to write to the note. The host refuses (denied / foreignKind); the error is not caught, so the run
    // fails with the host's code and params.
    host.actions.handle("stamp", async (ctx) => {
      const res = ctx.resource;
      if (!res) throw new Error("no resource");
      const text = String((res.body && res.body.text) || "");
      await ctx.host.resources.update(res.id, { "body.text": `${text}\n-- stamped` });
      return { output: { type: "text", text: tr(ctx, "stamp.done") } };
    });
  },
};
