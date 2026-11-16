// Fixture: example "command" plugin. Runs a declared external program through ctx.host.process.run, streams its output
// as progress, and listens to two events to keep "last run" and "how many commands" in its own storage.
// Sandbox rules: no console, timers or fetch; everything goes through ctx.host.

const LAST_RUN_KEY = "lastRun";
const COUNT_KEY = "count";
const PROGRAMS = ["echo", "sleep", "sh", "hello"];

/* ---------------------------------------------------------------- helpers */

export function tr(ctx, key, vars) {
  const label = ctx.t(key);
  let text = typeof label === "string" ? label : label[ctx.locale] || label["en-US"] || key;
  for (const k of Object.keys(vars || {})) text = text.split(`{${k}}`).join(String(vars[k]));
  return text;
}

// One argument per line. A trailing "\r" is dropped; empty lines are kept out (use a quoted argument for an empty string).
export function parseArgs(text) {
  return String(text || "")
    .split("\n")
    .map((l) => l.replace(/\r$/, ""))
    .filter((l) => l !== "");
}

// NAME=value per line. Blank lines and lines starting with '#' are skipped; the value is everything after the first '='.
export function parseEnv(text) {
  const out = {};
  for (const raw of String(text || "").split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i <= 0) continue;
    out[line.slice(0, i).trim()] = line.slice(i + 1);
  }
  return out;
}

export function outputText(ctx, result) {
  const out = String(result.stdout || "");
  const err = String(result.stderr || "");
  return err ? `${out}${out && !out.endsWith("\n") ? "\n" : ""}${tr(ctx, "stderr.mark")}\n${err}` : out;
}

export function summaryText(ctx, result, ms) {
  if (result.code === null || result.code === undefined) return tr(ctx, "summary.signal", { signal: result.signal || "?", ms });
  return tr(ctx, "summary.exit", { code: result.code, ms });
}

/* ---------------------------------------------------------------- plugin */

export default {
  activate(host) {
    host.kinds.handle("command", {});

    host.pages.handle("editor", {
      async render(ctx) {
        const ro = !!ctx.run;
        const withRO = (f) => (ro ? { ...f, readOnly: true } : f);

        let lastText = tr(ctx, "last.none");
        const rawLast = await ctx.host.storage.get(LAST_RUN_KEY);
        if (rawLast) {
          try {
            const s = JSON.parse(rawLast);
            lastText = tr(ctx, "last.run", { status: s.status, at: s.at });
          } catch (e) {
            // a damaged value: show "none yet"
          }
        }
        const rawCount = await ctx.host.storage.get(COUNT_KEY);
        const count = Number(rawCount);

        return {
          view: [
            { type: "text", id: "last", text: lastText, tone: "muted" },
            { type: "text", id: "count", text: tr(ctx, "count.line", { count: rawCount !== null && rawCount !== undefined && Number.isFinite(count) ? count : 0 }), tone: "muted" },
            {
              type: "form",
              id: "program",
              layout: "strip",
              fields: [
                withRO({ name: "program", label: ctx.t("field.program"), kind: "enum", bind: "body.program", options: PROGRAMS.map((p) => ({ value: p, label: p })) }),
              ],
            },
            {
              type: "form",
              id: "args",
              layout: "stack",
              fields: [withRO({ name: "args", label: ctx.t("field.args"), kind: "longtext", bind: "body.args", placeholder: ctx.t("field.args.placeholder") })],
            },
            {
              type: "form",
              id: "env",
              layout: "stack",
              fields: [withRO({ name: "env", label: ctx.t("field.env"), kind: "longtext", bind: "body.env", placeholder: ctx.t("field.env.placeholder") })],
            },
          ],
        };


      },
    });

    host.actions.handle("run", async (ctx, input) => {
      const program = String((input && input["body.program"]) || "echo");
      const args = parseArgs(input && input["body.args"]);
      const env = parseEnv(input && input["body.env"]);
      const started = Date.now();
      // Host errors (denied / notFound / invalid ...) are not caught: they reach the run with their code and params.
      const result = await ctx.host.process.run({
        program,
        args,
        env,
        onOutput: (chunk) => ctx.progress(0, String(chunk.text)),
      });
      const ms = Date.now() - started;
      return {
        output: { type: "text", text: outputText(ctx, result) },
        summary: { message: summaryText(ctx, result, ms) },
      };
    });

    host.events.on("run.ended", async (ctx, event) => {
      await ctx.host.storage.set(LAST_RUN_KEY, JSON.stringify({ status: event.status, at: new Date().toISOString() }));
    });

    host.events.on("resource.changed", async (ctx) => {
      const list = await ctx.host.resources.list({ kind: "command" });
      await ctx.host.storage.set(COUNT_KEY, String(list.length));
    });
  },
};
