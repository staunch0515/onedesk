// Shared by the document plugin's roles: names, words.

export const PLUGIN = "org.onedesk.document";
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

/** Every language's words for a key (a label as `ctx.t` gives it). */
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

/** The signature levels written one per line (or separated by `/`); "书写" when none. */
export function levelsOf(ctx, text) {
  const l = str(text).split(/[\n/／]/).map((x) => x.trim()).filter(Boolean);
  return l.length ? l : [say(ctx, "level.default")];
}

/** The entered values of a body: `v.<name>` → value. */
export function enteredOf(body) {
  const out = {};
  for (const [k, v] of Object.entries(body || {})) if (k.startsWith("v.")) out[k.slice(2)] = v;
  return out;
}

export function stamp(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
