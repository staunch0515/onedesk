// What an author uses on a practice or test page: the list of questions and quick writing (§19.3).

import { quick, shortStem } from "./question.js";
import { say, str } from "./common.js";

/** The list of questions (and headings) and the quick-writing box. */
export function authorNodes(ctx, items, qs, { rowActions }) {
  const rows = [];
  const targets = [];
  const keys = [];
  let n = 0;
  items.forEach((it, i) => {
    if (it.h !== undefined) {
      rows.push(["", `【${it.h}】`, "", ""]);
      targets.push(null);
    } else {
      const e = qs.get(it.q);
      if (!e) return;
      n += 1;
      rows.push([String(n), shortStem(e.q), say(ctx, `type.${e.q.type}`), String(e.q.points)]);
      targets.push(`resource:${it.q}`);
    }
    keys.push(String(i));
  });
  const out = [];
  out.push({ type: "text", id: "listTitle", text: `**${say(ctx, "author.list")}**`, format: "markdown" });
  if (rows.length === 0) out.push({ type: "text", id: "noItems", text: say(ctx, "author.none"), tone: "muted" });
  else {
    const table = {
      type: "table",
      id: "items",
      columns: [
        { key: "n", label: say(ctx, "col.n"), numeric: true },
        { key: "stem", label: say(ctx, "col.stem") },
        { key: "type", label: say(ctx, "col.type") },
        { key: "points", label: say(ctx, "col.points"), numeric: true },
      ],
      rows,
      rowTargets: targets,
      rowKeys: keys,
    };
    if (rowActions) table.rowActions = rowActions;
    out.push(table);
  }
  out.push({
    type: "form",
    id: "quick",
    layout: "stack",
    label: ctx.t("quick.title"),
    fields: [{ name: "quick", label: ctx.t("quick.field"), kind: "longtext", param: true, placeholder: ctx.t("quick.placeholder"), hint: ctx.t("quick.hint") }],
  });
  return out;
}

/** Makes the questions written quickly (under `parent`); returns the new items (questions and headings) in order. */
export async function generate(ctx, parent, text) {
  const made = [];
  for (const it of quick(text)) {
    if (it.heading !== undefined) {
      made.push({ h: it.heading });
      continue;
    }
    const r = await ctx.host.resources.create({ kind: "question", parent, name: it.name, body: it.body });
    made.push({ q: r.id });
  }
  return made;
}

export const quickText = (ctx) => str(ctx.params && ctx.params.quick);
