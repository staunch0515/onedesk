// Collection plugin: a node whose children are the resources that match its conditions right now
// (kinds, tags, text). Nothing is stored about the results; expanding again runs the search again.
// Sandbox rules: no console, timers or fetch; everything goes through ctx.host.

export const BATCH = 200;

export function tr(ctx, key, vars) {
  const label = ctx.t(key);
  let text = typeof label === "string" ? label : label[ctx.locale] || label["en-US"] || key;
  for (const k of Object.keys(vars || {})) text = text.split(`{${k}}`).join(String(vars[k]));
  return text;
}

export function csv(text) {
  const out = [];
  for (const part of String(text || "").split(",")) {
    const v = part.trim();
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

// The search query for the three condition fields; null when all are empty.
export function queryOf(conditions, offset) {
  const kinds = csv(conditions.kinds);
  const tags = csv(conditions.tags);
  const text = String(conditions.text || "").trim();
  if (kinds.length === 0 && tags.length === 0 && !text) return null;
  const q = { limit: BATCH, offset: offset || 0 };
  if (kinds.length > 0) q.kinds = kinds;
  if (tags.length > 0) q.tags = tags;
  if (text) q.text = text;
  return q;
}

// A Label (D396: table cells hold text only) as text in the current locale; English, then the kind's full name.
export function labelText(label, locale, fallback) {
  if (typeof label === "string") return label;
  if (label && typeof label === "object") return label[locale] || label["en-US"] || fallback;
  return fallback;
}

const bodyOf = (ctx) => (ctx.resource && ctx.resource.body) || {};

function pick(ctx, name) {
  if (ctx.draft && typeof ctx.draft[`body.${name}`] === "string") return ctx.draft[`body.${name}`];
  const v = bodyOf(ctx)[name];
  return typeof v === "string" ? v : "";
}

// First-version short kind names and the full kinds their plugins now provide. A name not in the table
// (no built-in plugin claims it) and a name that already has a colon are kept as written.
export const LEGACY_KIND_NAMES = {
  link: "org.onedesk.link:link",
  note: "org.onedesk.note:note",
  prompt: "org.onedesk.prompt:prompt",
  "http-request": "org.onedesk.http:request",
  collection: "org.onedesk.collection:collection",
};

// First-version body { ruleType: "tag" | "kind", ruleValue } becomes the conditions { kinds, tags, text }
// (comma-separated texts). Anything else (bad type, no value, non-object body) becomes no conditions.
export function upgradeBody(body) {
  const old = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const value = typeof old.ruleValue === "string" ? old.ruleValue.trim() : "";
  const out = { kinds: "", tags: "", text: "" };
  if (old.ruleType === "tag") out.tags = value;
  else if (old.ruleType === "kind") out.kinds = value.split(",").map((k) => k.trim()).filter((k) => k).map((k) => LEGACY_KIND_NAMES[k] || k).join(",");
  return out;
}

export default {
  activate(host) {
    host.kinds.handle("collection", {
      upgrade(ctx, args) {
        return { body: upgradeBody(args && args.body) };
      },
      async children(ctx, node, offset) {
        if (node) return { nodes: [] };
        const start = Number(offset) > 0 ? Math.floor(Number(offset)) : 0;
        const q = queryOf(bodyOf(ctx), start);
        if (!q) return { nodes: [] };
        const res = await ctx.host.resources.search(q);
        const items = (res.items || []).filter((i) => i.id !== ctx.resource.id);
        const nodes = items.map((i) => ({ key: `hit-${i.id}`, label: i.name, icon: i.icon, expandable: false, target: `resource:${i.id}` }));
        const more = res.next !== undefined && res.next !== null && (res.items || []).length > 0;
        return more ? { nodes, next: start + res.items.length } : { nodes };
      },
    });

    host.pages.handle("editor", {
      async render(ctx) {
        const ro = ctx.run ? { readOnly: true } : {};
        const field = (name) => ({ name, label: ctx.t(`field.${name}`), kind: "text", bind: `body.${name}`, placeholder: ctx.t(`field.${name}.placeholder`), ...ro });
        const view = [{ type: "form", id: "conditions", layout: "stack", fields: [field("kinds"), field("tags"), field("text")] }];
        const q = queryOf({ kinds: pick(ctx, "kinds"), tags: pick(ctx, "tags"), text: pick(ctx, "text") }, 0);
        if (!q) {
          view.push({ type: "text", id: "hint", text: tr(ctx, "page.needCondition"), tone: "muted" });
          return { view };
        }
        const res = await ctx.host.resources.search(q);
        const items = (res.items || []).filter((i) => !ctx.resource || i.id !== ctx.resource.id);
        // The collection itself is never a result: take it off the total too, even when it is past the first batch.
        let total = res.total;
        if (ctx.resource) {
          const self = await ctx.host.resources.search({ ...q, ids: [ctx.resource.id], limit: 1, offset: 0 });
          if ((self.items || []).some((i) => i.id === ctx.resource.id && !i.deleted)) total = Math.max(0, total - 1);
        }
        view.push({ type: "text", id: "total", text: tr(ctx, items.length < total ? "page.total.partial" : "page.total", { total, shown: items.length }), tone: "muted" });
        if (items.length > 0) {
          view.push({
            type: "table",
            id: "results",
            columns: [
              { key: "name", label: tr(ctx, "col.name") },
              { key: "kind", label: tr(ctx, "col.kind") },
            ],
            rows: items.map((i) => [i.name, labelText(i.kindLabel, ctx.locale, i.kind)]),
            rowTargets: items.map((i) => `resource:${i.id}`),
          });
        }
        return { view };
      },
    });
  },
};
