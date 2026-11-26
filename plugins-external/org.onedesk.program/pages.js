// The pages of a program book (docs/redesign/book.md §37.2): the manifest page, code pages, language pages and test pages
// — how each looks, what it says is wrong with it, and how it reads in the book (literate programming: the explanation
// first, then the code).

import { assemble, bodyNow, bookAbove, checkFiles, goodPath, localeObject, localePath, problemText, say, str } from "./common.js";
import { resultsOutput, runTests } from "./runner.js";

const field = (ctx, name, kind, extra = {}) => ({ name, label: ctx.t(`field.${name}`), kind, bind: `body.${name}`, ...extra });
const alone = (ctx) => ({ type: "text", id: "alone", text: say(ctx, "page.alone"), tone: "muted" });
const block = (language, code) => "```" + language + "\n" + str(code).replace(/\n+$/, "") + "\n```";

/** The book's files with this page as typed, and what is wrong with them: `{ book, a, problems }` (problems in words). */
async function bookState(ctx) {
  const res = ctx.resource || {};
  const book = res.id ? await bookAbove(ctx, res.id) : null;
  if (!book) return { book: null };
  const a = await assemble(ctx, book.id, { id: res.id, body: bodyNow(ctx) });
  return { book, a };
}

/** The kernel's check (K20) and the book's own problems, as lines; `[]` when all is well. */
async function problemLines(ctx, a) {
  const lines = a.problems.map((p) => `${p.page}: ${problemText(ctx, p)}`);
  if (!a.hasManifest) return lines.concat([say(ctx, "problem.noManifestPage")]);
  const c = await checkFiles(ctx, a.files);
  for (const p of c.problems || []) lines.push(problemText(ctx, p));
  return lines;
}

export function problemsNode(ctx, lines) {
  return lines.length === 0
    ? { type: "text", id: "check", text: say(ctx, "check.ok"), tone: "muted" }
    : { type: "text", id: "check", text: `${say(ctx, "check.problems", { n: lines.length })}\n\n${lines.map((l) => `- ${l}`).join("\n")}`, format: "markdown", tone: "danger" };
}

// ——— manifest page ———

export async function renderManifest(ctx) {
  const view = [{ type: "form", id: "manifest", layout: "stack", fields: [field(ctx, "text", "code", { language: "json" })] }];
  const s = await bookState(ctx);
  if (!s.book) return { view: [alone(ctx), ...view] };
  const lines = [];
  try {
    JSON.parse(str(bodyNow(ctx).text));
  } catch (e) {
    lines.push(say(ctx, "manifest.badJson", { message: String((e && e.message) || e) }));
  }
  view.push(problemsNode(ctx, lines.length ? lines : await problemLines(ctx, s.a)));
  return { view };
}

export const embedManifest = (ctx) => ({ view: [{ type: "text", id: "embed", text: `**manifest.json**\n\n${block("json", ctx.resource && ctx.resource.body && ctx.resource.body.text)}`, format: "markdown" }] });

/** What the book's conventions say of a program book (asked of the manifest page). */
export function manifestConventions(ctx) {
  const r = ctx.resource;
  if (!r || !String(r.kind).endsWith(":manifest")) return { lines: [] };
  let m = {};
  try {
    m = JSON.parse(str(r.body && r.body.text));
  } catch {
    m = {};
  }
  const lines = [];
  if (m.id) lines.push(say(ctx, "conv.plugin", { id: str(m.id), version: str(m.version) }));
  lines.push(say(ctx, "conv.language"), say(ctx, "conv.files"), say(ctx, "conv.tests"));
  return { lines };
}

// ——— code page ———

export async function renderCode(ctx) {
  const b = bodyNow(ctx);
  const view = [
    {
      type: "form",
      id: "code",
      layout: "stack",
      fields: [field(ctx, "path", "text", { placeholder: ctx.t("field.path.placeholder") }), field(ctx, "explain", "longtext"), field(ctx, "code", "code", { language: "javascript" })],
    },
  ];
  const path = str(b.path).trim();
  const lines = [];
  if (!path) lines.push(say(ctx, "code.noPath"));
  else if (!goodPath(path) || !path.endsWith(".js")) lines.push(say(ctx, "code.badPath"));
  else {
    const s = await bookState(ctx);
    if (!s.book) return { view: [alone(ctx), ...view] };
    const mine = s.a.problems.filter((p) => p.file === path && p.code === "samePath");
    if (mine.length) lines.push(say(ctx, "code.samePath", { path }));
  }
  if (lines.length) view.unshift({ type: "text", id: "problem", text: lines.join("\n"), tone: "danger" });
  return { view };
}

/** In the book: the explanation, then the code under its file name (the reader's view of literate programming). */
export function embedCode(ctx) {
  const b = (ctx.resource && ctx.resource.body) || {};
  const parts = [];
  if (str(b.explain).trim()) parts.push(str(b.explain).trim());
  parts.push(`**${str(b.path) || say(ctx, "code.unnamed")}**`, block("javascript", b.code));
  return { view: [{ type: "text", id: "embed", text: parts.join("\n\n"), format: "markdown" }] };
}

// ——— language page ———

export async function renderLocale(ctx) {
  const b = bodyNow(ctx);
  const view = [
    {
      type: "form",
      id: "locale",
      layout: "stack",
      fields: [
        field(ctx, "language", "text", { placeholder: "zh-CN" }),
        field(ctx, "texts", "rows", { columns: [{ name: "key", label: ctx.t("col.key"), kind: "text" }, { name: "text", label: ctx.t("col.text"), kind: "text" }] }),
      ],
    },
  ];
  const s = await bookState(ctx);
  if (!s.book) return { view: [alone(ctx), ...view] };
  // Keys the other languages have and this one has not.
  const mine = localeObject(b.texts);
  const missing = new Set();
  for (const [p, text] of Object.entries(s.a.files)) {
    if (!p.startsWith("locales/") || p === localePath(b.language)) continue;
    try {
      for (const k of Object.keys(JSON.parse(text))) if (!(k in mine)) missing.add(k);
    } catch {
      // not ours to judge here
    }
  }
  view.push(missing.size ? { type: "text", id: "missing", text: say(ctx, "locale.missing", { keys: [...missing].sort().join(", ") }), tone: "danger" } : { type: "text", id: "missing", text: say(ctx, "locale.complete", { n: Object.keys(mine).length }), tone: "muted" });
  return { view };
}

export function embedLocale(ctx) {
  const b = (ctx.resource && ctx.resource.body) || {};
  const o = localeObject(b.texts);
  const keys = Object.keys(o).slice(0, 300);
  const cell = (s) => str(s).replace(/\|/g, "\\|").replace(/\n/g, " ");
  const table = keys.length ? `\n\n| ${say(ctx, "col.key")} | ${say(ctx, "col.text")} |\n|---|---|\n${keys.map((k) => `| \`${cell(k)}\` | ${cell(o[k])} |`).join("\n")}` : "";
  return { view: [{ type: "text", id: "embed", text: `**${localePath(b.language)}**${table}`, format: "markdown" }] };
}

// ——— test page ———

export function renderTest(ctx) {
  return {
    view: [
      { type: "form", id: "test", layout: "stack", fields: [field(ctx, "explain", "longtext"), field(ctx, "code", "code", { language: "javascript" })] },
      { type: "text", id: "how", text: say(ctx, "test.how"), tone: "muted" },
    ],
  };
}

export function embedTest(ctx) {
  const b = (ctx.resource && ctx.resource.body) || {};
  const parts = [];
  if (str(b.explain).trim()) parts.push(str(b.explain).trim());
  parts.push(block("javascript", b.code));
  return { view: [{ type: "text", id: "embed", text: parts.join("\n\n"), format: "markdown" }] };
}

/** “Run”: this page's tests against the book's files, in the empty sandbox. */
export async function testAction(ctx) {
  const res = ctx.resource;
  const book = res ? await bookAbove(ctx, res.id) : null;
  if (!book) return { output: { type: "text", text: say(ctx, "page.alone") }, failed: { message: say(ctx, "page.alone") } };
  const a = await assemble(ctx, book.id);
  const mine = a.tests.filter((t) => t.id === res.id);
  return resultsOutput(ctx, await runTests(ctx, a.files, mine.length ? mine : [{ id: res.id, name: res.name, code: str(res.body && res.body.code) }], a.sources));
}
