// Templates (docs/plugins/spec.md §0.3, D466): `{{name}}` in a resource's content is filled from the values typed on
// the tab, else from the tab's environment (ctx.host.params.get). The syntax is this plugin's own; the core only hands
// out values by name. `{{secret:x}}` has a colon, so it is never one of these: secrets are never shown.
// The same file is copied into every plugin that fills templates (a plugin can only import its own files).

// letters, digits, '_', '-', '.' and Chinese characters, 1 to 64 of them
const HOLE = /\{\{([A-Za-z0-9_.\-一-鿿]{1,64})\}\}/g;

/** The placeholder names in the texts, each once, in order of appearance. */
export function holeNames(...texts) {
  const out = [];
  for (const text of texts) for (const m of String(text || "").matchAll(HOLE)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

/** Fills the placeholders that have a value; one without a value stays as written. */
export function fillHoles(text, values) {
  return String(text || "").replace(HOLE, (all, name) => {
    const v = values && values[name];
    return typeof v === "string" && v !== "" ? v : all;
  });
}

/**
 * The value of each name: typed on the tab (`ctx.params`), else from the environment; in a run, the run's parameters.
 * Returns `{ values, sources }` (sources: the environment each value came from).
 */
export async function holeValues(ctx, names) {
  const values = {};
  const sources = {};
  for (const name of names) {
    const typed = ctx.run ? ctx.run.params && ctx.run.params[name] : ctx.params && ctx.params[name];
    if (typeof typed === "string" && typed !== "") {
      values[name] = typed;
      continue;
    }
    if (ctx.run) continue;
    try {
      const found = await ctx.host.params.get(name);
      if (found && found.found) {
        values[name] = String(found.value);
        sources[name] = found.sourceName;
      }
    } catch (e) {
      // no environment chosen, or the value cannot be read: the placeholder stays
    }
  }
  return { values, sources };
}

/**
 * A strip of page-parameter fields, one per placeholder: shows the environment's value (and which environment it came
 * from); typing overrides it for this tab only. Read only in a run. `null` when there are no placeholders.
 */
export async function holeStrip(ctx, names, id = "values") {
  if (names.length === 0) return null;
  const fields = [];
  for (const name of names) {
    const field = { name, label: name, kind: "text", param: true };
    if (ctx.run) {
      field.envValue = (ctx.run.params && ctx.run.params[name]) || "";
      field.readOnly = true;
    } else {
      try {
        const found = await ctx.host.params.get(name);
        if (found && found.found) {
          field.envValue = String(found.value);
          field.envSource = found.sourceName;
        }
      } catch (e) {
        // no environment: an empty field
      }
    }
    fields.push(field);
  }
  return { type: "form", id, layout: "strip", fields };
}

/** The text with every placeholder filled as `holeValues` finds it. */
export async function filled(ctx, text) {
  const { values } = await holeValues(ctx, holeNames(text));
  return fillHoles(text, values);
}
