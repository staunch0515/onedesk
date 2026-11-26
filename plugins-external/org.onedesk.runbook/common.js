// Shared by the runbook's roles: names, words, the book a page is in.

export const PLUGIN = "org.onedesk.runbook";
export const IFACE = "onedesk.book/1";
export const full = (k) => `${PLUGIN}:${k}`;
export const NONE = { type: "none" };
export const str = (v) => (typeof v === "string" ? v : v === null || v === undefined ? "" : String(v));

/** A plugin text as a string in the context's language, `{name}` filled from `vars`. */
export function say(ctx, key, vars) {
  const label = ctx.t(key);
  let text = typeof label === "string" ? label : (label && (label[ctx.locale] || label["en-US"])) || key;
  for (const k of Object.keys(vars || {})) text = text.split(`{${k}}`).join(String(vars[k]));
  return text;
}

/** The body as the person sees it now: what is typed and not saved over what is saved. */
export function bodyNow(ctx) {
  const b = Object.assign({}, (ctx.resource && ctx.resource.body) || {});
  if (ctx.draft) for (const [k, v] of Object.entries(ctx.draft)) if (k.startsWith("body.")) b[k.slice(5)] = v;
  return b;
}

/** The resource above `res` (its book, for a step or a flow), as `{ id, name, kind }`, or null. */
export async function parentOf(ctx, res) {
  if (!res || !res.parentId) return null;
  try {
    const r = await ctx.host.resources.search({ ids: [res.parentId] });
    const info = (Array.isArray(r) ? r : r.items || [])[0];
    return info ? { id: info.id, name: info.name, kind: info.kind } : null;
  } catch {
    return null;
  }
}

export function clock(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
