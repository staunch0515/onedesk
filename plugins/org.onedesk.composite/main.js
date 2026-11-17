// Composite plugin: a node that holds references to other resources (never copies). Dropping a resource on it
// adds its id to `items`; its children are those resources in that order; its page lists them and lets the user
// remove or move them. Needs `requires.resources` (reads names, kinds and icons only, never bodies).
// Sandbox rules: no console, timers or fetch; everything goes through ctx.host.

export const MAX_ITEMS = 1000;
const BATCH = 200;
const SEARCH_LIMIT = 500;

export function tr(ctx, key, vars) {
  const label = ctx.t(key);
  let text = typeof label === "string" ? label : label[ctx.locale] || label["en-US"] || key;
  for (const k of Object.keys(vars || {})) text = text.split(`{${k}}`).join(String(vars[k]));
  return text;
}

// The ids in `items`, as strings, without duplicates, at most MAX_ITEMS.
export function itemsOf(value) {
  const out = [];
  if (!Array.isArray(value)) return out;
  for (const v of value) {
    if (typeof v === "string" && v && !out.includes(v)) out.push(v);
    if (out.length >= MAX_ITEMS) break;
  }
  return out;
}

// Basic info of `ids` by id; ids that no longer exist (or are deleted) are missing from the map.
async function lookup(ctx, ids) {
  const found = new Map();
  for (let i = 0; i < ids.length; i += SEARCH_LIMIT) {
    const res = await ctx.host.resources.search({ ids: ids.slice(i, i + SEARCH_LIMIT), limit: SEARCH_LIMIT });
    for (const info of res.items || []) if (!info.deleted) found.set(info.id, info);
  }
  return found;
}

export function move(items, id, delta) {
  const i = items.indexOf(id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= items.length) return items;
  const next = items.slice();
  next[i] = items[j];
  next[j] = id;
  return next;
}

export function currentItems(ctx) {
  if (ctx.draft && Array.isArray(ctx.draft["body.items"])) return itemsOf(ctx.draft["body.items"]);
  return itemsOf(ctx.resource && ctx.resource.body && ctx.resource.body.items);
}

export default {
  activate(host) {
    host.kinds.handle("composite", {
      async drop(ctx, ev) {
        const items = itemsOf(ctx.resource && ctx.resource.body && ctx.resource.body.items);
        let added = 0;
        for (const s of (ev && ev.sources) || []) {
          if (!s || typeof s.id !== "string" || s.id === ctx.resource.id || items.includes(s.id)) continue;
          if (items.length >= MAX_ITEMS) break;
          items.push(s.id);
          added++;
        }
        if (added > 0) await ctx.host.resources.update(ctx.resource.id, { "body.items": items });
        return { handled: true, message: tr(ctx, "message.added", { n: added }) };
      },

      async children(ctx, node, offset) {
        if (node) return { nodes: [] };
        const items = itemsOf(ctx.resource && ctx.resource.body && ctx.resource.body.items);
        const start = Number(offset) > 0 ? Math.floor(Number(offset)) : 0;
        const slice = items.slice(start, start + BATCH);
        const found = await lookup(ctx, slice);
        const nodes = slice.map((id) => {
          const info = found.get(id);
          if (!info) return { key: `ref-${id}`, label: tr(ctx, "node.missing"), icon: "unlink", expandable: false };
          return { key: `ref-${id}`, label: info.name, icon: info.icon, expandable: false, target: `resource:${id}` };
        });
        const end = start + slice.length;
        return end < items.length ? { nodes, next: end } : { nodes };
      },
    });

    host.pages.handle("editor", {
      async render(ctx) {
        const items = currentItems(ctx);
        if (items.length === 0) return { view: [{ type: "text", id: "empty", text: tr(ctx, "page.empty"), tone: "muted" }] };
        const found = await lookup(ctx, items);
        const rows = items.map((id) => {
          const info = found.get(id);
          return info ? [info.icon, info.name, info.kindLabel || info.kind] : ["unlink", tr(ctx, "node.missing"), ""];
        });
        return {
          view: [
            {
              type: "table",
              id: "items",
              columns: [
                { key: "icon", label: tr(ctx, "col.icon") },
                { key: "name", label: tr(ctx, "col.name") },
                { key: "kind", label: tr(ctx, "col.kind") },
              ],
              rows,
              rowTargets: items.map((id) => (found.has(id) ? `resource:${id}` : "")),
            },
          ],
        };
      },

      // Row events are named `<verb>:<resource id>`; the new list is a change to the unsaved draft.
      async onEvent(ctx, event) {
        const i = String(event).indexOf(":");
        const verb = i < 0 ? String(event) : String(event).slice(0, i);
        const id = i < 0 ? "" : String(event).slice(i + 1);
        const items = currentItems(ctx);
        if (!items.includes(id)) throw new Error(`unknown item ${id}`);
        if (verb === "remove") return { changes: { "body.items": items.filter((x) => x !== id) }, message: tr(ctx, "message.removed") };
        if (verb === "up") return { changes: { "body.items": move(items, id, -1) } };
        if (verb === "down") return { changes: { "body.items": move(items, id, 1) } };
        throw new Error(`unknown event ${event}`);
      },
    });
  },
};
