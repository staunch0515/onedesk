// Local script plugin: saved bash scripts with :name parameters, a timeout and a line limit, run with the
// system's `bash` on this Mac; the output is a table of (stream, line) drawn as a terminal (stderr in another
// colour), with secret-looking values masked. "Export all" writes every script as a `.sh` file into a folder the
// user granted. Values are quoted by shell rules, so a value is always one word and never runs as a command.
// The script reaches bash on its standard input (`bash -s`). Sandbox rules: no console, timers or fetch.

export const KIND = "script";
export const DEFAULT_TIMEOUT_S = 60;
export const MAX_TIMEOUT_S = 7200; // the kernel's limit for one program (2 h)
export const DEFAULT_MAX_LINES = 5000;
export const MAX_MAX_LINES = 10000; // what the kernel keeps of a table in a run
const PARTIAL_EVERY_MS = 300;
const PARTIAL_LINES = 500;

/* ---- shell helpers: the same text in org.onedesk.command and org.onedesk.script (a test compares them) ---- */

export function tr(ctx, key, vars) {
  const label = ctx.t(key);
  let text = typeof label === "string" ? label : label[ctx.locale] || label["en-US"] || key;
  for (const k of Object.keys(vars || {})) text = text.split(`{${k}}`).join(String(vars[k]));
  return text;
}

// A character before `:` that makes it part of a word (a path, a URL, `user:group`, `${x:1}`), not a parameter.
const WORD_BEFORE = /[A-Za-z0-9_:/.@$\-}\]~%+]/;
const PARAM_START = /[A-Za-z_]/;
const PARAM_CHAR = /[A-Za-z0-9_]/;
// Anything that could be a parameter, wherever it is: used to refuse a template the scanner is unsure about.
const MAYBE_PARAM = /(?:^|[^A-Za-z0-9_:/.@$\-}\]~%+]):[A-Za-z_]/;

// Reads shell text the way bash does and finds the `:name` parameters and the context each one is in:
//   word     an unquoted word (also inside $(…) and ${…} at the top),
//   dq       inside "…" (also a here-document body whose delimiter is not quoted),
//   brace    inside ${…},
//   arith    inside $((…)) or ((…)) — only whole numbers may go there.
// '…', $'…', `\x`, # comments and the bodies of here-documents with a quoted delimiter are raw text. What it
// cannot read with certainty (backticks holding a parameter, `case` inside $(…), $[…], ' inside "${…}",
// anything left open) makes `uncertain` a reason, and a template with a parameter is then refused.
// Returns { pieces: [{ raw } | { param, ctx }], uncertain }.
export function scanShell(text) {
  const s = String(text || "");
  const pieces = [];
  let raw = "";
  let uncertain = null;
  let i = 0;
  const heredocs = [];
  const unsure = (why) => {
    if (!uncertain) uncertain = why;
  };
  const flush = () => {
    if (raw) pieces.push({ raw });
    raw = "";
  };
  const take = (n) => {
    raw += s.slice(i, i + n);
    i += n;
  };
  const param = (ctx) => {
    let j = i + 1;
    while (j < s.length && PARAM_CHAR.test(s[j])) j++;
    flush();
    pieces.push({ param: s.slice(i + 1, j), ctx });
    i = j;
  };
  const isParam = () => s[i] === ":" && PARAM_START.test(s[i + 1] || "") && !(i > 0 && WORD_BEFORE.test(s[i - 1]));

  const single = () => {
    const j = s.indexOf("'", i + 1);
    if (j < 0) {
      unsure("openQuote");
      take(s.length - i);
    } else take(j + 1 - i);
  };
  const ansiC = () => {
    let j = i + 2;
    while (j < s.length && s[j] !== "'") j += s[j] === "\\" ? 2 : 1;
    if (j >= s.length) unsure("openQuote");
    take(Math.min(s.length, j + 1) - i);
  };
  const backtick = () => {
    let j = i + 1;
    while (j < s.length && s[j] !== "`") j += s[j] === "\\" ? 2 : 1;
    if (j >= s.length) unsure("openBacktick");
    const inner = s.slice(i + 1, Math.min(j, s.length));
    if (MAYBE_PARAM.test(inner)) unsure("backtick");
    take(Math.min(s.length, j + 1) - i);
  };
  // `$(`, `${`, `$((`, `$[`, backticks: the expansions that can appear in any context but '…'.
  const expansion = (inDq) => {
    if (s.startsWith("$((", i)) {
      take(3);
      arith(2);
    } else if (s.startsWith("$(", i)) {
      take(2);
      command(")");
    } else if (s.startsWith("${", i)) {
      take(2);
      brace(inDq);
    } else if (s.startsWith("$[", i)) {
      unsure("oldArith");
      take(2);
    } else if (s[i] === "`") {
      backtick();
    } else return false;
    return true;
  };
  const double = () => {
    take(1);
    while (i < s.length && s[i] !== '"') {
      if (s[i] === "\\") take(2);
      else if (expansion(true)) continue;
      else if (isParam()) param("dq");
      else take(1);
    }
    if (i >= s.length) unsure("openQuote");
    else take(1);
  };
  const brace = (inDq) => {
    while (i < s.length && s[i] !== "}") {
      if (s[i] === "\\") take(2);
      else if (s[i] === "'") {
        if (inDq) unsure("quoteInBrace");
        single();
      } else if (s[i] === '"') double();
      else if (expansion(inDq)) continue;
      else if (isParam()) param("brace");
      else take(1);
    }
    if (i >= s.length) unsure("openBrace");
    else take(1);
  };
  // After `$((` or `((`: until the `))` that closes it (parentheses inside counted).
  const arith = () => {
    let depth = 0;
    while (i < s.length) {
      if (s[i] === ")" && depth === 0) {
        if (s[i + 1] === ")") {
          take(2);
          return;
        }
        unsure("arith");
        take(1);
        return;
      }
      if (s[i] === "(") depth++;
      else if (s[i] === ")") depth--;
      if (s[i] === "\\") take(2);
      else if (s[i] === "'") single();
      else if (s[i] === '"') double();
      else if (expansion(false)) continue;
      else if (isParam()) param("arith");
      else take(1);
    }
    unsure("openArith");
  };
  // `<<` or `<<-` and its delimiter word; the body is read at the end of the line.
  const heredocStart = () => {
    const strip = s[i + 2] === "-";
    take(strip ? 3 : 2);
    while (s[i] === " " || s[i] === "\t") take(1);
    let word = "";
    let quoted = false;
    while (i < s.length && !/[\s;&|<>()]/.test(s[i])) {
      if (s[i] === "'" || s[i] === '"') {
        const q = s[i];
        const j = s.indexOf(q, i + 1);
        if (j < 0) {
          unsure("openQuote");
          take(s.length - i);
          break;
        }
        word += s.slice(i + 1, j);
        quoted = true;
        take(j + 1 - i);
      } else if (s[i] === "\\") {
        word += s[i + 1] || "";
        quoted = true;
        take(2);
      } else {
        word += s[i];
        take(1);
      }
    }
    if (!word) unsure("heredocWord");
    else heredocs.push({ word, strip, quoted });
  };
  const heredocBodies = () => {
    while (heredocs.length > 0) {
      const h = heredocs.shift();
      const start = i;
      let end = -1;
      let after = -1;
      while (i < s.length) {
        const nl = s.indexOf("\n", i);
        const lineEnd = nl < 0 ? s.length : nl;
        const line = s.slice(i, lineEnd);
        const next = nl < 0 ? s.length : nl + 1;
        if ((h.strip ? line.replace(/^\t+/, "") : line) === h.word) {
          end = i;
          after = next;
          break;
        }
        i = next;
      }
      i = start;
      if (end < 0) {
        unsure("openHeredoc");
        take(s.length - i);
        return;
      }
      if (h.quoted) {
        take(end - i);
      } else {
        // like "…" without the closing quote: expansions and parameters, `\` escapes
        while (i < end) {
          if (s[i] === "\\") take(2);
          else if (expansion(true)) continue;
          else if (isParam()) param("dq");
          else take(1);
        }
        if (i > end) unsure("heredoc");
      }
      take(after - i);
    }
  };
  // Commands, until `close` (")" for $(…)) or the end. `(`…`)` inside are counted.
  const command = (close) => {
    let wordStart = true;
    let depth = 0;
    let word = "";
    while (i < s.length) {
      const c = s[i];
      if (close && c === ")" && depth === 0) {
        take(1);
        return;
      }
      const startsWord = wordStart;
      wordStart = false;
      if (c === "\\") take(2);
      else if (c === "'") single();
      else if (s.startsWith("$'", i)) ansiC();
      else if (c === '"') double();
      else if (expansion(false)) continue;
      else if ((c === "<" || c === ">") && s[i + 1] === "(") {
        take(2);
        command(")");
      } else if (startsWord && s.startsWith("((", i)) {
        take(2);
        arith();
      } else if (startsWord && c === "#") {
        while (i < s.length && s[i] !== "\n") take(1);
      } else if (s.startsWith("<<<", i)) {
        take(3);
        wordStart = true;
      } else if (s.startsWith("<<", i)) {
        heredocStart();
        wordStart = true;
      } else if (isParam()) param("word");
      else if (c === "\n") {
        take(1);
        heredocBodies();
        wordStart = true;
      } else {
        if (c === "(") depth++;
        else if (c === ")") depth--;
        take(1);
        wordStart = /[\s;&|()]/.test(c);
      }
      // `case … in a) …` inside $(…): its `)` would end $(…) too early for a simple reader
      if (/[A-Za-z]/.test(c)) word += c;
      else {
        if (close && word === "case") unsure("caseInSubst");
        word = "";
      }
    }
    if (close) unsure("openSubst");
    if (heredocs.length > 0) heredocBodies();
  };

  command(null);
  flush();
  return { pieces, uncertain };
}

// The `:name` parameters the shell would see, in order, without repeats ([] when the template is unsure).
export function paramNames(text) {
  const r = scanShell(text);
  if (r.uncertain) return [];
  const names = [];
  for (const t of r.pieces) if (t.param !== undefined && !names.includes(t.param)) names.push(t.param);
  return names;
}

// Why a template cannot take parameters safely, or null.
export function templateProblem(text) {
  const r = scanShell(text);
  return r.uncertain && MAYBE_PARAM.test(String(text || "")) ? r.uncertain : null;
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

// The variable a parameter's value is kept in while the script runs.
export function paramVar(name) {
  return `OD_P_${name}`;
}

// The script to run: one assignment per parameter at the top (its value quoted: data, never code), then the
// template with each `:name` replaced by an expansion of that variable. bash never reads the result of an
// expansion as code, so a value cannot add a command wherever the parameter stands. In a word or in ${…} the
// expansion is quoted (one word); in "…" and here-documents it already is; in arithmetic only numbers are allowed.
export function renderShell(text, values) {
  const r = scanShell(text);
  const names = [];
  let body = "";
  for (const t of r.pieces) {
    if (t.param === undefined) {
      body += t.raw;
      continue;
    }
    if (!names.includes(t.param)) names.push(t.param);
    const v = `\${${paramVar(t.param)}}`;
    body += t.ctx === "word" || t.ctx === "brace" ? `"${v}"` : v;
  }
  const prelude = names.map((n) => `${paramVar(n)}=${shellQuote(values[n] === null || values[n] === undefined ? "" : values[n])}`);
  return prelude.length > 0 ? `${prelude.join("\n")}\n${body}` : body;
}

// The contexts each parameter appears in.
export function paramContexts(text) {
  const out = {};
  for (const t of scanShell(text).pieces) if (t.param !== undefined) (out[t.param] = out[t.param] || []).push(t.ctx);
  return out;
}

// Each parameter's value: typed on the page, else from the environment. Throws with the first bad one, and for a
// template the scanner cannot read with certainty.
export async function paramValues(ctx, text) {
  const problem = templateProblem(text);
  if (problem) throw new Error(tr(ctx, "error.template", { why: tr(ctx, `template.${problem}`) }));
  const decls = declarations(text);
  const contexts = paramContexts(text);
  const values = {};
  for (const name of paramNames(text)) {
    const typed = ctx.params && ctx.params[name];
    let value = typed !== undefined && typed !== null && typed !== "" ? String(typed) : null;
    if (value === null) {
      const found = await ctx.host.params.get(name);
      if (found && found.found && found.value !== "") value = String(found.value);
    }
    let bad = checkValue(declOf(decls, name), value);
    // bash evaluates `a[$(…)]` in arithmetic (also in [[ … -eq … ]]): such a value never goes in
    if (!bad && value !== null && /\[[^\]]*(\$\(|`)/.test(value)) bad = "unsafe";
    if (!bad && value !== null && (contexts[name] || []).includes("arith") && !/^[+-]?\d+$/.test(value)) bad = "arith";
    if (bad) throw new Error(tr(ctx, `error.param.${bad}`, { name, max: declOf(decls, name).max }));
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
export function linesOutput(ctx, rows, truncated, total) {
  return {
    type: "table",
    columns: [
      { key: "stream", label: tr(ctx, "column.stream") },
      { key: "line", label: tr(ctx, "column.line") },
    ],
    rows,
    total: total !== undefined ? total : rows.length + (truncated ? 1 : 0),
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
  let tail = [];
  let seen = 0;
  let last = 0;
  let shown = 0;
  const show = () => {
    if (!partial || seen === shown) return;
    const now = Date.now();
    if (now - last < PARTIAL_EVERY_MS) return;
    last = now;
    shown = seen;
    // only the last lines: the shell redraws the whole partial output each time
    const rows = tail.slice(-PARTIAL_LINES);
    Promise.resolve(partial(linesOutput(ctx, rows, seen > rows.length, seen))).catch(() => {});
  };
  const res = await ctx.host.process.run({
    ...spec,
    lines: true,
    maxLines,
    onOutput: (line) => {
      seen++;
      tail.push(lineRow(line));
      if (tail.length > 2 * PARTIAL_LINES) tail = tail.slice(-PARTIAL_LINES);
      show();
    },
  });
  const rows = (Array.isArray(res.lines) ? res.lines.map(lineRow) : tail).slice(0, maxLines);
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

// What the page holds (the run's snapshot, then the draft, then the saved body).
export function bodyOf(ctx) {
  const pick = (key, dflt) => {
    if (ctx.run && ctx.run.input && typeof ctx.run.input[`body.${key}`] === "string") return ctx.run.input[`body.${key}`];
    if (ctx.draft && typeof ctx.draft[`body.${key}`] === "string") return ctx.draft[`body.${key}`];
    const b = ctx.resource && ctx.resource.body;
    return b && typeof b[key] === "string" ? b[key] : dflt;
  };
  return { script: pick("script", ""), timeoutSec: pick("timeoutSec", ""), maxLines: pick("maxLines", "") };
}

// What `ctx.host.process.run` gets: bash without the user's startup files, running the script from a file (its
// standard input is empty, so a command that reads stdin cannot eat the script). Cancelling ends the program's
// whole process group (the kernel).
export function bashSpec(file, timeoutS) {
  return { program: "bash", args: ["--noprofile", "--norc", file], timeoutMs: timeoutS * 1000 };
}

let tmpSeq = 0;

// Writes the script into the plugin's own `tmp/` folder, runs it, removes the file whatever happened.
export async function runScriptFile(ctx, script, timeoutS, maxLines) {
  const name = `tmp/run-${Date.now()}-${++tmpSeq}.sh`;
  const written = await ctx.host.files.writeText(name, script.endsWith("\n") ? script : `${script}\n`);
  const file = (written && written.path) || name;
  try {
    return await runLines(ctx, bashSpec(file, timeoutS), maxLines);
  } finally {
    try {
      await ctx.host.files.remove(file);
    } catch (e) {
      // a leftover in the plugin's own tmp/ only
    }
  }
}

// A file name for a script: its name with anything but letters, digits, `.`, `_`, `-` turned into `-`; never
// hidden, never empty; `taken` (lower-case, the Mac's file system ignores case) gets the new name.
export function fileNameFor(name, taken) {
  let base = String(name || "")
    .normalize("NFC")
    .replace(/\.sh$/i, "")
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 100);
  if (!base) base = "script";
  let file = `${base}.sh`;
  for (let n = 2; taken.has(file.toLowerCase()); n++) file = `${base}-${n}.sh`;
  taken.add(file.toLowerCase());
  return file;
}

// The file's text: the script with a bash shebang unless it has its own, ending in a newline.
export function fileText(script) {
  const s = String(script || "");
  const body = s.endsWith("\n") || s === "" ? s : `${s}\n`;
  return s.startsWith("#!") ? body : `#!/usr/bin/env bash\n${body}`;
}

// What to do with a `.sh` that is already in the folder (files.writeText's `conflict`).
export const CONFLICTS = ["overwrite", "skip", "keepBoth"];

async function exists(ctx, path) {
  try {
    await ctx.host.files.stat(path);
    return true;
  } catch (e) {
    if (e && e.code === "notFound") return false;
    throw e;
  }
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

async function grantedFolders(ctx) {
  try {
    const roots = await ctx.host.files.roots();
    return Array.isArray(roots) ? roots : [];
  } catch (e) {
    return [];
  }
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
            id: "limits",
            layout: "strip",
            fields: [
              { name: "timeoutSec", label: ctx.t("field.timeoutSec"), kind: "number", bind: "body.timeoutSec", placeholder: String(DEFAULT_TIMEOUT_S), ...ro },
              { name: "maxLines", label: ctx.t("field.maxLines"), kind: "number", bind: "body.maxLines", placeholder: String(DEFAULT_MAX_LINES), ...ro },
            ],
          },
        ];
        const names = paramNames(b.script);
        if (names.length > 0) {
          const decls = declarations(b.script);
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
        const problem = ctx.run ? null : templateProblem(b.script);
        if (problem) view.push({ type: "text", id: "templateProblem", text: tr(ctx, "error.template", { why: tr(ctx, `template.${problem}`) }), tone: "danger" });
        view.push({
          type: "form",
          id: "editor",
          layout: "stack",
          fields: [{ name: "script", label: ctx.t("field.script"), kind: "code", bind: "body.script", fill: true, language: "shell", placeholder: ctx.t("field.script.placeholder"), ...ro }],
        });
        if (!ctx.run) {
          const roots = await grantedFolders(ctx);
          if (roots.length === 0) {
            view.push({ type: "text", id: "export", text: tr(ctx, "note.noFolder"), tone: "muted" });
          } else {
            const options = roots.map((r) => ({ value: r.path, label: r.name || r.path }));
            const conflicts = CONFLICTS.map((c) => ({ value: c, label: ctx.t(`conflict.${c}`) }));
            view.push({
              type: "form",
              id: "export",
              layout: "strip",
              fields: [
                { name: "exportFolder", label: ctx.t("field.exportFolder"), kind: "enum", param: true, options, hint: tr(ctx, "field.exportFolder.hint") },
                { name: "exportConflict", label: ctx.t("field.exportConflict"), kind: "enum", param: true, options: conflicts, hint: tr(ctx, "field.exportConflict.hint") },
              ],
            });
          }
        }
        return { view };
      },
    });

    host.actions.handle("run", async (ctx, input) => {
      const i = input || {};
      const script = String(i["body.script"] !== undefined ? i["body.script"] : bodyOf(ctx).script);
      if (!script.trim()) throw new Error(tr(ctx, "error.empty"));
      const timeoutS = intIn(i["body.timeoutSec"], 1, MAX_TIMEOUT_S, DEFAULT_TIMEOUT_S);
      if (timeoutS === null) throw new Error(tr(ctx, "error.badTimeout", { max: MAX_TIMEOUT_S }));
      const maxLines = intIn(i["body.maxLines"], 1, MAX_MAX_LINES, DEFAULT_MAX_LINES);
      if (maxLines === null) throw new Error(tr(ctx, "error.badMaxLines", { max: MAX_MAX_LINES }));
      const values = await paramValues(ctx, script);
      ctx.progress(undefined, tr(ctx, "step.running"));
      let r;
      try {
        r = await runScriptFile(ctx, renderShell(script, values), timeoutS, maxLines);
      } catch (err) {
        if (err && err.code === "denied" && err.params && err.params.reason === "cancelled") throw err;
        throw programError(ctx, err);
      }
      return { output: linesOutput(ctx, r.rows, r.truncated || r.timedOut), summary: { rows: r.rows.length, message: endMessage(ctx, r, timeoutS) } };
    });

    // Every saved script as `<name>.sh` in one granted folder (the page's choice; the first one if only one).
    host.actions.handle("exportAll", async (ctx) => {
      const roots = await grantedFolders(ctx);
      if (roots.length === 0) throw new Error(tr(ctx, "error.noFolder"));
      const wanted = String((ctx.params && ctx.params.exportFolder) || "");
      const folder = wanted ? roots.find((r) => r.path === wanted) : roots.length === 1 ? roots[0] : null;
      if (!folder) throw new Error(tr(ctx, wanted ? "error.folderGone" : "error.pickFolder"));
      const list = (await ctx.host.resources.list({ kind: KIND })) || [];
      const scripts = (Array.isArray(list) ? list : list.items || []).slice().sort((a, b) => cmp(String(a.name), String(b.name)) || cmp(String(a.id), String(b.id)));
      if (scripts.length === 0) throw new Error(tr(ctx, "error.nothingToExport"));
      const chosen = String((ctx.params && ctx.params.exportConflict) || "");
      if (chosen && !CONFLICTS.includes(chosen)) throw new Error(tr(ctx, "error.badConflict"));
      const taken = new Set();
      const dir = String(folder.path).replace(/\/+$/, "");
      const plan = scripts.map((s) => ({ s, file: fileNameFor(s.name, taken) }));
      // Without a choice nothing on disk is replaced: files that exist stop the export before anything is written.
      if (!chosen) {
        const existing = [];
        for (const p of plan) if (await exists(ctx, `${dir}/${p.file}`)) existing.push(p.file);
        if (existing.length > 0) throw new Error(tr(ctx, "error.exists", { files: existing.slice(0, 5).join(", ") + (existing.length > 5 ? " …" : "") }));
      }
      const rows = [];
      let written = 0;
      for (let n = 0; n < plan.length; n++) {
        const { s, file } = plan[n];
        ctx.progress(n / plan.length, tr(ctx, "step.exporting", { file }));
        const body = (s.body && typeof s.body.script === "string" && s.body.script) || "";
        // `fail` when nothing was chosen: a file that appeared since the check is not replaced either
        const r = await ctx.host.files.writeText(`${dir}/${file}`, fileText(body), { executable: true, conflict: chosen || "fail" });
        const skipped = !!(r && r.skipped);
        const final = r && typeof r.path === "string" ? r.path.slice(r.path.lastIndexOf("/") + 1) : file;
        if (!skipped) written++;
        rows.push([s.name || "", skipped ? file : final, tr(ctx, skipped ? "result.skipped" : final !== file ? "result.renamed" : "result.written")]);
      }
      return {
        output: {
          type: "table",
          columns: [
            { key: "script", label: tr(ctx, "column.script") },
            { key: "file", label: tr(ctx, "column.file") },
            { key: "result", label: tr(ctx, "column.result") },
          ],
          rows,
          total: rows.length,
        },
        summary: { rows: rows.length, message: tr(ctx, "summary.exported", { n: written, folder: folder.name || folder.path }) },
      };
    });
  },
};
