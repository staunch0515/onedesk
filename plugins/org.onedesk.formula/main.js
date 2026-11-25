// Formula plugin (docs/redesign/book.md §17.3, D487): a formula is a resource that computes. Its parameters are read
// from the formula itself (no "add parameter"); each has words, a unit and a default (which may be `{{name}}` from
// the environment). It is called from anywhere — `[[=name | C=37]]` inline, `![[name | C=37]]` as a worked block —
// and, placed in a book, it plays the calculation page (through the interface `onedesk.book/1`).
// Runs in the sandbox: no console, timers or fetch; everything goes through ctx.host. Nothing is run as code.

import { analyze, compute, format, pretty } from "./expr.js";

const NONE = { type: "none" };

/** A plugin text as a string in the context's language, with `{name}` filled from `vars`. */
export function say(ctx, key, vars) {
  const label = ctx.t(key);
  let text = typeof label === "string" ? label : (label && (label[ctx.locale] || label["en-US"])) || key;
  for (const k of Object.keys(vars || {})) text = text.split(`{${k}}`).join(String(vars[k]));
  return text;
}

/** An error of the formula in words. */
export function errorText(ctx, err) {
  return say(ctx, `error.${err.key}`, err.vars || {});
}

/** The body as the person sees it now: the unsaved draft over the saved one. */
export function bodyOf(ctx) {
  const b = Object.assign({}, (ctx.resource && ctx.resource.body) || {});
  if (ctx.draft) for (const [k, v] of Object.entries(ctx.draft)) if (k.startsWith("body.")) b[k.slice(5)] = v;
  return b;
}

const str = (v) => (typeof v === "string" ? v : v === null || v === undefined ? "" : String(v));
const decimalsOf = (b) => {
  const n = Number(b.decimals);
  return Number.isInteger(n) && n >= 0 && n <= 10 ? n : 2;
};
const unitText = (u) => (str(u).trim() ? ` ${str(u).trim()}` : "");

/** `{{name}}` in a default, filled from the tab's environment; a name without a value stays as written. */
async function filled(ctx, text) {
  let out = str(text);
  for (const m of [...out.matchAll(/\{\{([^{}\s]{1,64})\}\}/g)]) {
    try {
      const r = await ctx.host.params.get(m[1]);
      if (r && r.found) out = out.split(m[0]).join(r.value);
    } catch {
      // no environment: as written
    }
  }
  return out;
}

/**
 * The values to compute with: those given (strings from a call, or typed on the page), else each parameter's default.
 * Given names that are no parameter are an error (`unknownParam`); `book` (what a book's contents hands over) is not
 * a parameter.
 */
export async function valuesOf(ctx, b, a, given) {
  const values = {};
  for (const p of a.params) values[p] = await filled(ctx, b[`param.${p}.default`]);
  for (const [k, v] of Object.entries(given || {})) {
    if (k === "book" || typeof v !== "string") continue;
    if (!a.params.includes(k)) return { error: { key: "unknownParam", vars: { name: k } } };
    values[k] = v;
  }
  return { values };
}

/** Computes for a call: `{ a, values, out }` or `{ error }`. */
async function run(ctx, b, given) {
  const a = analyze(b.text);
  if (a.error) return { error: a.error };
  const v = await valuesOf(ctx, b, a, given);
  if (v.error) return { error: v.error };
  const out = compute(a, v.values);
  if (out.error) return { error: out.error };
  return { a, values: v.values, out };
}

/** The formula's lines as shown, and "where:" with each parameter's words, unit and default. */
function shown(ctx, b, a) {
  const lines = str(b.text)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && !l.startsWith("//"))
    .map((l) => `\`${pretty(l)}\``);
  const out = [lines.join("  \n")];
  if (a.params.length > 0) {
    const rows = a.params.map((p) => {
      const words = str(b[`param.${p}.label`]).trim();
      const unit = str(b[`param.${p}.unit`]).trim();
      const def = str(b[`param.${p}.default`]).trim();
      let row = `${p}${words ? `——${words}` : ""}${unit ? `，${unit}` : ""}`;
      if (def) row += say(ctx, "where.default", { value: def });
      return `- ${row}`;
    });
    out.push(`${say(ctx, "where")}\n\n${rows.join("\n")}`);
  }
  return out.join("\n\n");
}

/** Where a formula is called (D487 §17.4): inline, one line with the result; as a block, the formula worked out. */
export async function embedFormula(ctx, ask) {
  const b = (ctx.resource && ctx.resource.body) || {};
  const given = ask && ask.args && typeof ask.args === "object" ? ask.args : {};
  const calls = Object.keys(given).some((k) => k !== "book");
  const r = await run(ctx, b, given);
  if (ask && ask.inline) {
    if (r.error) return { text: errorText(ctx, r.error), error: true };
    return { text: `${format(r.out.result, decimalsOf(b))}${unitText(b.unit)}` };
  }
  const a = analyze(b.text);
  if (a.error) return { view: [{ type: "text", id: "error", text: errorText(ctx, a.error), tone: "danger" }] };
  const view = [{ type: "text", id: "formula", text: shown(ctx, b, a), format: "markdown" }];
  if (!calls) return { view };
  if (r.error) {
    view.push({ type: "text", id: "error", text: errorText(ctx, r.error), tone: "danger" });
    return { view };
  }
  const lines = [say(ctx, "given")];
  for (const p of a.params) lines.push(`- ${p} = ${str(r.values[p])}${unitText(b[`param.${p}.unit`])}`);
  const steps = r.out.steps;
  for (let i = 0; i < steps.length - 1; i++) lines.push(`- ${steps[i].name} = ${format(steps[i].value, decimalsOf(b))}`);
  lines.push("", `**${r.a.result} = ${format(r.out.result, decimalsOf(b))}${unitText(b.unit)}**`);
  view.push({ type: "text", id: "worked", text: lines.join("\n"), format: "markdown" });
  return { view };
}

/** The page: the formula; the result's unit and places; each parameter found in it; trying values out. */
export async function renderFormula(ctx) {
  const b = bodyOf(ctx);
  const view = [
    { type: "form", id: "formula", layout: "stack", fields: [{ name: "text", label: ctx.t("field.text"), kind: "code", bind: "body.text", placeholder: ctx.t("field.text.placeholder") }] },
    {
      type: "form",
      id: "result",
      layout: "strip",
      fields: [
        { name: "unit", label: ctx.t("field.unit"), kind: "text", bind: "body.unit" },
        { name: "decimals", label: ctx.t("field.decimals"), kind: "number", bind: "body.decimals" },
      ],
    },
  ];
  const a = analyze(b.text);
  if (a.error) {
    view.push({ type: "text", id: "error", text: errorText(ctx, a.error), tone: "danger" });
    return { view };
  }
  for (const p of a.params) {
    view.push({
      type: "form",
      id: `param-${p}`,
      layout: "strip",
      label: say(ctx, "param.title", { name: p }),
      fields: [
        { name: `param.${p}.label`, label: ctx.t("field.paramLabel"), kind: "text", bind: `body.param.${p}.label` },
        { name: `param.${p}.unit`, label: ctx.t("field.paramUnit"), kind: "text", bind: `body.param.${p}.unit` },
        { name: `param.${p}.default`, label: ctx.t("field.paramDefault"), kind: "text", bind: `body.param.${p}.default` },
      ],
    });
  }
  // Trying values out: on this tab only, never saved.
  const typed = {};
  for (const p of a.params) {
    const t = ctx.params && ctx.params[`try.${p}`];
    if (typeof t === "string" && t.trim()) typed[p] = t;
  }
  if (a.params.length > 0) {
    view.push({
      type: "form",
      id: "try",
      layout: "strip",
      label: ctx.t("try.title"),
      fields: a.params.map((p) => ({ name: `try.${p}`, label: p, kind: "text", param: true, placeholder: str(b[`param.${p}.default`]) })),
    });
  }
  const r = await run(ctx, b, typed);
  if (r.error) view.push({ type: "text", id: "outcome", text: errorText(ctx, r.error), tone: "danger" });
  else {
    const steps = r.out.steps.map((s, i) => `${s.name} = ${format(s.value, decimalsOf(b))}${i === r.out.steps.length - 1 ? unitText(b.unit) : ""}`);
    view.push({ type: "text", id: "outcome", text: steps.join("\n"), mono: true });
  }
  return { view };
}

export default {
  activate(host) {
    host.kinds.handle("formula", { embed: embedFormula });
    host.pages.handle("formula", { render: renderFormula });
    // `onedesk.book/1`: placed in a book, a formula is a calculation page — in the body, numbered by depth.
    host.actions.handle("roles", async () => ({
      output: NONE,
      data: { kinds: [{ kind: "formula", role: "calc", part: "body", single: false, container: false, numbering: "level" }] },
    }));
    host.actions.handle("outline", async () => ({ output: NONE, data: { headings: [], figures: [], cites: [], terms: [] } }));
  },
};
