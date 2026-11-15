// Sample plugin: a "query"-like kind with parameters, a fake run (progress, cancel, failure), a tidy
// event, a rendered result tab and a remembered last-run summary. Everything goes through ctx.host.
// Sandbox rules: no console, timers or fetch; delays come from ctx.host.util.sleep.

const LAST_RUN_KEY = "lastRun";
const SLOW_STEPS = 20;
const KEYWORDS = ["select", "from", "where", "and", "or", "order by", "group by", "limit", "join", "on", "as", "insert", "update", "delete", "into", "values", "set"];

/* ---------------------------------------------------------------- helpers */

// Plain text of a label in the current locale, with {name} placeholders filled in.
export function tr(ctx, key, vars) {
  const label = ctx.t(key);
  let text = typeof label === "string" ? label : label[ctx.locale] || label["en-US"] || key;
  for (const k of Object.keys(vars || {})) text = text.split(`{${k}}`).join(String(vars[k]));
  return text;
}

// Strings and comments are blanked so a ':name' inside them is not a parameter.
function blank(text) {
  return text.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|--[^\n]*|\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length));
}

export function paramNames(text) {
  const clean = blank(text);
  const re = /(^|[^:\w]):([A-Za-z_][A-Za-z0-9_]*)/g;
  const out = [];
  for (let m = re.exec(clean); m; m = re.exec(clean)) if (!out.includes(m[2])) out.push(m[2]);
  return out;
}

export function paramKind(name) {
  if (name === "limit" || name.endsWith("_id")) return "number";
  if (name.endsWith("_time")) return "datetime";
  if (name.endsWith("_date")) return "date";
  return "text";
}

export function fillParams(text, values) {
  const clean = blank(text);
  let out = "";
  let last = 0;
  const re = /(^|[^:\w]):([A-Za-z_][A-Za-z0-9_]*)/g;
  for (let m = re.exec(clean); m; m = re.exec(clean)) {
    const start = m.index + m[1].length;
    out += text.slice(last, start) + (values[m[2]] !== undefined && values[m[2]] !== "" ? values[m[2]] : `:${m[2]}`);
    last = start + 1 + m[2].length;
  }
  return out + text.slice(last);
}

export function tidy(text, casing) {
  const clean = blank(text);
  const chars = text.split("");
  for (const kw of KEYWORDS) {
    const re = new RegExp(`(^|[^A-Za-z0-9_:])(${kw.replace(" ", "\\s+")})(?![A-Za-z0-9_])`, "gi");
    for (let m = re.exec(clean); m; m = re.exec(clean)) {
      const start = m.index + m[1].length;
      const word = (casing === "lower" ? m[2].toLowerCase() : m[2].toUpperCase()).replace(/\s+/g, (s) => s);
      for (let i = 0; i < m[2].length; i++) chars[start + i] = word[i] || chars[start + i];
    }
  }
  return chars.join("");
}

// FNV-1a: a stable number from text, so the same text and parameters give the same table.
export function hash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

const STATUSES = ["paid", "pending", "refunded", "failed"];

export function buildRows(text, params, limit) {
  const seed = hash(text + JSON.stringify(params));
  const total = 30 + (seed % 470);
  const n = Math.max(0, Math.min(total, limit));
  const rows = [];
  let s = seed;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    rows.push([i + 1, `customer-${(s % 900) + 100}`, (s % 100000) / 100, STATUSES[s % STATUSES.length]]);
  }
  return { rows, total };
}

function bodyText(ctx) {
  if (ctx.run && ctx.run.input && typeof ctx.run.input["body.text"] === "string") return ctx.run.input["body.text"];
  if (ctx.draft && typeof ctx.draft["body.text"] === "string") return ctx.draft["body.text"];
  return (ctx.resource && ctx.resource.body && ctx.resource.body.text) || "";
}

async function intSetting(ctx, name, fallback) {
  const raw = await ctx.host.settings.get(name);
  const n = Number(raw);
  return raw !== null && raw !== undefined && Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/* ---------------------------------------------------------------- plugin */

export default {
  activate(host) {
    host.pages.handle("editor", {
      async render(ctx) {
        const text = bodyText(ctx);
        const names = paramNames(text);
        const view = [];

        if (names.length > 0) {
          const fields = [];
          for (const name of names) {
            const field = { name, label: name, kind: paramKind(name), param: true };
            if (ctx.run) {
              field.envValue = (ctx.run.params && ctx.run.params[name]) || "";
              field.readOnly = true;
            } else {
              const found = await ctx.host.params.get(name);
              if (found.found) {
                field.envValue = found.value;
                field.envSource = found.sourceName;
              }
            }
            fields.push(field);
          }
          view.push({ type: "form", id: "params", layout: "strip", fields });
        }

        const last = await ctx.host.storage.get(LAST_RUN_KEY);
        let lastText = tr(ctx, "last.none");
        if (last) {
          try {
            const s = JSON.parse(last);
            lastText = tr(ctx, "last.run", { rows: s.rows, total: s.total });
          } catch (e) {
            // a damaged value: show "no run yet"
          }
        }
        view.push({ type: "text", id: "last", text: lastText, tone: "muted" });

        const editor = {
          name: "text",
          label: ctx.t("field.text"),
          kind: "code",
          bind: "body.text",
          fill: true,
          language: "sql",
          placeholder: ctx.t("field.placeholder"),
        };
        if (ctx.run) editor.readOnly = true;
        view.push({ type: "form", id: "editor", layout: "stack", fields: [editor] });
        return { view };
      },

      async onEvent(ctx, event) {
        if (event !== "tidy") throw new Error(`unknown event ${event}`);
        const text = bodyText(ctx);
        const casing = (await ctx.host.settings.get("style")) || "upper";
        const next = tidy(text, casing);
        if (next === text) return { message: ctx.t("message.tidyNothing") };
        return { changes: { "body.text": next }, message: ctx.t("message.tidied") };
      },

      async renderResultTab(ctx, tabId) {
        if (tabId !== "final") throw new Error(`unknown result tab ${tabId}`);
        const text = bodyText(ctx);
        const values = (ctx.run && ctx.run.params) || {};
        return [{ type: "text", id: "final", text: fillParams(text, values), mono: true, language: "sql" }];
      },
    });

    host.actions.handle("run", async (ctx, input) => {
      const text = String((input && input["body.text"]) || "");
      if (text.includes("!fail")) throw new Error(tr(ctx, "error.fail"));

      if (text.includes("!slow")) {
        for (let i = 1; i <= SLOW_STEPS; i++) {
          if (ctx.cancelled()) return { output: { type: "none" }, summary: { message: tr(ctx, "summary.cancelled") } };
          ctx.progress(i / SLOW_STEPS, tr(ctx, "step.slow", { n: i }));
          await ctx.host.util.sleep(1000);
        }
        return { output: { type: "none" }, summary: { message: tr(ctx, "summary.slow") } };
      }

      ctx.progress(0.1, tr(ctx, "step.parse"));
      await ctx.host.util.sleep(250);

      if (text.includes("!text")) {
        ctx.progress(0.7, tr(ctx, "step.build"));
        await ctx.host.util.sleep(250);
        const out = tr(ctx, "text.out", { text: fillParams(text, ctx.params || {}) });
        return { output: { type: "text", text: out }, summary: { message: tr(ctx, "summary.text") } };
      }

      const limit = await intSetting(ctx, "rowLimit", 200);
      ctx.progress(0.4, tr(ctx, "step.fetch"));
      await ctx.host.util.sleep(300);
      const { rows, total } = buildRows(text, ctx.params || {}, limit);
      ctx.progress(0.8, tr(ctx, "step.build"));
      await ctx.host.util.sleep(200);

      await ctx.host.storage.set(LAST_RUN_KEY, JSON.stringify({ rows: rows.length, total }));
      return {
        output: {
          type: "table",
          columns: [
            { key: "id", label: "id", numeric: true },
            { key: "customer", label: "customer" },
            { key: "amount", label: "amount", numeric: true },
            { key: "status", label: "status" },
          ],
          rows,
          total,
        },
        summary: { rows: rows.length, message: tr(ctx, "summary.rows", { rows: rows.length }) },
      };
    });
  },
};
