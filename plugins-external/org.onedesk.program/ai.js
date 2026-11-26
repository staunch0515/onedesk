// What an AI can do with a program book (docs/redesign/book.md §37.5): run its tests (`program_test`, read-only — the
// tests run in the kernel's empty sandbox). Reading the pages and proposing changes are the book's and the kernel's tools.

import { assemble, bookAbove, say, str } from "./common.js";
import { runTests } from "./runner.js";

const MAX_TEXT = 60000;

export async function aiTest(ctx, input) {
  const id = input && typeof input.book === "string" ? input.book : "";
  const book = id ? await bookAbove(ctx, id, true) : null;
  if (!book) throw new Error(say(ctx, "ai.notABook"));
  const a = await assemble(ctx, book.id);
  if (!a.hasManifest) throw new Error(say(ctx, "ai.notAProgram"));
  const run = await runTests(ctx, a.files, a.tests, a.sources);
  const data = run.error
    ? { loaded: false, error: run.error }
    : { loaded: true, passed: run.results.filter((t) => t.ok).length, failed: run.results.filter((t) => !t.ok).length, tests: run.results.map(({ pageId, ...t }) => ({ ...t, page: str(t.page) })) };
  return { output: { type: "text", text: JSON.stringify(data, null, 1).slice(0, MAX_TEXT) } };
}
