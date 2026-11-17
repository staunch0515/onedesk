// Fixture: "nested". The kind `shelf` supplies its own child nodes (manifest "children": true): as many as the
// resource's `count` field says, 500 per batch, continued with `next` (a number: the offset of the next batch). The first node can be opened
// (`target: "resource:<this resource's id>"`), the others have no target. count -1 makes the handler throw
// (to check the "failed to load" node). The action `touch` rewrites the resource's `text` through the host
// (to check merging of changes made by a plugin).
// Sandbox rules: no console, timers or fetch; everything goes through ctx.host.

const BATCH = 500;
const TOUCH_TEXT_KEY = "touch.text";

export function tr(ctx, key, vars) {
  const label = ctx.t(key);
  let text = typeof label === "string" ? label : label[ctx.locale] || label["en-US"] || key;
  for (const k of Object.keys(vars || {})) text = text.split(`{${k}}`).join(String(vars[k]));
  return text;
}

// "Item 00001" in English, "条目 00001" in Chinese (the label comes from the locale file, the number is padded).
const pad = (n) => String(n).padStart(5, "0");

// The resource's count (body.count); anything that is not a number counts as 0.
function countOf(resource) {
  const raw = resource && resource.body && resource.body.count;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.floor(n) : 0;
}

export default {
  activate(host) {
    host.kinds.handle("shelf", {
      async children(ctx, node, offset) {
        const count = countOf(ctx.resource);
        if (count < 0) throw new Error(tr(ctx, "error.badCount"));
        const start = Number(offset) > 0 ? Math.floor(Number(offset)) : 0;
        const end = Math.min(count, start + BATCH);
        const nodes = [];
        for (let i = start; i < end; i++) {
          const n = {
            key: `item-${i + 1}`,
            label: tr(ctx, "node.item", { n: pad(i + 1) }),
            icon: "layers",
            expandable: false,
          };
          if (i === 0) n.target = `resource:${ctx.resource.id}`;
          nodes.push(n);
        }
        return end < count ? { nodes, next: end } : { nodes };
      },
    });

    host.pages.handle("editor", {
      async render(ctx) {
        const fields = [
          { name: "count", label: ctx.t("field.count"), kind: "number", bind: "body.count" },
          { name: "text", label: ctx.t("field.text"), kind: "text", bind: "body.text" },
        ];
        if (ctx.run) for (const f of fields) f.readOnly = true;
        return { view: [{ type: "form", id: "shelf", layout: "stack", fields }] };
      },
    });

    host.actions.handle("touch", async (ctx) => {
      await ctx.host.resources.update(ctx.resource.id, { "body.text": tr(ctx, TOUCH_TEXT_KEY) });
      return { output: { type: "text", text: tr(ctx, "result.touched") } };
    });
  },
};
