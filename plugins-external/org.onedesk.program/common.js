// Shared by the program book's roles (docs/redesign/book.md §37): names, words, the book a page is in, and the files the
// book's pages make up. A book is a program book when it has a manifest page — the book itself is not told (§0.3).

export const PLUGIN = "org.onedesk.program";
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

export function failed(ctx, key, vars) {
  const text = say(ctx, key, vars);
  return { output: { type: "text", text }, failed: { message: text } };
}

/** The body as the person sees it now: what is typed and not saved over what is saved. */
export function bodyNow(ctx) {
  const b = Object.assign({}, (ctx.resource && ctx.resource.body) || {});
  if (ctx.draft) for (const [k, v] of Object.entries(ctx.draft)) if (k.startsWith("body.")) b[k.slice(5)] = v;
  return b;
}

/** A day as `YYYY-MM-DD`. */
export function day(ms) {
  const d = new Date(Number(ms) || 0);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** The book a resource is in: the nearest ancestor (or itself, with `self`) whose kind plays the role `book`. */
export async function bookAbove(ctx, id, self = false) {
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
    if (i > 0 || self) {
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

/** Our pages in a book, in the book's order, by short kind: `{ manifest, code, locale, test, build }` (tree nodes). */
export async function pagesOf(ctx, bookId) {
  const out = { manifest: [], code: [], locale: [], test: [], build: [] };
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

/** A path in a package: relative, `/`-separated, no `..`. */
export const goodPath = (p) => typeof p === "string" && p.length > 0 && p.length <= 200 && !p.startsWith("/") && p.split("/").every((s) => s && s !== "." && s !== ".." && /^[A-Za-z0-9._-]+$/.test(s));

/** A language page's texts as the JSON object of a language file (empty keys left out; the last of a key wins). */
export function localeObject(texts) {
  const o = {};
  for (const row of Array.isArray(texts) ? texts : []) {
    const k = str(row && row.key).trim();
    if (k) o[k] = str(row && row.text);
  }
  return o;
}

/** The file a language page makes. */
export const localePath = (language) => `locales/${str(language).trim()}.json`;

/**
 * What the book's pages make up (§37.4): `{ files: { path → text }, sources: { path → page }, problems, tests, manifest }`.
 * The manifest page is `manifest.json`, each code page its `path`, each language page `locales/<language>.json`; test pages
 * are not in the package. `override` replaces one page's body (the page being edited, typed and not saved).
 */
export async function assemble(ctx, bookId, override) {
  const pages = await pagesOf(ctx, bookId);
  const files = {};
  const sources = {};
  const problems = [];
  const body = async (n) => (override && override.id === n.id ? override.body : ((await ctx.host.resources.get(n.id)) || {}).body || {});
  const put = (path, text, n) => {
    if (!goodPath(path)) return problems.push({ file: path, page: n.name, code: "badPath" });
    if (files[path] !== undefined) return problems.push({ file: path, page: n.name, code: "samePath" });
    files[path] = text;
    sources[path] = n;
  };
  if (pages.manifest.length > 1) problems.push({ file: "manifest.json", page: pages.manifest[1].name, code: "twoManifests" });
  for (const n of pages.manifest.slice(0, 1)) put("manifest.json", str((await body(n)).text), n);
  for (const n of pages.code) put(str((await body(n)).path).trim(), str((await body(n)).code), n);
  for (const n of pages.locale) {
    const b = await body(n);
    if (!str(b.language).trim()) problems.push({ file: "", page: n.name, code: "noLanguage" });
    else put(localePath(b.language), JSON.stringify(localeObject(b.texts), null, 2) + "\n", n);
  }
  const tests = [];
  for (const n of pages.test) tests.push({ id: n.id, name: n.name, code: str((await body(n)).code) });
  return { files, sources, problems, tests, pages, hasManifest: pages.manifest.length > 0 };
}

/** The kernel's check of the files as a plugin (K20); never throws. */
export async function checkFiles(ctx, files) {
  try {
    return await ctx.host.plugins.check(files);
  } catch (e) {
    return { ok: false, problems: [{ file: "", field: String((e && e.message) || e), code: "internal" }] };
  }
}

/** A problem in words: `file · field: reason`. */
export function problemText(ctx, p) {
  const key = `problem.${p.code}`;
  const reason = say(ctx, key);
  const why = reason === key ? p.code : reason;
  const where = [p.file, p.field].filter(Boolean).join(" · ");
  return where ? `${where}: ${why}` : why;
}
