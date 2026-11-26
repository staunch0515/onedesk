/**
 * D487 §21 (docs/redesign/book.md) against the REAL kernel, two workspaces (two devhosts): a teacher writes a textbook,
 * publishes it from its colophon (student's and teacher's editions); a student imports the student's edition as a
 * read-only copy; a practice is marked on the spot, a test whose answers the teacher releases waits; nothing of the
 * answers is in the student's database; the teacher changes a question and releases the test's answers from the
 * answers appendix; the student's update marks the waiting attempt; one's own package is refused.
 * Screenshots (not checked in): test-results/screenshots/publish-*.png.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { DEVHOST, OUT, openKernel, rpc, startHost, stopHost, type Host } from "./kernel-host";

test.use({ viewport: { width: 1440, height: 900 }, locale: "en-US" });
test.describe.configure({ mode: "serial" });
test.setTimeout(240_000);

let teacher: Host;
let student: Host;
let base: string;
let out: string;

test.beforeAll(async () => {
  test.skip(!existsSync(DEVHOST), `onedesk-devhost not built at ${DEVHOST}`);
  base = realpathSync(mkdtempSync(path.join(tmpdir(), "od-publish-")));
  teacher = await startHost(path.join(base, "teacher"));
  student = await startHost(path.join(base, "student"));
  out = path.join(base, "out");
  mkdirSync(out, { recursive: true });
});
test.afterAll(async () => {
  if (teacher) await stopHost(teacher);
  if (student) await stopHost(student);
  if (base) rmSync(base, { recursive: true, force: true });
});

const B = "org.onedesk.book";
const X = "org.onedesk.exercise";
type Node = { key: string; label: string };
const shot = (page: Page, name: string) => page.screenshot({ path: path.join(OUT, `publish-${name}.png`) });
const action = (page: Page, name: string) => page.locator(".od-titlebar__actions").getByRole("button", { name, exact: true });

async function make(page: Page, h: Host, kind: string, parent: string | null, changes: Record<string, unknown>): Promise<string> {
  const target = parent ? `new:${kind}?parent=${parent}` : `new:${kind}`;
  const r = await rpc<{ page: { resourceId: string } }>(page, h, "page.save", { target, changes });
  return r.page.resourceId;
}
const kids = async (page: Page, h: Host, parent: string) => (await rpc<{ nodes: Node[] }>(page, h, "tree.children", { tree: "resources", parent })).nodes;
const packages = () => readdirSync(out).filter((f) => f.endsWith(".odpack")).sort();

/** Every byte the student's workspace keeps on disk (database, its journal, archives). */
function allBytes(dir: string): string {
  let s = "";
  for (const n of readdirSync(dir)) {
    const p = path.join(dir, n);
    const st = statSync(p);
    if (st.isDirectory()) s += allBytes(p);
    else if (st.size < 64 * 1024 * 1024) s += readFileSync(p).toString("latin1");
  }
  return s;
}

let book = "";
let practiceQ = "";
let quiz = "";
let answers = "";

test("the teacher writes a textbook and publishes it from its colophon", async ({ page }) => {
  await openKernel(page, teacher);
  // D487 §33: what is published is signed by the publisher's identity.
  await rpc(page, teacher, "identity.create", { name: "Teacher" });
  await rpc(page, teacher, "plugin.grantFolder", { plugin: B, path: out });
  book = await make(page, teacher, `${B}:book`, null, { name: "Science" });
  await expect.poll(async () => (await kids(page, teacher, book)).length).toBe(2);
  const practice = await make(page, teacher, `${X}:practice`, book, { name: "Warm-up" });
  practiceQ = await make(page, teacher, `${X}:question`, practice, { name: "Lightest", "body.type": "fill", "body.stem": "The lightest element is {{?}}.", "body.answers": "Hydrogen", "body.rule": "text" });
  quiz = await make(page, teacher, `${X}:test`, book, { name: "Quiz" });
  await make(page, teacher, `${X}:question`, quiz, { name: "Times", "body.type": "fill", "body.stem": "7 × 8 = {{?}}", "body.answers": "56", "body.rule": "number", "body.points": 2 });
  const check = await make(page, teacher, `${X}:test`, book, { name: "Check", "body.timing": "submit" });
  await make(page, teacher, `${X}:question`, check, { name: "Sum", "body.type": "fill", "body.stem": "2 + 2 = {{?}}", "body.answers": "4", "body.rule": "number" });
  answers = await make(page, teacher, `${X}:answers`, book, { name: "Answers" });
  await make(page, teacher, `${B}:colophon`, book, { name: "Colophon", "body.publisher": "Science group" });

  // The answers appendix (teacher's) lists the answers in the book's order.
  await page.reload();
  await page.getByRole("button", { name: "Expand all" }).first().click();
  await page.getByRole("treeitem", { name: "Answers", exact: true }).click();
  await expect(page.getByText("1. （1）Hydrogen", { exact: false })).toBeVisible({ timeout: 15_000 });

  // Publish: edition 1, a student's and a teacher's file.
  await page.getByRole("treeitem", { name: "Colophon", exact: true }).click();
  await expect(page.getByText("Not published yet.", { exact: false })).toBeVisible({ timeout: 15_000 });
  await action(page, "Publish new edition").click();
  await expect.poll(() => packages().length, { timeout: 30_000 }).toBe(2);
  expect(packages()).toEqual(["Science-1.1-student.odpack", "Science-1.1-teacher.odpack"]);
  await page.getByRole("treeitem", { name: "Colophon", exact: true }).click();
  await expect(page.getByText("Now: edition 1, printing 1")).toBeVisible({ timeout: 15_000 });
  await shot(page, "colophon");

  // One's own package is refused.
  await page.getByRole("button", { name: "Settings" }).first().click();
  await page.getByRole("menuitem", { name: "Import resource package…" }).click();
  await page.getByRole("textbox", { name: "Package file" }).fill(path.join(out, "Science-1.1-student.odpack"));
  await page.getByRole("button", { name: "Look inside" }).click();
  await expect(page.getByText("It was published from this workspace.")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Import", exact: true })).toBeDisabled();
});

test("the student imports a read-only copy; a practice is marked on the spot; the quiz waits; no answer on disk", async ({ page }) => {
  await openKernel(page, student);
  await page.getByRole("button", { name: "Settings" }).first().click();
  await page.getByRole("menuitem", { name: "Import resource package…" }).click();
  await page.getByRole("textbox", { name: "Package file" }).fill(path.join(out, "Science-1.1-student.odpack"));
  await page.getByRole("button", { name: "Look inside" }).click();
  await expect(page.getByText("Edition 1, printing 1")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Student's edition")).toBeVisible();
  await shot(page, "import");
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await expect(page.getByRole("treeitem", { name: /Science/ })).toBeVisible({ timeout: 15_000 });
  // Read-only, and without the teacher's pages.
  const top = (await kids(page, student, book)).map((n) => n.label);
  expect(top).not.toContain("Answers");
  expect(top).toEqual(expect.arrayContaining(["Warm-up", "Quiz", "Check", "Colophon"]));
  const e = await rpc(page, student, "page.save", { target: `resource:${practiceQ}`, changes: { name: "Mine" } }).catch((x: Error) => x.message);
  expect(String(e)).toContain("readOnlyCopy");

  // Reading: the practice is checked at once, its answer shown.
  await page.getByRole("button", { name: "Expand all" }).first().click();
  await page.getByRole("treeitem", { name: /^Science/ }).click();
  await page.getByRole("button", { name: /reading/ }).click();
  const nav = page.getByRole("navigation", { name: "Contents" });
  await nav.getByRole("button", { name: /Warm-up/ }).click();
  const region = page.getByRole("region", { name: /Warm-up/ });
  await region.getByRole("textbox", { name: "（1）" }).fill("Helium");
  await region.getByRole("button", { name: "Check", exact: true }).click();
  await expect(region).toContainText("Answer: （1）Hydrogen", { timeout: 15_000 });
  await shot(page, "practice");

  // The quiz (answers released by the teacher): handed in, waiting.
  await nav.getByRole("button", { name: /Quiz/ }).click();
  await page.getByRole("region", { name: /Quiz/ }).getByRole("button", { name: "Start", exact: true }).click();
  await expect(page.getByText("No time limit")).toBeVisible({ timeout: 15_000 });
  await page.getByRole("textbox", { name: "（1）" }).fill("56");
  await expect(action(page, "Save")).toBeEnabled();
  await action(page, "Hand in").click();
  await expect(page.getByText("waiting for the teacher to release the answers")).toBeVisible({ timeout: 15_000 });
  await shot(page, "awaiting");

  // Nothing of the practice's answer is on the student's disk (fingerprints only; the text is in the keychain).
  expect(allBytes(student.dataDir).includes("Hydrogen")).toBe(false);
});

test("the teacher releases the quiz's answers; the student's update marks the waiting attempt", async ({ page }) => {
  await openKernel(page, teacher);
  await rpc(page, teacher, "page.save", { target: `resource:${practiceQ}`, changes: { "body.stem": "The lightest element of all is {{?}}." } });
  await rpc(page, teacher, "page.save", { target: `resource:${answers}`, changes: { "body.release": quiz } });
  await page.getByRole("button", { name: "Expand all" }).first().click();
  await page.getByRole("treeitem", { name: "Answers", exact: true }).click();
  await action(page, "Release").click();
  await expect.poll(() => packages().length, { timeout: 30_000 }).toBe(3);
  expect(packages()).toContain("Science-1.2-student.odpack");

  await openKernel(page, student);
  await page.getByRole("button", { name: "Settings" }).first().click();
  await page.getByRole("menuitem", { name: "Import resource package…" }).click();
  await page.getByRole("textbox", { name: "Package file" }).fill(path.join(out, "Science-1.2-student.odpack"));
  await page.getByRole("button", { name: "Look inside" }).click();
  await expect(page.getByText("Here now: edition 1, printing 1")).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Update", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 15_000 });
  // The waiting attempt is marked (best and last score 2 of 2).
  await page.getByRole("button", { name: "Learning records" }).first().click();
  await page.getByRole("treeitem", { name: "Grades", exact: true }).click();
  await expect(page.getByRole("row", { name: /Quiz 1 2 2 2/ })).toBeVisible({ timeout: 30_000 });
  await shot(page, "released");
  // A reprint prints the edition as it was kept: the stem changed since comes with the next edition.
  const q = await rpc<{ body: Record<string, string> }>(page, student, "resource.get", { id: practiceQ });
  expect(q.body.stem).toBe("The lightest element is {{?}}.");
  // The student's own records are still there.
  const records = await rpc<{ nodes: Node[] }>(page, student, "tree.children", { tree: `${X}:records` });
  expect(records.nodes.map((n) => n.label)).toEqual(expect.arrayContaining(["Grades", "Mistake book"]));
});
