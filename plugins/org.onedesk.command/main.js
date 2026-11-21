// Server command plugin: saved shell commands with :name parameters, run on a server over the system's `ssh`
// (its ~/.ssh/config, keys and agent; BatchMode, so it never asks for a password). One kind ("command"), a page
// with the ssh alias, the limits, a parameter strip and the editor, an action "run" whose output is a table of
// (stream, line) drawn as a terminal: stderr lines in another colour. Values are quoted by shell rules, so a
// value is always one word and never runs as a command. Lines that look like `PASSWORD=…` are masked.
// The command reaches the server on ssh's standard input (`bash -s`), so the login shell there never parses it.
// Sandbox rules: no console, timers or fetch; programs run through ctx.host.process.

export const KIND = "command";
export const DEFAULT_TIMEOUT_S = 60;
export const MAX_TIMEOUT_S = 600; // the kernel's limit for one program
export const DEFAULT_MAX_LINES = 5000;
export const MAX_MAX_LINES = 10000; // what the kernel keeps of a table in a run
const CONNECT_TIMEOUT_S = 10;
const PARTIAL_EVERY_MS = 300;

/* ---- shell helpers: the same text in org.onedesk.command and org.onedesk.script (a test compares them) ---- */

export function tr(ctx, key, vars) {
  const label = ctx.t(key);
  let text = typeof label === "string" ? label : label[ctx.locale] || label["en-US"] || key;
  for (const k of Object.keys(vars || {})) text = text.split(`{${k}}`).join(String(vars[k]));
  return text;
}

// A character before `:` that makes it part of a word (a path, a URL, `user:group`, `${x:1}`), not a parameter.
const WORD_BEFORE = /[A-Za-z0-9_:/.@$\-}\]~%+]/;

// Splits shell text into raw pieces and `:name` parameters. Only text the shell reads unquoted can hold a
// parameter: '…' and "…" strings, `\` escapes, `#` comments and here-document bodies stay as written (inside
// "…" or a here-document the shell would still expand `$(…)` in a value, so a value never goes there).
export function tokenizeShell(text) {
  const s = String(text || "");
  const out = [];
  let raw = "";
  let i = 0;
  let wordStart = true;
  const heredocs = [];
  const flush = () => {
    if (raw) out.push({ raw });
    raw = "";
  };
  while (i < s.length) {
    const c = s[i];
    if (c === "\\") {
      raw += s.slice(i, i + 2);
      i += 2;
      wordStart = false;
    } else if (c === "'") {
      const j = s.indexOf("'", i + 1);
      const end = j < 0 ? s.length : j + 1;
      raw += s.slice(i, end);
      i = end;
      wordStart = false;
    } else if (c === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"') j += s[j] === "\\" ? 2 : 1;
      const end = Math.min(s.length, j + 1);
      raw += s.slice(i, end);
      i = end;
      wordStart = false;
    } else if (c === "#" && wordStart) {
      let j = i;
      while (j < s.length && s[j] !== "\n") j++;
      raw += s.slice(i, j);
      i = j;
    } else if (c === "<" && s[i + 1] === "<" && s[i + 2] === "<") {
      // a here-string is one word, read like any other
      raw += "<<<";
      i += 3;
      wordStart = true;
    } else if (c === "<" && s[i + 1] === "<") {
      // a here-document: remember its delimiter; its body starts after the end of this line
      const m = /^<<-?[ \t]*(?:'([^'\n]*)'|"([^"\n]*)"|\\?([^\s;&|<>()]+))/.exec(s.slice(i));
      if (m) {
        heredocs.push(m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]);
        raw += m[0];
        i += m[0].length;
      } else {
        raw += "<<";
        i += 2;
      }
      wordStart = true;
    } else if (c === "\n") {
      raw += c;
      i++;
      wordStart = true;
      while (heredocs.length > 0) {
        const delim = heredocs.shift();
        for (;;) {
          if (i >= s.length) break;
          const nl = s.indexOf("\n", i);
          const end = nl < 0 ? s.length : nl + 1;
          const line = s.slice(i, nl < 0 ? s.length : nl);
          raw += s.slice(i, end);
          i = end;
          if (line.replace(/^\t+/, "") === delim) break;
        }
      }
    } else if (c === ":" && /[A-Za-z_]/.test(s[i + 1] || "") && !(i > 0 && WORD_BEFORE.test(s[i - 1]))) {
      let j = i + 1;
      while (j < s.length && /[A-Za-z0-9_]/.test(s[j])) j++;
      flush();
      out.push({ param: s.slice(i + 1, j) });
      i = j;
      wordStart = false;
    } else {
      raw += c;
      wordStart = /[\s;&|()]/.test(c);
      i++;
    }
  }
  flush();
  return out;
}

export function paramNames(text) {
  const names = [];
  for (const t of tokenizeShell(text)) if (t.param !== undefined && !names.includes(t.param)) names.push(t.param);
  return names;
}

// `# @param NAME [type=text|number|enum] [required] [max=N] [values=a|b] [-- description]` lines.
export function declarations(text) {
  const out = {};
  for (const line of String(text || "").split("\n")) {
    const m = /^\s*#\s*@param\s+([A-Za-z_][A-Za-z0-9_]*)(.*)$/.exec(line);
    if (!m) continue;
    const bar = m[2].indexOf(" -- ");
    const opts = (bar < 0 ? m[2] : m[2].slice(0, bar)).trim().split(/\s+/).filter(Boolean);
    const decl = { type: "text", required: false, max: 0, values: [], description: bar < 0 ? "" : m[2].slice(bar + 4).trim() };
    for (const o of opts) {
      const eq = o.indexOf("=");
      const k = eq < 0 ? o : o.slice(0, eq);
      const v = eq < 0 ? "" : o.slice(eq + 1);
      if (k === "required") decl.required = true;
      else if (k === "type" && ["text", "number", "enum"].includes(v)) decl.type = v;
      else if (k === "max" && /^\d+$/.test(v)) decl.max = Number(v);
      else if (k === "values") decl.values = v.split("|").filter(Boolean);
    }
    if (decl.values.length > 0) decl.type = "enum";
    out[m[1]] = decl;
  }
  return out;
}

export function declOf(decls, name) {
  return decls[name] || { type: "text", required: false, max: 0, values: [], description: "" };
}

// null when the value may be used, else the reason key.
export function checkValue(decl, value) {
  if (value === null || value === "") return decl.required ? "required" : null;
  if (value.includes("\0")) return "nul";
  if (decl.max > 0 && value.length > decl.max) return "tooLong";
  if (decl.type === "number" && !/^-?\d+(\.\d+)?$/.test(value)) return "number";
  if (decl.type === "enum" && !decl.values.includes(value)) return "enum";
  return null;
}

// One word for any shell of the Bourne family: '…' with each ' written as '\''. Nothing inside is expanded.
export function shellQuote(value) {
  return `'${String(value).split("'").join("'\\''")}'`;
}

// The text with every parameter replaced by its quoted value (a missing value is '').
export function renderShell(text, values) {
  let out = "";
  for (const t of tokenizeShell(text)) out += t.param !== undefined ? shellQuote(values[t.param] === null || values[t.param] === undefined ? "" : values[t.param]) : t.raw;
  return out;
}

// Each parameter's value: typed on the page, else from the environment. Throws with the first bad one.
export async function paramValues(ctx, text) {
  const decls = declarations(text);
  const values = {};
  for (const name of paramNames(text)) {
    const typed = ctx.params && ctx.params[name];
    let value = typed !== undefined && typed !== null && typed !== "" ? String(typed) : null;
    if (value === null) {
      const found = await ctx.host.params.get(name);
      if (found && found.found && found.value !== "") value = String(found.value);
    }
    const problem = checkValue(declOf(decls, name), value);
    if (problem) throw new Error(tr(ctx, `error.param.${problem}`, { name, max: declOf(decls, name).max }));
    values[name] = value;
  }
  return values;
}

// Names that hold secrets; `NAME=value`, `NAME: value`, `"name": "value"`, `--name=value` have the value masked.
const SECRET_NAME = "[A-Za-z0-9_.-]*(?:passw(?:or)?d|pass|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credentials?)[A-Za-z0-9_.-]*";
const ASSIGNED = new RegExp(`((?:^|[^A-Za-z0-9_.-])["']?${SECRET_NAME}["']?[ \\t]*[:=][ \\t]*)(?![{\\[])("(?:[^"\\\\]|\\\\.)+"|'[^']+'|[^\\s,;&|"']+)`, "gi");
const AUTH_HEADER = /(\bauthorization["']?[ \t]*[:=][ \t]*["']?(?:(?:bearer|basic|token|digest)[ \t]+)?)([^\s"',;]+)/gi;
const URL_PASSWORD = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s/@]+)(@)/gi;
export const MASK = "***";

export function maskLine(line) {
  return String(line)
    .replace(URL_PASSWORD, (_, a, _p, b) => `${a}${MASK}${b}`)
    .replace(AUTH_HEADER, (_, a) => `${a}${MASK}`)
    .replace(ASSIGNED, (_, a, v) => {
      const q = v[0] === '"' || v[0] === "'" ? v[0] : "";
      return `${a}${q}${MASK}${q}`;
    });
}

// Terminal colour codes and the carriage return of CRLF output are not part of a line.
export function cleanLine(line) {
  return String(line).replace(/\r$/, "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
}

// One output line as a row [stream, line]: colour codes dropped, secret-looking values masked.
export function lineRow(line) {
  return [line && line.stream === "stderr" ? "stderr" : "stdout", maskLine(cleanLine((line && line.text) || ""))];
}

// The output of a run: one row per line, drawn as a terminal (X10): the `stream` column names the tone.
export function linesOutput(ctx, rows, truncated) {
  return {
    type: "table",
    columns: [
      { key: "stream", label: tr(ctx, "column.stream") },
      { key: "line", label: tr(ctx, "column.line") },
    ],
    rows,
    total: rows.length + (truncated ? 1 : 0),
    appearance: "terminal",
    toneColumn: "stream",
    lineColumn: "line",
  };
}

export function intIn(text, lo, hi, fallback) {
  const s = String(text === undefined || text === null ? "" : text).trim();
  if (s === "") return fallback;
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return n >= lo && n <= hi ? n : null;
}

// Runs one program line by line (X17: the kernel ends it at the line limit or the timeout) and returns
// { rows, truncated, code, signal, timedOut } with the lines it wrote so far. While it runs the lines so far go to
// the shell as the run's partial output.
export async function runLines(ctx, spec, maxLines) {
  const runs = ctx.host.runs;
  const partial = runs && typeof runs.partial === "function" ? runs.partial : null;
  const live = [];
  let last = 0;
  let shown = 0;
  const show = (force) => {
    if (!partial || live.length === shown) return;
    const now = Date.now();
    if (!force && now - last < PARTIAL_EVERY_MS) return;
    last = now;
    shown = live.length;
    Promise.resolve(partial(linesOutput(ctx, live.slice(0, maxLines), false))).catch(() => {});
  };
  const res = await ctx.host.process.run({
    ...spec,
    lines: true,
    maxLines,
    onOutput: (line) => {
      live.push(lineRow(line));
      show(false);
    },
  });
  const rows = (Array.isArray(res.lines) ? res.lines.map(lineRow) : live).slice(0, maxLines);
  return {
    rows,
    truncated: res.stopped === "maxLines" || res.truncated === true,
    code: res.code === undefined ? null : res.code,
    signal: res.signal || null,
    timedOut: res.stopped === "timeout",
  };
}

// The run's message: how many lines, how it ended.
export function endMessage(ctx, r, timeoutS) {
  const parts = [tr(ctx, "summary.lines", { n: r.rows.length })];
  if (r.timedOut) parts.push(tr(ctx, "summary.timeout", { s: timeoutS }));
  else if (r.truncated) parts.push(tr(ctx, "summary.truncated"));
  else if (r.signal) parts.push(tr(ctx, "summary.signal", { signal: r.signal }));
  else if (r.code !== null && r.code !== undefined) parts.push(tr(ctx, "summary.exit", { code: r.code }));
  return parts.join(" · ");
}

export function programError(ctx, err) {
  const reason = err && err.params && err.params.reason ? `/${err.params.reason}` : "";
  const program = err && err.params && err.params.program ? ` ${err.params.program}` : "";
  return Object.assign(new Error(`${tr(ctx, "error.cannotRun")}${program} (${(err && err.code) || "error"}${reason})`), { code: err && err.code, params: err && err.params });
}

/* ---- end of shell helpers ---- */

// An ssh alias or host: letters, digits and `._-@:`, no leading '-' (it would read as an option of ssh).
export function safeHost(h) {
  return typeof h === "string" && h.length > 0 && h.length <= 128 && !h.startsWith("-") && /^[A-Za-z0-9._@:-]+$/.test(h);
}

// What the page holds (the run's snapshot, then the draft, then the saved body).
export function bodyOf(ctx) {
  const pick = (key, dflt) => {
    if (ctx.run && ctx.run.input && typeof ctx.run.input[`body.${key}`] === "string") return ctx.run.input[`body.${key}`];
    if (ctx.draft && typeof ctx.draft[`body.${key}`] === "string") return ctx.draft[`body.${key}`];
    const b = ctx.resource && ctx.resource.body;
    return b && typeof b[key] === "string" ? b[key] : dflt;
  };
  return { host: pick("host", "").trim(), command: pick("command", ""), timeoutSec: pick("timeoutSec", ""), maxLines: pick("maxLines", "") };
}

// What `ctx.host.process.run` gets: ssh without a terminal, never asking (BatchMode), the command on stdin.
export function sshSpec(host, script, timeoutS) {
  return {
    program: "ssh",
    args: ["-T", "-o", "BatchMode=yes", "-o", `ConnectTimeout=${CONNECT_TIMEOUT_S}`, "--", host, "bash -s"],
    stdin: script.endsWith("\n") ? script : `${script}\n`,
    timeoutMs: timeoutS * 1000,
  };
}

function paramField(ctx, name, decl) {
  const field = { name, label: name, kind: decl.type === "enum" ? "enum" : decl.type === "number" ? "number" : "text", param: true };
  if (decl.type === "enum") field.options = decl.values.map((v) => ({ value: v, label: v }));
  if (decl.required) field.required = true;
  if (decl.max > 0 && field.kind === "text") field.maxLength = decl.max;
  if (decl.description) field.hint = decl.description;
  return field;
}

/* ---------------------------------------------------------------- plugin */

export default {
  activate(host) {
    host.pages.handle("editor", {
      async render(ctx) {
        const b = bodyOf(ctx);
        const ro = ctx.run ? { readOnly: true } : {};
        const view = [
          {
            type: "form",
            id: "target",
            layout: "strip",
            fields: [
              { name: "host", label: ctx.t("field.host"), kind: "text", bind: "body.host", placeholder: ctx.t("field.host.placeholder"), hint: tr(ctx, "field.host.hint"), ...(ctx.run ? {} : { required: true }), ...ro },
              { name: "timeoutSec", label: ctx.t("field.timeoutSec"), kind: "number", bind: "body.timeoutSec", placeholder: String(DEFAULT_TIMEOUT_S), ...ro },
              { name: "maxLines", label: ctx.t("field.maxLines"), kind: "number", bind: "body.maxLines", placeholder: String(DEFAULT_MAX_LINES), ...ro },
            ],
          },
        ];
        const names = paramNames(b.command);
        if (names.length > 0) {
          const decls = declarations(b.command);
          const fields = [];
          for (const name of names) {
            const field = paramField(ctx, name, declOf(decls, name));
            if (ctx.run) {
              field.envValue = (ctx.run.params && ctx.run.params[name]) || "";
              field.readOnly = true;
            } else {
              const found = await ctx.host.params.get(name);
              if (found && found.found) {
                field.envValue = found.value;
                field.envSource = found.sourceName;
              }
            }
            fields.push(field);
          }
          view.push({ type: "form", id: "params", layout: "strip", fields });
        }
        view.push({
          type: "form",
          id: "editor",
          layout: "stack",
          fields: [{ name: "command", label: ctx.t("field.command"), kind: "code", bind: "body.command", fill: true, language: "shell", placeholder: ctx.t("field.command.placeholder"), ...ro }],
        });
        if (!ctx.run) view.push({ type: "text", id: "note", text: tr(ctx, "note.ssh"), tone: "muted" });
        return { view };
      },

      async onEvent(ctx, event) {
        if (event !== "copy") throw new Error(`unknown event ${event}`);
        await ctx.host.ui.copy(bodyOf(ctx).command);
        return { message: tr(ctx, "message.copied") };
      },

      // The command exactly as it went to the server, rebuilt from the run's snapshot and parameters.
      async renderResultTab(ctx, tabId) {
        if (tabId !== "sent") throw new Error(`unknown result tab ${tabId}`);
        if (!ctx.run) return [{ type: "text", id: "none", text: tr(ctx, "sent.none"), tone: "muted" }];
        const b = bodyOf(ctx);
        const values = {};
        for (const name of paramNames(b.command)) values[name] = (ctx.run.params && ctx.run.params[name]) || "";
        const text = renderShell(b.command, values).split("\n").map(maskLine).join("\n");
        return [
          { type: "text", id: "host", text: tr(ctx, "sent.host", { host: b.host }), tone: "muted" },
          { type: "text", id: "sent", text, mono: true, language: "shell" },
        ];
      },
    });

    host.actions.handle("run", async (ctx, input) => {
      const i = input || {};
      const command = String(i["body.command"] !== undefined ? i["body.command"] : bodyOf(ctx).command);
      if (!command.trim()) throw new Error(tr(ctx, "error.empty"));
      const hostName = String(i["body.host"] !== undefined ? i["body.host"] : bodyOf(ctx).host).trim();
      if (!safeHost(hostName)) throw new Error(tr(ctx, "error.badHost"));
      const timeoutS = intIn(i["body.timeoutSec"], 1, MAX_TIMEOUT_S, DEFAULT_TIMEOUT_S);
      if (timeoutS === null) throw new Error(tr(ctx, "error.badTimeout", { max: MAX_TIMEOUT_S }));
      const maxLines = intIn(i["body.maxLines"], 1, MAX_MAX_LINES, DEFAULT_MAX_LINES);
      if (maxLines === null) throw new Error(tr(ctx, "error.badMaxLines", { max: MAX_MAX_LINES }));
      const values = await paramValues(ctx, command);
      const script = renderShell(command, values);

      ctx.progress(undefined, tr(ctx, "step.running", { host: hostName }));
      let r;
      try {
        r = await runLines(ctx, sshSpec(hostName, script, timeoutS), maxLines);
      } catch (err) {
        if (err && err.code === "denied" && err.params && err.params.reason === "cancelled") throw err;
        throw programError(ctx, err);
      }
      // 255 is ssh's own failure (cannot connect, key refused): the run failed, with what ssh said.
      if (r.code === 255 && !r.rows.some((row) => row[0] === "stdout")) {
        const said = r.rows.map((row) => row[1]).filter(Boolean).slice(0, 4).join("\n");
        throw new Error(tr(ctx, "error.ssh", { host: hostName, detail: said || "exit 255" }));
      }
      return { output: linesOutput(ctx, r.rows, r.truncated || r.timedOut), summary: { rows: r.rows.length, message: endMessage(ctx, r, timeoutS) } };
    });
  },
};
