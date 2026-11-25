/**
 * D487 §19 (docs/redesign/book.md) against the REAL kernel and the real book, exercise and formula plugins: a textbook
 * with its own contents; quick writing makes questions; a practice is answered right in the book and checked at once;
 * a test is a card in the book, answered on its attempt page, handed in, marked (the teacher marks an open answer); the
 * learning records get grades and a mistake book; a mistake done again leaves the book; a formula is tried in place.
 * Screenshots (not checked in): test-results/screenshots/exercise-*.png.
 */
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { DEVHOST, OUT, openKernel, rpc, startHost, stopHost, type Host } from "./kernel-host";

test.use({ viewport: { width: 1440, height: 900 }, locale: "en-US" });
test.describe.configure({ mode: "serial" });
test.setTimeout(180_000);

let host: Host;
let base: string;

test.beforeAll(async () => {
  test.skip(!existsSync(DEVHOST), `onedesk-devhost not built at ${DEVHOST}`);
  base = realpathSync(mkdtempSync(path.join(tmpdir(), "od-exercise-")));
  host = await startHost(path.join(base, "data"));
});
test.afterAll(async () => {
  if (host) await stopHost(host);
  if (base) rmSync(base, { recursive: true, force: true });
});

const B = "org.onedesk.book";
const X = "org.onedesk.exercise";
const call = <T = unknown>(page: Page, method: string, params: unknown = null) => rpc<T>(page, host, method, params);
type Node = { key: string; label: string };
const kids = async (page: Page, parent?: string, tree = "resources") => (await call<{ nodes: Node[] }>(page, "tree.children", { tree, parent })).nodes;
const shot = (page: Page, name: string) => page.screenshot({ path: path.join(OUT, `exercise-${name}.png`) });
const action = (page: Page, name: string) => page.locator(".od-titlebar__actions").getByRole("button", { name, exact: true });

async function make(page: Page, kind: string, parent: string | null, changes: Record<string, unknown>): Promise<string> {
  const target = parent ? `new:${kind}?parent=${parent}` : `new:${kind}`;
  const r = await call<{ page: { resourceId: string } }>(page, "page.save", { target, changes });
  return r.page.resourceId;
}

let book = "";
let practice = "";

test("a textbook: quick writing makes questions; a practice is answered in the book and checked at once", async ({ page }) => {
  await openKernel(page, host);
  book = await make(page, `${B}:book`, null, { name: "Math 3" });
  await expect.poll(async () => (await kids(page, book)).length).toBe(2);
  // The textbook contents takes the place of the contents.
  const toc = (await kids(page, book)).find((n) => n.label === "Contents")!.key;
  await call(page, "resource.delete", { id: toc });
  await make(page, `${X}:lessons`, book, { name: "Lessons" });
  practice = await make(page, `${X}:practice`, book, { name: "Try it" });
  // Quick writing on the practice page.
  await page.reload();
  await page.getByRole("button", { name: "Expand all" }).first().click();
  await page.getByRole("treeitem", { name: "Try it", exact: true }).click();
  await page.getByRole("textbox", { name: "Questions", exact: true }).fill("3 + 5 = (8)\n7 × (8) = 56\n38 (<) 83");
  await action(page, "Generate").click();
  await expect.poll(async () => (await kids(page, practice)).length, { timeout: 15_000 }).toBe(3);

  // Read the book: answer in place, check.
  await page.getByRole("treeitem", { name: "Math 3", exact: true }).click();
  await page.getByRole("button", { name: "Start reading" }).click();
  const nav = page.getByRole("navigation", { name: "Contents" });
  await expect(nav.getByRole("button", { name: /Chapter 1 Try it/ })).toBeVisible({ timeout: 15_000 });
  const region = page.getByRole("region", { name: /Chapter 1 Try it/ });
  const boxes = region.getByRole("textbox", { name: "（1）" });
  await expect(boxes).toHaveCount(3, { timeout: 15_000 });
  await boxes.nth(0).fill("8");
  await boxes.nth(1).fill("9");
  await boxes.nth(2).fill("＜");
  await region.getByRole("button", { name: "Check", exact: true }).click();
  await expect(region).toContainText("Answer: （1）8", { timeout: 15_000 });
  await expect(region).toContainText("✗ Wrong");
  await shot(page, "practice");
  await boxes.nth(1).fill("8");
  await region.getByRole("button", { name: "Check", exact: true }).click();
  await expect(region).not.toContainText("✗", { timeout: 15_000 });
  // The contents shows the progress.
  await page.reload();
  await page.getByRole("button", { name: "Expand all" }).first().click();
  await page.getByRole("treeitem", { name: "Lessons", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "Contents" }).getByRole("button", { name: "Chapter 1 Try it · ✓ all right" })).toBeVisible({ timeout: 15_000 });
});

test("a test: a card in the book; answered on its attempt page, handed in, marked; the teacher marks an open answer", async ({ page }) => {
  await openKernel(page, host);
  const unit = await make(page, `${X}:test`, book, { name: "Unit test", "body.limit": 10 });
  await make(page, `${X}:question`, unit, { name: "Why", "body.type": "free", "body.stem": "Why is 3 + 5 = 8?", "body.points": 2 });
  // A question from the practice joins the test by reference (it stays where it is).
  const q = (await kids(page, practice)).find((n) => n.label.startsWith("7 ×"))!.key;
  await call(page, "page.event", { target: `resource:${unit}`, event: "refer", context: { params: { pick: q } } });
  expect((await kids(page, practice)).map((n) => n.key)).toContain(q);
  await page.reload();
  await page.getByRole("button", { name: "Expand all" }).first().click();
  await page.getByRole("treeitem", { name: "Lessons", exact: true }).click();
  const nav = page.getByRole("navigation", { name: "Contents" });
  await nav.getByRole("button", { name: /Chapter 2 Unit test/ }).click();
  const card = page.getByRole("region", { name: /Chapter 2 Unit test/ });
  await expect(card).toContainText("2 questions · 3 points", { timeout: 15_000 });
  await card.getByRole("button", { name: "Start", exact: true }).click();
  // The attempt opens in a tab of its own.
  await expect(page.getByText("10 minutes left")).toBeVisible({ timeout: 15_000 });
  await page.getByRole("textbox", { name: "Answer", exact: true }).fill("Because three and five make eight.");
  await page.getByRole("textbox", { name: "（1）" }).fill("7");
  await action(page, "Hand in").click();
  await expect(page.getByText("Handed in: 0 of 3")).toBeVisible({ timeout: 15_000 });
  await shot(page, "attempt");
  await page.getByRole("row", { name: /Why is 3 \+ 5/ }).getByRole("button", { name: "Right" }).click();
  await expect(page.getByText("Handed in: 2 of 3")).toBeVisible({ timeout: 15_000 });
});

test("learning records: grades and a mistake book; a mistake done again leaves it; a formula is tried in the book", async ({ page }) => {
  await openKernel(page, host);
  const records = await kids(page, undefined, `${X}:records`);
  expect(records.map((n) => n.label)).toEqual(expect.arrayContaining(["Grades", "Mistake book", "Math 3"]));
  await page.getByRole("button", { name: "Learning records" }).first().click();
  await page.getByRole("treeitem", { name: "Grades", exact: true }).click();
  await expect(page.getByRole("row", { name: /Unit test/ })).toBeVisible({ timeout: 15_000 });
  await page.getByRole("treeitem", { name: "Mistake book", exact: true }).click();
  await expect(page.getByRole("row", { name: /7 ×/ })).toBeVisible({ timeout: 15_000 });
  await shot(page, "mistakes");
  await action(page, "Once more").click();
  await page.getByRole("textbox", { name: "（1）" }).fill("8");
  await action(page, "Hand in").click();
  await expect(page.getByText("Handed in: 1 of 1")).toBeVisible({ timeout: 15_000 });
  await page.getByRole("treeitem", { name: "Mistake book", exact: true }).click();
  await expect(page.getByText("No mistakes to go over.")).toBeVisible({ timeout: 15_000 });

  // A formula in the book: other values computed in place.
  await make(page, "org.onedesk.formula:formula", book, { name: "C2F", "body.text": "F = C * 9 / 5 + 32", "body.unit": "°F", "body.decimals": 1, "body.param.C.default": "20" });
  await page.getByRole("button", { name: "Resources" }).first().click();
  await page.getByRole("button", { name: "Expand all" }).first().click();
  await page.getByRole("treeitem", { name: "Lessons", exact: true }).click();
  const nav = page.getByRole("navigation", { name: "Contents" });
  await nav.getByRole("button", { name: /C2F/ }).click();
  const region = page.getByRole("region", { name: /C2F/ });
  await region.getByRole("textbox", { name: "C", exact: true }).fill("100");
  await region.getByRole("button", { name: "Compute" }).click();
  await expect(region).toContainText("F = 212 °F", { timeout: 15_000 });
  await shot(page, "formula");
});
