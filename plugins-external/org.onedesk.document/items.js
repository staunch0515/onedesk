// Fill-in items (填写项, docs/redesign/book.md §23.3): written in a template's text as
// `{{?体温 | 数字, ℃, 35~42, 必填}}` — a name, then (after `|`) the type, the unit, the range, required, the default.
// The syntax is this plugin's own (rule 5). This file reads it, turns a text into a flow (controls at the items'
// places), writes the values in for reading and for signing, and checks what is missing or out of range.

const NAME = /^[A-Za-z0-9_一-鿿]{1,40}$/;

const TYPES = {
  文字: "text", text: "text",
  长文字: "longtext", longtext: "longtext",
  数字: "number", number: "number",
  日期: "date", date: "date",
  时间: "time", time: "time",
  是非: "yesno", yesno: "yesno",
};
const CHOICE = /^(单选|choice|多选|multi)\s*[:：]\s*(.*)$/i;
const RANGE = /^(-?\d+(?:\.\d+)?)\s*[~～]\s*(-?\d+(?:\.\d+)?)$/;
const REQUIRED = new Set(["必填", "required"]);
const DEFAULT = /^(默认|default)\s*=\s*(.*)$/i;

/** Every `{{?…}}` in the text, with where it is: `[{ start, end, raw, inner }]` (inner `{{…}}` allowed). */
export function findItems(text) {
  const s = String(text || "");
  const out = [];
  let i = 0;
  while ((i = s.indexOf("{{?", i)) >= 0) {
    let depth = 0;
    let j = i;
    let end = -1;
    while (j < s.length) {
      if (s.startsWith("{{", j)) {
        depth++;
        j += 2;
      } else if (s.startsWith("}}", j)) {
        depth--;
        j += 2;
        if (depth === 0) {
          end = j;
          break;
        }
      } else j++;
    }
    if (end < 0) break;
    out.push({ start: i, end, raw: s.slice(i, end), inner: s.slice(i + 3, end - 2) });
    i = end;
  }
  return out;
}

/** One item read: `{ name, type, unit, min, max, required, def, options, error }` (`error`: what is wrong). */
export function parseItem(inner) {
  const bar = inner.indexOf("|");
  const name = (bar < 0 ? inner : inner.slice(0, bar)).trim();
  const item = { name, type: "text", unit: "", min: null, max: null, required: false, def: "", options: [], error: null };
  if (!NAME.test(name)) item.error = "name";
  if (bar < 0) return item;
  for (const raw of inner.slice(bar + 1).split(/[,，](?![^{]*\}\})/)) {
    const tok = raw.trim();
    if (!tok) continue;
    const lower = tok.toLowerCase();
    let m;
    if (TYPES[tok] || TYPES[lower]) item.type = TYPES[tok] || TYPES[lower];
    else if ((m = CHOICE.exec(tok))) {
      item.type = /^(多选|multi)$/i.test(m[1]) ? "multi" : "choice";
      item.options = m[2].split(/[/／]/).map((x) => x.trim()).filter(Boolean);
      if (item.options.length === 0) item.error = "options";
    } else if ((m = RANGE.exec(tok))) {
      item.min = Number(m[1]);
      item.max = Number(m[2]);
    } else if (REQUIRED.has(lower)) item.required = true;
    else if ((m = DEFAULT.exec(tok))) item.def = m[2].trim();
    else if (!item.unit) item.unit = tok;
    else item.error = item.error || "unknown";
  }
  return item;
}

/** The items of a text, in order, with a duplicate name marked. */
export function itemsOf(text) {
  const seen = new Set();
  return findItems(text).map((f) => {
    const item = { ...f, ...parseItem(f.inner) };
    if (!item.error && seen.has(item.name)) item.error = "duplicate";
    seen.add(item.name);
    return item;
  });
}

/** The view field kind of an item. */
export function fieldKind(item) {
  return { text: "text", longtext: "longtext", number: "number", date: "date", time: "time", yesno: "boolean", choice: "enum", multi: "multi" }[item.type] || "text";
}

/** Whether a value is outside the item's range. */
export function outOfRange(item, value) {
  if (item.type !== "number" || item.min === null || String(value ?? "").trim() === "") return false;
  const n = Number(value);
  return !Number.isFinite(n) || n < item.min || n > item.max;
}

/** A value as read: with its unit; yes/no in words. */
export function shown(ctx, item, value) {
  const v = String(value ?? "").trim();
  if (!v) return "";
  if (item.type === "yesno") return v === "true" ? word(ctx, "yes") : word(ctx, "no");
  if (item.type === "multi") return v.split(",").map((x) => x.trim()).filter(Boolean).join("、");
  return item.unit ? `${v} ${item.unit}` : v;
}

function word(ctx, key) {
  const l = ctx.t(key);
  return typeof l === "string" ? l : (l && (l[ctx.locale] || l["en-US"])) || key;
}

/** `@名字` in the parameters of `[[=…]]` calls, replaced by the values (`""` when empty). */
export function withValues(text, values) {
  return String(text || "").replace(/\[\[=[^\]]*\]\]/g, (call) => call.replace(/@([A-Za-z0-9_一-鿿]{1,40})/g, (_, n) => String(values[n] ?? "")));
}

/**
 * The text with every item replaced: `fn(item)` gives what goes in its place. Items that cannot be read stay as
 * written.
 */
export function replaceItems(text, fn) {
  const s = String(text || "");
  let out = "";
  let last = 0;
  for (const item of itemsOf(s)) {
    out += s.slice(last, item.start) + fn(item);
    last = item.end;
  }
  return out + s.slice(last);
}

/** The value of each item: what was entered, else its default. */
export function valuesOf(items, entered) {
  const v = {};
  for (const it of items) {
    if (it.error) continue;
    const e = entered[it.name];
    // A default that names an environment value nobody set is no default.
    const def = /^\{\{[^{}]*\}\}$/.test(it.def) ? "" : it.def;
    v[it.name] = e !== undefined && e !== null && String(e) !== "" ? String(e) : def;
  }
  return v;
}

/** What stops signing (required items empty) and what to confirm first (values out of range). */
export function checkValues(items, values) {
  const missing = items.filter((it) => !it.error && it.required && !String(values[it.name] ?? "").trim()).map((it) => it.name);
  const out = items.filter((it) => !it.error && outOfRange(it, values[it.name])).map((it) => ({ name: it.name, value: values[it.name], min: it.min, max: it.max, unit: it.unit }));
  return { missing, out };
}
