// Running a program book's tests (docs/redesign/book.md §37.3): the book's files, the harness and the test pages go to
// the kernel's empty sandbox (K21); nothing there can reach the workspace. One run, results by test page.

import { HARNESS } from "./harness.js";
import { say, str } from "./common.js";

const isJs = (p) => p.endsWith(".js");

/** The files and the entry for a run of `tests` (`[{ name, code }]`) against the book's `files`. */
export function sandboxFiles(files, tests) {
  const out = { "__harness.js": HARNESS };
  const json = {};
  const mods = [];
  for (const [p, text] of Object.entries(files)) {
    if (isJs(p)) {
      out[p] = text;
      mods.push(p);
    } else if (p.endsWith(".json")) {
      try {
        json[p] = JSON.parse(text);
      } catch {
        // A broken JSON file is the check's business; `load` says there is no such file.
      }
    }
  }
  // Each test page is a module; the first line says which page it is (on the same line: line numbers stay the page's).
  const testPaths = tests.map((_, i) => `tests/t${i}.js`);
  tests.forEach((t, i) => {
    out[testPaths[i]] = `import { __page as __p } from "./__harness.js"; __p(${i}); ${t.code}`;
  });
  const lines = ['import { __run } from "./__harness.js";'];
  mods.forEach((p, i) => lines.push(`import * as m${i} from "./${p}";`));
  for (const p of testPaths) lines.push(`import "./${p}";`);
  lines.push(`const MODULES = { ${mods.map((p, i) => `${JSON.stringify(p)}: m${i}`).join(", ")} };`);
  lines.push(`const JSONS = ${JSON.stringify(json)};`);
  lines.push("export async function run() { return await __run(MODULES, JSONS); }");
  out["__entry.js"] = lines.join("\n");
  return { files: out, testPaths };
}

/**
 * Runs the tests: `{ results: [{ page, pageId, name, ok, expected?, actual?, message?, file?, line?, ms }], error? }`.
 * `error` is a failure before any test ran (a file that does not load), with the page it came from.
 */
export async function runTests(ctx, files, tests, sources) {
  const { files: all, testPaths } = sandboxFiles(files, tests);
  let r;
  try {
    r = await ctx.host.code.run({ files: all, entry: "__entry.js", call: "run", input: null });
  } catch (e) {
    return { results: [], error: { message: String((e && e.message) || e) } };
  }
  const pageOf = (file) => {
    const i = testPaths.indexOf(file);
    if (i >= 0) return tests[i].name;
    const n = sources && sources[file];
    return n ? n.name : file || "";
  };
  if (!r || !r.ok) {
    const e = (r && r.error) || { message: "?" };
    return { results: [], error: { message: str(e.message), page: pageOf(e.file), line: e.line } };
  }
  const results = ((r.value && r.value.tests) || []).map((t) => {
    const x = { page: tests[t.page] ? tests[t.page].name : "", pageId: tests[t.page] ? tests[t.page].id : null, name: t.name, ok: !!t.ok, ms: Number(t.ms) || 0 };
    for (const k of ["expected", "actual", "message", "line"]) if (t[k] !== undefined) x[k] = t[k];
    if (t.file) x.where = pageOf(t.file);
    return x;
  });
  return { results };
}

/** The results as an output table (and a one-line summary). */
export function resultsOutput(ctx, run) {
  if (run.error) {
    const text = say(ctx, "test.loadFailed", { message: run.error.message, where: [run.error.page, run.error.line].filter((x) => x !== undefined && x !== "").join(":") });
    return { output: { type: "text", text }, failed: { message: text } };
  }
  const columns = ["test", "result", "expected", "actual", "ms"].map((k) => ({ key: k, label: say(ctx, `test.col.${k}`) }));
  const rows = run.results.map((t) => [
    t.name,
    t.ok ? say(ctx, "test.pass") : say(ctx, "test.fail") + (t.expected === undefined ? `: ${t.message}` : "") + (t.where ? ` (${t.where}${t.line ? `:${t.line}` : ""})` : ""),
    t.expected === undefined ? "" : str(t.expected),
    t.actual === undefined ? "" : str(t.actual),
    String(t.ms),
  ]);
  const failedN = run.results.filter((t) => !t.ok).length;
  const message = run.results.length === 0 ? say(ctx, "test.none") : failedN ? say(ctx, "test.someFailed", { failed: failedN, total: run.results.length }) : say(ctx, "test.allPassed", { total: run.results.length });
  // Failing tests are what a run of tests reports, not a failed run.
  return { output: { type: "table", columns, rows, total: rows.length }, summary: { message } };
}
