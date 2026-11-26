// The build page (docs/redesign/book.md §37.2, §37.4) — the program book's colophon: the record of versions, the check,
// trying the plugin out (through the install request the user confirms) and building the signed `.odplugin` (K20).

import { assemble, bodyNow, bookAbove, checkFiles, day, failed, problemText, say, str } from "./common.js";
import { problemsNode } from "./pages.js";

const field = (ctx, name, kind, extra = {}) => ({ name, label: ctx.t(`field.${name}`), kind, bind: `body.${name}`, ...extra });
const history = (b) => (Array.isArray(b.history) ? b.history.filter((h) => h && typeof h === "object") : []);

function manifestOf(files) {
  try {
    const m = JSON.parse(files["manifest.json"] || "");
    return m && typeof m === "object" ? m : null;
  } catch {
    return null;
  }
}

/** Where packages and trial folders go: the folder written on the page, else the first folder granted to this plugin. */
async function outFolder(ctx, b) {
  const own = str(b.out).trim().replace(/\/+$/, "");
  if (own) return own;
  try {
    const roots = await ctx.host.files.roots();
    return roots && roots[0] ? str(roots[0].path).replace(/\/+$/, "") : "";
  } catch {
    return "";
  }
}

export async function renderBuild(ctx) {
  const res = ctx.resource || {};
  const b = bodyNow(ctx);
  const view = [{ type: "form", id: "build", layout: "stack", fields: [field(ctx, "out", "text", { placeholder: ctx.t("field.out.placeholder") }), field(ctx, "notes", "longtext", { placeholder: ctx.t("field.notes.placeholder") })] }];
  const book = res.id ? await bookAbove(ctx, res.id) : null;
  if (!book) return { view: [{ type: "text", id: "alone", text: say(ctx, "page.alone"), tone: "muted" }, ...view] };
  const a = await assemble(ctx, book.id);
  const m = manifestOf(a.files);
  const head = m ? say(ctx, "build.head", { id: str(m.id), version: str(m.version), files: Object.keys(a.files).length }) : say(ctx, "problem.noManifestPage");
  view.unshift({ type: "text", id: "head", text: head, format: "markdown" });
  const lines = a.problems.map((p) => `${p.page}: ${problemText(ctx, p)}`);
  if (a.hasManifest) for (const p of (await checkFiles(ctx, a.files)).problems || []) lines.push(problemText(ctx, p));
  view.push(problemsNode(ctx, lines));
  const h = history(b);
  view.push(
    h.length
      ? {
          type: "table",
          id: "history",
          columns: ["version", "date", "notes", "file"].map((k) => ({ key: k, label: say(ctx, `build.col.${k}`) })),
          rows: h.slice().reverse().map((x) => [str(x.version), str(x.date), str(x.notes), str(x.file)]),
        }
      : { type: "text", id: "history", text: say(ctx, "build.noHistory"), tone: "muted" },
  );
  return { view };
}

/** The book's files when they make a plugin: `{ book, a, m }`, or `{ fail }` (an action's failure). */
async function ready(ctx) {
  const res = ctx.resource;
  const book = res ? await bookAbove(ctx, res.id) : null;
  if (!book) return { fail: failed(ctx, "page.alone") };
  const a = await assemble(ctx, book.id);
  if (!a.hasManifest) return { fail: failed(ctx, "problem.noManifestPage") };
  const lines = a.problems.map((p) => `${p.page}: ${problemText(ctx, p)}`);
  for (const p of (await checkFiles(ctx, a.files)).problems || []) lines.push(problemText(ctx, p));
  if (lines.length) {
    const text = `${say(ctx, "check.problems", { n: lines.length })}\n${lines.map((l) => `- ${l}`).join("\n")}`;
    return { fail: { output: { type: "text", text }, failed: { message: say(ctx, "check.problems", { n: lines.length }) } } };
  }
  return { book, a, m: manifestOf(a.files) };
}

/** “Check”: the same check installing does, and the book's own. */
export async function checkAction(ctx) {
  const r = await ready(ctx);
  if (r.fail) return r.fail;
  return { output: { type: "text", text: say(ctx, "check.ok") }, summary: { message: say(ctx, "check.ok") } };
}

/** “Try it out”: the files written to a folder (`<id>-<version>-dev.<n>`), then the install request the user confirms. */
export async function tryAction(ctx) {
  const r = await ready(ctx);
  if (r.fail) return r.fail;
  const res = ctx.resource;
  const b = res.body || {};
  const out = await outFolder(ctx, b);
  if (!out) return failed(ctx, "build.noFolder");
  const n = (Number.isInteger(b.devCount) ? b.devCount : 0) + 1;
  const version = str(r.m.version).includes("-") ? `${r.m.version}.dev.${n}` : `${r.m.version}-dev.${n}`;
  const folder = `${out}/${r.m.id}-${version}`;
  const files = Object.assign({}, r.a.files, { "manifest.json": JSON.stringify(Object.assign({}, r.m, { version }), null, 2) + "\n" });
  // Each folder once; one left by an attempt that did not finish is used as it is.
  const made = new Set();
  const dir = async (d) => {
    if (made.has(d)) return;
    made.add(d);
    try {
      await ctx.host.files.mkdir(d, { recursive: true });
    } catch (e) {
      if (!(e && e.code === "conflict")) throw e;
    }
  };
  await dir(folder);
  for (const [p, text] of Object.entries(files)) {
    const i = p.lastIndexOf("/");
    if (i > 0) await dir(`${folder}/${p.slice(0, i)}`);
    await ctx.host.files.writeText(`${folder}/${p}`, text);
  }
  await ctx.host.resources.update(res.id, { "body.devCount": n });
  const answer = await ctx.host.plugins.requestInstall({ folder, source: say(ctx, "build.source", { book: r.book.name }) });
  const outcome = str(answer && answer.outcome);
  if (outcome === "installed") {
    const text = say(ctx, "build.installed", { id: str(r.m.id), version });
    return { output: { type: "text", text }, summary: { message: text } };
  }
  return failed(ctx, `build.install.${["declined", "expired"].includes(outcome) ? outcome : "failed"}`, { reason: str(answer && answer.reason) });
}

/** “Build…”: the signed `.odplugin` (K20), recorded in the history. One build per version. */
export async function buildAction(ctx) {
  const r = await ready(ctx);
  if (r.fail) return r.fail;
  const res = ctx.resource;
  const b = res.body || {};
  const h = history(b);
  const version = str(r.m.version);
  if (h.some((x) => str(x.version) === version)) return failed(ctx, "build.sameVersion", { version });
  const out = await outFolder(ctx, b);
  if (!out) return failed(ctx, "build.noFolder");
  let built;
  try {
    built = await ctx.host.plugins.build(r.a.files, { path: `${out}/${r.m.id}-${version}.odplugin` });
  } catch (e) {
    if (e && e.params && e.params.reason === "noIdentity") return failed(ctx, "build.noIdentity");
    return failed(ctx, "build.failed", { reason: str(e && ((e.params && e.params.reason) || e.message)) });
  }
  h.push({ version, date: day(Date.now()), notes: str(b.notes).trim(), file: built.path });
  await ctx.host.resources.update(res.id, { "body.history": h, "body.notes": "" });
  const text = say(ctx, "build.done", { path: built.path, bytes: built.bytes });
  return { output: { type: "text", text }, summary: { message: text } };
}
