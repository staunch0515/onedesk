/**
 * D487 §13 (docs/redesign/book.md) against the REAL kernel and the real book plugin, from New: a new book has a cover
 * and contents; the cover is what the book shows; the contents reads the book through (scroll and pages), numbers it
 * (sub-books, groups, an appendix, captions, footnotes) and remembers where the reader stopped; dropped pages keep the
 * book's order; a chapter is embedded in a note; the book is exported to a granted folder; a long book loads only what
 * is in view. Screenshots (not checked in): test-results/screenshots/book-*.png.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
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
  base = realpathSync(mkdtempSync(path.join(tmpdir(), "od-book-")));
  host = await startHost(path.join(base, "data"));
});
test.afterAll(async () => {
  if (host) await stopHost(host);
  if (base) rmSync(base, { recursive: true, force: true });
});

const B = "org.onedesk.book";
const call = <T = unknown>(page: Page, method: string, params: unknown = null) => rpc<T>(page, host, method, params);
type Node = { key: string; label: string };
const kids = async (page: Page, parent?: string) => (await call<{ nodes: Node[] }>(page, "tree.children", { tree: "resources", parent })).nodes;
const shot = (page: Page, name: string) => page.screenshot({ path: path.join(OUT, `book-${name}.png`) });
const action = (page: Page, name: string) => page.locator(".od-titlebar__actions").getByRole("button", { name });
const contents = (page: Page) => page.getByRole("navigation", { name: "Contents" });

async function make(page: Page, kind: string, parent: string | null, changes: Record<string, unknown>): Promise<string> {
  const target = parent ? `new:${kind}?parent=${parent}` : `new:${kind}`;
  const r = await call<{ page: { resourceId: string } }>(page, "page.save", { target, changes });
  return r.page.resourceId;
}

let book = "";

test("from New: a book with its cover and contents; read through, numbered, page by page; the place is kept", async ({ page }) => {
  await openKernel(page, host);
  await page.getByRole("button", { name: "New", exact: true }).first().click();
  await page.getByRole("menuitem", { name: "Book", exact: true }).click();
  const info = page.getByRole("complementary", { name: "Info" });
  await expect(info.getByText("Not saved yet")).toBeVisible();
  const box = info.getByRole("textbox", { name: "Name" });
  await box.fill("Collected");
  await expect(box).toHaveValue("Collected");
  await page.keyboard.press("ControlOrMeta+s");
  await expect(page.getByRole("heading", { level: 1, name: "Collected" })).toBeVisible();
  book = (await kids(page)).find((n) => n.label === "Collected")!.key;
  // A cover and a contents come with it.
  await expect.poll(async () => (await kids(page, book)).map((n) => n.label)).toEqual(["Cover", "Contents"]);
  const [cover, toc] = (await kids(page, book)).map((n) => n.key);
  await call(page, "page.save", { target: `resource:${cover}`, changes: { "body.authors": "Lu Xun (author)", "body.subtitle": "Stories" } });

  // The parts of the book.
  await make(page, `${B}:preface`, book, { name: "To the reader", "body.text": "Welcome." });
  await make(page, `${B}:page`, book, { name: "Seconds", "body.text": "A clock.\n\n![[Nothing here]]\nFigure: The clock face\n\nTick[^1] tock.\n\n[^1]: A second is short." });
  const minutes = (await call<{ key: string }>(page, "tree.createGroup", { tree: "resources", parent: book, name: "Minutes" })).key;
  await make(page, `${B}:page`, minutes, { name: "The minute hand", "body.text": "Figure: The long hand" });
  await make(page, "org.onedesk.note:note", minutes, { name: "Hours", "body.text": "An ordinary note." });
  const tables = await make(page, `${B}:appendix`, book, { name: "Tables" });
  await make(page, `${B}:page`, tables, { name: "Lengths", "body.text": "Table: Units\n\n| m | cm |\n|---|---|\n| 1 | 100 |" });
  const two = await make(page, `${B}:book`, book, { name: "Second book" });
  await expect.poll(async () => (await kids(page, two)).length).toBe(2);
  await make(page, `${B}:page`, two, { name: "Blessing", "body.text": "New year." });

  // Opening the book shows its cover and the way in.
  await page.reload();
  await page.getByRole("treeitem", { name: "Collected", exact: true }).click();
  await expect(page.getByText("Lu Xun (author)")).toBeVisible();
  await shot(page, "cover");
  await page.getByRole("button", { name: "Start reading" }).click();

  // The contents: front, body, back; numbered; a sub-book starts again.
  const nav = contents(page);
  await expect(nav).toBeVisible({ timeout: 15_000 });
  const titles = await nav.getByRole("button").allTextContents();
  expect(titles).toEqual([
    "To the reader",
    "Chapter 1 Seconds",
    "Chapter 2 Minutes",
    "Section 1 The minute hand",
    "Section 2 Hours",
    "Volume 1 Second book",
    "Chapter 1 Blessing",
    "Appendix A Tables",
    "A.1 Lengths",
  ]);
  const seconds = page.getByRole("region", { name: "Chapter 1 Seconds" });
  await expect(seconds).toContainText("Figure 1-1 The clock face");
  await expect(seconds).toContainText("Tick¹ tock.");
  await expect(seconds).toContainText("A second is short.");
  await shot(page, "read");
  await nav.getByRole("button", { name: "A.1 Lengths" }).click();
  await expect(page.getByRole("region", { name: "A.1 Lengths" })).toContainText("Table A-1 Units");
  await expect(nav.getByRole("button", { name: "A.1 Lengths" })).toHaveAttribute("aria-current", "location");

  // Page by page, with the arrow keys.
  await action(page, "Scroll / Pages").click();
  await expect(page.getByText(/^\d+ \/ 9$/)).toBeVisible();
  const at = await page.getByText(/^\d+ \/ 9$/).textContent();
  await page.locator(".od-sequence__reader").focus();
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByText(/^\d+ \/ 9$/)).not.toHaveText(at!);
  await shot(page, "pages");
  // Stay a moment: the place is kept, and the book offers to go on from there.
  await page.waitForTimeout(1600);
  await page.getByRole("treeitem", { name: "Collected", exact: true }).click();
  await expect(page.getByRole("button", { name: "Continue reading" })).toBeVisible();
  void toc;
});

test("pages dropped into the book keep its order; moving a chapter renumbers; a chapter is embedded in a note", async ({ page }) => {
  await openKernel(page, host);
  const top = await kids(page, book);
  const id = (label: string) => top.find((n) => n.label === label)!.key;
  // An appendix dropped before the first chapter lands in the back part, after the body (and the sub-book in it).
  await call(page, "tree.move", { tree: "resources", key: id("Tables"), target: id("Seconds"), position: "before" });
  const order = (await kids(page, book)).map((n) => n.label);
  expect(order.indexOf("Tables")).toBeGreaterThan(order.indexOf("Second book"));
  // A second contents is refused, with the book's words.
  const r = await call<{ message?: Record<string, string> }>(page, "tree.move", {
    tree: "resources",
    key: (await kids(page, id("Second book"))).find((n) => n.label === "Contents")!.key,
    target: book,
    position: "inside",
  });
  expect(r.message?.["en-US"]).toBe("This book already has contents.");
  // Minutes before Seconds: the numbers follow.
  await call(page, "tree.move", { tree: "resources", key: id("Minutes"), target: id("Seconds"), position: "before" });
  await page.reload();
  await page.getByRole("treeitem", { name: "Collected", exact: true }).click();
  await page.getByRole("button", { name: /reading/ }).click();
  await expect(contents(page).getByRole("button", { name: "Chapter 1 Minutes" })).toBeVisible({ timeout: 15_000 });
  await expect(contents(page).getByRole("button", { name: "Chapter 2 Seconds" })).toBeVisible();

  // A note embeds one chapter of the book.
  await make(page, "org.onedesk.note:note", null, { name: "Reading notes", "body.text": "From the book:\n\n![[Collected#Seconds]]" });
  await page.reload();
  await page.getByRole("treeitem", { name: "Reading notes", exact: true }).click();
  await page.locator(".od-titlebar__actions").getByRole("button", { name: "Read / Edit" }).click();
  const embedded = page.getByRole("figure", { name: "Collected › Seconds" });
  await expect(embedded).toContainText("The clock face", { timeout: 15_000 });
  await shot(page, "embedded");
});

test("export prints the book to a granted folder, with its images beside it", async ({ page }) => {
  await openKernel(page, host);
  const out = path.join(base, "out");
  mkdirSync(out, { recursive: true });
  await call(page, "plugin.grantFolder", { plugin: B, path: out });
  await page.getByRole("treeitem", { name: "Collected", exact: true }).click();
  await page.getByRole("button", { name: /reading/ }).click();
  await expect(contents(page)).toBeVisible({ timeout: 15_000 });
  await action(page, "Export").click();
  await expect.poll(() => existsSync(path.join(out, "Collected.md")), { timeout: 30_000 }).toBe(true);
  const md = readFileSync(path.join(out, "Collected.md"), "utf8");
  expect(md).toContain("# Collected");
  expect(md).toContain("Lu Xun (author)");
  expect(md).toMatch(/## Chapter 2 Seconds/);
  expect(md).toContain("| m | cm |");
  expect(readdirSync(out)).toContain("Collected.md");
  await shot(page, "exported");
});

test("a book of 300 pages loads only what is in view", async ({ page }) => {
  await openKernel(page, host);
  const long = await make(page, `${B}:book`, null, { name: "Long book" });
  for (let i = 1; i <= 300; i++) await make(page, `${B}:page`, long, { name: `Page ${i}`, "body.text": `Text of page ${i}.` });
  await page.reload();
  await page.getByRole("treeitem", { name: "Long book", exact: true }).click();
  await page.getByRole("button", { name: "Start reading" }).click();
  await expect(page.getByText("Text of page 1.")).toBeVisible({ timeout: 30_000 });
  expect(await contents(page).getByRole("button").count()).toBe(300);
  const loaded = await page.locator(".od-sequence__content").count();
  expect(loaded).toBeLessThan(40);
  await shot(page, "long");
});
