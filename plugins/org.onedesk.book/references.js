// References (参考文献, docs/redesign/book.md §3.6, §15.3): one entry is a resource (its name is the citation key)
// under the references page; the page says how citations are shown — numbered in the order first cited (顺序编码制)
// or by author and year (著者-出版年制) — and lists the entries as GB/T 7714 writes them.

import { full, split } from "./roles.js";
import { say, usesChineseNumerals } from "./words.js";

export const REFERENCES = full("references");
export const REFERENCE = full("reference");
export const TYPES = ["M", "J", "C", "D", "R", "S", "P", "N", "EB/OL", "Z"];
export const FIELDS = ["authors", "title", "container", "edition", "place", "publisher", "year", "volume", "issue", "pages", "url", "accessed", "doi"];

const CJK = /[㐀-鿿぀-ヿ]/;
const str = (v) => (typeof v === "string" ? v.trim() : "");

/** The authors as written in a list: at most three, then 等 (Chinese and Japanese names) or et al. */
export function authorsText(raw) {
  const names = str(raw)
    .split(/[,，、;；]/)
    .map((x) => x.trim())
    .filter(Boolean);
  if (names.length <= 3) return names.join(", ");
  return `${names.slice(0, 3).join(", ")}, ${CJK.test(names.join("")) ? "等" : "et al."}`;
}

/** One entry as GB/T 7714 writes it (parts that are missing are left out). */
export function formatEntry(body) {
  const b = body || {};
  const type = TYPES.includes(b.type) ? b.type : "M";
  const a = authorsText(b.authors);
  const head = [a, `${str(b.title)}[${type}]`].filter(Boolean).join(". ");
  const where = [str(b.place), str(b.publisher)].filter(Boolean).join(": ");
  const pages = str(b.pages);
  const year = str(b.year);
  let rest = "";
  if (type === "J") {
    rest = [str(b.container), year].filter(Boolean).join(", ");
    if (str(b.volume)) rest += `, ${str(b.volume)}`;
    if (str(b.issue)) rest += `(${str(b.issue)})`;
    if (pages) rest += `: ${pages}`;
  } else if (type === "N") {
    rest = [str(b.container), year].filter(Boolean).join(", ");
    if (str(b.issue)) rest += `(${str(b.issue)})`;
  } else if (type === "EB/OL") {
    rest = `${year ? `(${year})` : ""}${str(b.accessed) ? `[${str(b.accessed)}]` : ""}`;
    if (str(b.url)) rest += `${rest ? ". " : ""}${str(b.url)}`;
  } else {
    const container = type === "C" && str(b.container) ? `//${str(b.container)}. ` : "";
    const edition = str(b.edition) ? `${str(b.edition)}. ` : "";
    rest = `${edition}${[where, year].filter(Boolean).join(", ")}`;
    if (pages) rest += `: ${pages}`;
    if (container) return finish(`${head}${container}${rest}`, b);
  }
  return finish([head, rest].filter(Boolean).join(". "), b);
}

function finish(text, b) {
  let out = text.replace(/\s+$/, "");
  if (!out.endsWith(".")) out += ".";
  if (str(b.doi)) out += ` DOI: ${str(b.doi)}.`;
  return out;
}

/** The author-and-year form: (Zhang, 2020) / （张三，2020）; more than one author: et al. / 等. */
function authorYear(ctx, body, note) {
  const names = str(body.authors)
    .split(/[,，、;；]/)
    .map((x) => x.trim())
    .filter(Boolean);
  const first = names[0] || "?";
  const cjk = CJK.test(first);
  // GB/T 7714 writes Western names family name first ("Smith J"): the first word.
  const surname = cjk ? first : first.split(/\s+/)[0];
  const wide = usesChineseNumerals(ctx);
  const who = names.length > 1 ? `${surname}${cjk ? "，等" : " et al."}` : surname;
  const year = str(body.year) || "?";
  const sep = wide ? "，" : ", ";
  return `${who}${sep}${year}${note ? `${wide ? "：" : ": "}${note}` : ""}`;
}

/** The entries under a references page, by citation key (the entry's name). */
export async function entriesUnder(ctx, pageId) {
  const r = await ctx.host.resources.tree(pageId, { limit: 2000 });
  const out = new Map();
  for (const n of r.nodes) {
    if (n.kind !== REFERENCE || out.has(n.name)) continue;
    const e = await ctx.host.resources.get(n.id);
    if (e) out.set(n.name, e);
  }
  return out;
}

/**
 * How each citation is shown (`cites`: `{ keys, notes }` in reading order), and the entries in the order they are
 * listed. `{ labels, cited: [entry], missing: [index of the cite] }`.
 */
export async function citeLabels(ctx, page, cites) {
  const system = page && page.body && page.body.system === "authorYear" ? "authorYear" : "numeric";
  const entries = page ? await entriesUnder(ctx, page.id) : new Map();
  const numbers = new Map();
  const cited = [];
  const missing = [];
  const wide = usesChineseNumerals(ctx);
  const labels = cites.map((c, i) => {
    const parts = [];
    c.keys.forEach((key, j) => {
      const e = entries.get(key);
      const note = c.notes && c.notes[j];
      if (!e) {
        if (!missing.includes(i)) missing.push(i);
        parts.push(system === "numeric" ? `?${key}` : `?${key}`);
        return;
      }
      if (!numbers.has(key)) {
        numbers.set(key, numbers.size + 1);
        cited.push(e);
      }
      parts.push(system === "numeric" ? `${numbers.get(key)}${note ? `: ${note}` : ""}` : authorYear(ctx, e.body || {}, note));
    });
    if (system === "numeric") return `[${parts.join(", ")}]`;
    return wide ? `（${parts.join("；")}）` : `(${parts.join("; ")})`;
  });
  return { labels, cited, missing, system };
}

/* ------------------------------------------------------------------ pages */

export function renderReference(ctx) {
  const b = Object.assign({}, (ctx.resource && ctx.resource.body) || {});
  for (const k of ["type", ...FIELDS]) if (ctx.draft && typeof ctx.draft[`body.${k}`] === "string") b[k] = ctx.draft[`body.${k}`];
  const f = (name, kind = "text", extra = {}) => ({ name, label: ctx.t(`field.${name}`), kind, bind: `body.${name}`, ...extra });
  return {
    view: [
      {
        type: "form",
        id: "entry",
        layout: "stack",
        fields: [
          f("type", "enum", { options: TYPES.map((v) => ({ value: v, label: ctx.t(`type.${v.replace("/", "")}`) })) }),
          f("authors", "text", { placeholder: ctx.t("field.authors.placeholder") }),
          f("title"),
          f("container", "text", { hint: ctx.t("field.container.hint") }),
          f("edition"),
          f("place"),
          f("publisher"),
          f("year"),
          f("volume"),
          f("issue"),
          f("pages"),
          f("url"),
          f("accessed"),
          f("doi"),
        ],
      },
      { type: "text", id: "preview", text: formatEntry(b), tone: "muted" },
    ],
  };
}

export function embedReference(ctx) {
  return { view: [{ type: "text", id: "entry", text: formatEntry((ctx.resource && ctx.resource.body) || {}) }] };
}

/** The list (and the citations not found), from the book's contents. */
async function listOf(ctx, page, entries) {
  const mine = entries.cites.filter((c) => c.scope === page.id);
  const { cited, missing, system } = await citeLabels(ctx, page, mine);
  const all = page.body && page.body.list === "all";
  let shown = cited.slice();
  if (all) for (const e of (await entriesUnder(ctx, page.id)).values()) if (!shown.some((x) => x.id === e.id)) shown.push(e);
  if (system === "authorYear") {
    const order = await ctx.host.util.collate(shown.map((e) => str(e.body && e.body.authors) || e.name), ctx.locale || "en-US");
    shown = order.map((i) => shown[i]);
  }
  const rows = shown.map((e, i) => (system === "numeric" ? [`[${i + 1}]`, formatEntry(e.body)] : [formatEntry(e.body)]));
  const lost = missing.map((i) => mine[i]);
  return { rows, targets: shown.map((e) => `resource:${e.id}`), lost, system };
}

/**
 * The references page: its settings in one row, the list, and the citations that name no entry. `contents` gives the
 * book's citations in reading order (`entriesOf`), or null when the page is not in a book.
 */
export async function renderReferences(ctx, contents) {
  const settings = {
    type: "form",
    id: "settings",
    layout: "strip",
    fields: [
      { name: "system", label: ctx.t("field.system"), kind: "enum", bind: "body.system", options: ["numeric", "authorYear"].map((v) => ({ value: v, label: ctx.t(`system.${v}`) })) },
      { name: "list", label: ctx.t("field.list"), kind: "enum", bind: "body.list", options: ["cited", "all"].map((v) => ({ value: v, label: ctx.t(`list.${v}`) })) },
    ],
  };
  const page = Object.assign({}, ctx.resource, { body: Object.assign({}, (ctx.resource && ctx.resource.body) || {}) });
  for (const k of ["system", "list"]) if (ctx.draft && typeof ctx.draft[`body.${k}`] === "string") page.body[k] = ctx.draft[`body.${k}`];
  const view = [settings];
  if (!page.id || !contents) {
    view.push({ type: "text", id: "alone", text: say(ctx, "references.alone"), tone: "muted" });
    return { view };
  }
  view.push(...(await tablesOf(ctx, page, contents)));
  return { view };
}

async function tablesOf(ctx, page, contents) {
  const { rows, targets, lost, system } = await listOf(ctx, page, contents);
  const out = [];
  if (rows.length === 0) out.push({ type: "text", id: "empty", text: say(ctx, "references.empty"), tone: "muted" });
  else {
    const columns = system === "numeric" ? [{ key: "n", label: say(ctx, "references.column.number") }, { key: "entry", label: say(ctx, "references.column.entry") }] : [{ key: "entry", label: say(ctx, "references.column.entry") }];
    out.push({ type: "table", id: "list", columns, rows, rowTargets: targets });
  }
  if (lost.length > 0) {
    const title = (key) => (contents.items.find((x) => x.key === key) || { title: "" }).title;
    out.push({ type: "text", id: "lostTitle", text: `**${say(ctx, "references.missing")}**`, format: "markdown" });
    out.push({
      type: "table",
      id: "lost",
      columns: [
        { key: "key", label: say(ctx, "references.column.key") },
        { key: "where", label: say(ctx, "references.column.where") },
      ],
      rows: lost.map((c) => [c.keys.join("; "), title(c.item)]),
      rowTargets: lost.map((c) => {
        const it = contents.items.find((x) => x.key === c.item);
        return it && it.resource ? `resource:${it.resource}` : null;
      }),
    });
  }
  return out;
}

export async function embedReferences(ctx, contents) {
  if (!contents || !ctx.resource) return { view: [{ type: "text", id: "alone", text: say(ctx, "references.alone"), tone: "muted" }] };
  return { view: await tablesOf(ctx, ctx.resource, contents) };
}

/** Whether a kind is this plugin's references page. */
export function isReferences(kind) {
  const [plugin, short] = split(kind);
  return plugin === "org.onedesk.book" && short === "references";
}
