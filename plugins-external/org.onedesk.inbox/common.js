// Shared by the letters plugin's roles: names, words, the interface, where files go.

export const PLUGIN = "org.onedesk.inbox";
export const IFACE = "onedesk.letter/1";
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

/** Who signed, in words (`known`: self, checked, unchecked, unknown). */
export function whoText(ctx, who) {
  if (!who) return say(ctx, "who.nobody");
  return say(ctx, `who.${who.known || "unknown"}`, { name: who.name || "", fingerprint: who.fingerprint || "" });
}

/** A day as `YYYY-MM-DD`. */
export function day(ms) {
  const d = new Date(Number(ms) || 0);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Past its due day (and not answered). */
export const overdue = (due, at) => !!due && str(due) < day(at);

/** What a page's role offers: `[{ task, label }]` (none when it implements nothing). */
export async function tasksOf(ctx, page) {
  try {
    const r = await ctx.host.interfaces.call(IFACE, "tasks", {}, { resource: page });
    return r && r.data && Array.isArray(r.data.tasks) ? r.data.tasks.filter((t) => t && typeof t.task === "string") : [];
  } catch {
    return [];
  }
}

/** Whether what was asked of a page is done: `{ state, summary }`. */
export async function todoOf(ctx, page, task) {
  try {
    const r = await ctx.host.interfaces.call(IFACE, "todo", { task }, { resource: page });
    return r && r.data && typeof r.data.state === "string" ? r.data : { state: "todo", summary: "" };
  } catch {
    return { state: "todo", summary: "" };
  }
}

/** What goes back for a page: `{ data, summary }`, or null when there is nothing (yet). */
export async function replyOf(ctx, page, task) {
  try {
    const r = await ctx.host.interfaces.call(IFACE, "reply", { task }, { resource: page });
    return r && r.data && r.data.data !== undefined ? r.data : null;
  } catch {
    return null;
  }
}

/** The folder letters are written to: the first one granted (asked for when there is none). */
export async function folderOf(ctx) {
  const roots = await ctx.host.files.roots();
  if (roots && roots.length > 0) return roots[0].path;
  try {
    await ctx.host.files.addRoot();
  } catch {
    // The dialog could not be shown: the message says what to do.
  }
  return null;
}

const BAD_NAME = /[\\/:*?"<>|\u0000-\u001f]/g;
export const safeName = (n) => str(n).replace(BAD_NAME, "-").trim() || "letter";

/** A file name in `folder` nothing has yet. */
export async function freePath(ctx, folder, name, ext) {
  for (let i = 1; i <= 1000; i++) {
    const p = `${folder}/${name}${i === 1 ? "" : ` ${i}`}${ext}`;
    try {
      await ctx.host.files.stat(p);
    } catch {
      return p;
    }
  }
  throw new Error("no free name");
}

export function failed(ctx, key, vars) {
  const text = say(ctx, key, vars);
  return { output: { type: "text", text }, failed: { message: text } };
}
