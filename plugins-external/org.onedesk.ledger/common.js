// Shared by the ledger's roles: names, words, numbers, the book a page is in and what is in it.

export const PLUGIN = "org.onedesk.ledger";
export const IFACE = "onedesk.book/1";
export const full = (k) => `${PLUGIN}:${k}`;
export const NONE = { type: "none" };
export const str = (v) => (typeof v === "string" ? v : v === null || v === undefined ? "" : String(v));
export const VOUCHERS = ["receipt", "issue", "count"];

/** A plugin text as a string in the context's language, `{name}` filled from `vars`. */
export function say(ctx, key, vars) {
  const label = ctx.t(key);
  let text = typeof label === "string" ? label : (label && (label[ctx.locale] || label["en-US"])) || key;
  for (const k of Object.keys(vars || {})) text = text.split(`{${k}}`).join(String(vars[k]));
  return text;
}

/** Every language's words for a key. */
export function allWords(ctx, key) {
  const l = ctx.t(key);
  return typeof l === "string" ? [l] : Object.values(l || {});
}

/** The body as the person sees it now: what is typed and not saved over what is saved. */
export function bodyNow(ctx) {
  const b = Object.assign({}, (ctx.resource && ctx.resource.body) || {});
  if (ctx.draft) for (const [k, v] of Object.entries(ctx.draft)) if (k.startsWith("body.")) b[k.slice(5)] = v;
  return b;
}

/** A number (empty or not a number: 0). */
export const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Rounded half away from zero to `d` places. */
export function round(v, d) {
  const f = 10 ** d;
  const x = Math.abs(v) * f;
  const r = Math.round(x + 1e-9 * Math.max(1, x)) / f;
  return v < 0 ? -r : r;
}

/** `2026-11-26` → `2026-11`. */
export const monthOf = (date) => str(date).slice(0, 7);

/** Today, `YYYY-MM-DD`. */
export function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** The book a resource is in: the nearest ancestor whose kind plays the role `book` (asked through the interface). */
export async function bookAbove(ctx, id) {
  let implementers = null;
  const roles = new Map();
  let cur = id;
  for (let i = 0; i < 16 && cur; i++) {
    let info;
    try {
      const r = await ctx.host.resources.search({ ids: [cur] });
      info = (Array.isArray(r) ? r : r.items || [])[0];
    } catch {
      return null;
    }
    if (!info) return null;
    if (i > 0) {
      const plugin = info.kind.slice(0, info.kind.lastIndexOf(":"));
      const short = info.kind.slice(info.kind.lastIndexOf(":") + 1);
      if (implementers === null) {
        try {
          implementers = (await ctx.host.interfaces.list(IFACE)).map((x) => x.plugin);
        } catch {
          implementers = [];
        }
      }
      if (implementers.includes(plugin)) {
        if (!roles.has(plugin)) {
          try {
            const r = await ctx.host.interfaces.call(IFACE, "roles", {}, { plugin });
            roles.set(plugin, (r && r.data && r.data.kinds) || []);
          } catch {
            roles.set(plugin, []);
          }
        }
        if (roles.get(plugin).some((k) => k && k.kind === short && k.role === "book")) return { id: info.id, name: info.name, kind: info.kind };
      }
    }
    cur = info.parent;
  }
  return null;
}

/** Everything of ours in a book, by short kind: `{ setup, items, sheets, vouchers… }` as tree nodes. */
export async function contentsOf(ctx, bookId) {
  const out = { setup: [], catalog: [], item: [], sheet: [], receipt: [], issue: [], count: [], vouchers: [], summary: [] };
  let offset = 0;
  for (;;) {
    const r = await ctx.host.resources.tree(bookId, { offset, limit: 2000 });
    for (const n of r.nodes) {
      const k = n.kind.startsWith(`${PLUGIN}:`) ? n.kind.slice(PLUGIN.length + 1) : null;
      if (k && out[k]) out[k].push(n);
    }
    if (r.next === null || r.next === undefined) break;
    offset = r.next;
  }
  return out;
}

/** The book's setup (启用表) body, with defaults. */
export async function setupOf(ctx, bookId) {
  const c = await contentsOf(ctx, bookId);
  const n = c.setup[0];
  const r = n ? await ctx.host.resources.get(n.id) : null;
  const b = (r && r.body) || {};
  return {
    id: r ? r.id : null,
    method: b.method === "fifo" ? "fifo" : "moving",
    qtyDecimals: Number.isInteger(b.qtyDecimals) ? b.qtyDecimals : 2,
    amountDecimals: Number.isInteger(b.amountDecimals) ? b.amountDecimals : 2,
    closed: Array.isArray(b.closed) ? b.closed : [],
    started: str(b.started),
  };
}
