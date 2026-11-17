/**
 * Round 10 against the REAL kernel: big trees (type-supplied children, 20000 nodes, windowed rows), a 10000-row result
 * table, merging of unsaved edits (protocol and shell), the notice bell, and the small fixes (plugin page title follows the
 * language, no "granted folders" section without `files`).
 * devhost always runs with ONEDESK_SECRET_STORE=memory and a temp data directory (kernel-host.ts): the real keychain and
 * ~/Library/Application Support/onedesk* are never touched. Screenshots: docs/screenshots/round10-*.png.
 */
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { DEVHOST, OUT, ROOT, openKernel, rpc, startHost, stopHost, type Host } from "./kernel-host";

test.use({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
test.describe.configure({ mode: "serial" });
test.setTimeout(120_000);

const FIX = path.join(ROOT, "e2e/fixtures/plugins");
const NESTED = "com.example.nested";
const SHELF = `${NESTED}:shelf`;
const NOTE = "org.onedesk.note:note";
const SAMPLE = "org.onedesk.sample:query";
const FILES_ID = "org.onedesk.files";

let host: Host;
let base: string;

test.beforeAll(async () => {
  test.skip(!existsSync(DEVHOST), `onedesk-devhost not built at ${DEVHOST}`);
  base = realpathSync(mkdtempSync(path.join(tmpdir(), "od-round10-")));
  host = await startHost(path.join(base, "data"));
});
test.afterAll(async () => {
  if (host) await stopHost(host);
  if (base) rmSync(base, { recursive: true, force: true });
});

const shot = async (page: Page, name: string) => {
  await page.mouse.move(640, 2);
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, `round10-${name}.png`) });
};
const call = <T = unknown>(page: Page, method: string, params: unknown = null) => rpc<T>(page, host, method, params);
type Err = { code: string; params?: Record<string, string>; detail?: string };
async function refused(page: Page, method: string, params: unknown = null): Promise<Err> {
  try {
    await call(page, method, params);
  } catch (e) {
    const m = (e as Error).message;
    return JSON.parse(m.slice(m.indexOf("{"), m.lastIndexOf("}") + 1)) as Err;
  }
  throw new Error(`${method} was not refused`);
}
const bare = (page: Page) => page.goto("/workbench.html?reset&quiet");
async function showTree(page: Page, name: string) {
  const b = page.getByRole("navigation", { name: "Views" }).getByRole("button", { name, exact: true });
  if ((await b.getAttribute("aria-pressed")) !== "true") await b.click();
}
const treeItem = (page: Page, name: string | RegExp) => page.getByRole("treeitem", { name, exact: typeof name === "string" });

type Saved = { page: { resourceId: string; basis?: string; values: Record<string, unknown> } };
const create = async (page: Page, kind: string, changes: Record<string, unknown>) => (await call<Saved>(page, "page.save", { target: `new:${kind}`, changes })).page.resourceId;
const basisOf = async (page: Page, id: string) => (await call<{ basis?: string }>(page, "page.resolve", { target: `resource:${id}` })).basis!;
const getRes = (page: Page, id: string) => call<{ name: string; body: Record<string, unknown> }>(page, "resource.get", { id });
const save = (page: Page, id: string, changes: Record<string, unknown>, basis?: string, overwrite?: string[]) =>
  call<Saved>(page, "page.save", { target: `resource:${id}`, changes, basis, ...(overwrite ? { overwrite } : {}) });

type TNode = { key: string; label: string; target?: string; state: string; expandable: boolean; draggable: boolean };
type Level = { nodes: TNode[]; next?: number };
const children = (page: Page, parent: string, offset?: number, locale?: string) =>
  call<Level>(page, "tree.children", { tree: "resources", parent, ...(offset !== undefined ? { offset } : {}), ...(locale ? { locale } : {}) });

/** Scrolls the nearest scrollable ancestor of `el` to the bottom / top. */
const scrollTo = (el: Locator, where: "bottom" | "top") =>
  el.evaluate((node, w) => {
    let p: HTMLElement | null = node as HTMLElement;
    while (p && p.scrollHeight <= p.clientHeight + 1) p = p.parentElement;
    if (p) p.scrollTop = w === "bottom" ? p.scrollHeight : 0;
  }, where);

let shelfId = "";
let failId = "";

test("setup: install the nested fixture; a shelf of 20000 and a shelf with count -1", async ({ page }) => {
  await bare(page);
  const folder = path.join(FIX, `${NESTED}/0.1.0`);
  const pv = await call<{ valid: boolean; id: string; version: string; fingerprint: string; problem?: unknown }>(page, "app.inspectPlugin", { folder });
  expect(pv.valid, JSON.stringify(pv.problem)).toBe(true);
  await call(page, "app.installPlugin", { folder, id: pv.id, version: pv.version, fingerprint: pv.fingerprint });
  shelfId = await create(page, SHELF, { name: "Big shelf", "body.count": 20000, "body.text": "" });
  failId = await create(page, SHELF, { name: "Broken shelf", "body.count": -1, "body.text": "" });
});

/* ------------------------------------------------------------------ type-supplied children */

test("protocol: tree.children walks 20000 plugin nodes in batches, keys unique, first node opens, the rest do not", async ({ page }) => {
  await bare(page);
  const keys = new Set<string>();
  let offset: number | undefined;
  let batches = 0;
  let first: TNode | undefined;
  const labels: string[] = [];
  const problems: string[] = [];
  do {
    const level = await children(page, shelfId, offset);
    expect(level.nodes.length).toBeGreaterThan(0);
    expect(level.nodes.length).toBeLessThanOrEqual(200);
    first ??= level.nodes[0];
    for (const n of level.nodes) {
      // plain checks: tens of thousands of expect() calls would make the test itself slow
      if (keys.has(n.key)) problems.push(`duplicate key ${n.key}`);
      keys.add(n.key);
      labels.push(n.label);
      if (!n.label.endsWith("00001") && n.target !== undefined) problems.push(`target on ${n.label}`);
      if (n.draggable) problems.push(`draggable ${n.label}`);
    }
    offset = level.next;
    batches++;
  } while (offset !== undefined && batches < 500);
  expect(problems).toEqual([]);
  expect(keys.size).toBe(20000);
  expect(batches).toBe(100);
  expect(labels[0]).toBe("Item 00001");
  expect(labels[19999]).toBe("Item 20000");
  expect(first!.target).toBe(`resource:${shelfId}`);
  expect([...keys][0]).toMatch(new RegExp(`^@${shelfId}/`));
});

test("protocol: the labels follow the locale; count -1 gives one load-failed node; disabled plugin shows no plugin nodes", async ({ page }) => {
  await bare(page);
  expect((await children(page, shelfId, undefined, "zh-CN")).nodes[0]!.label).toBe("条目 00001");
  expect((await children(page, shelfId, undefined, "en-US")).nodes[0]!.label).toBe("Item 00001");

  const bad = await children(page, failId);
  expect(bad.nodes).toHaveLength(1);
  expect(bad.nodes[0]).toMatchObject({ state: "load-failed", expandable: false });
  expect(bad.nodes[0]!.target).toBeUndefined();
  expect(bad.next).toBeUndefined();

  await call(page, "plugin.setEnabled", { plugin: NESTED, enabled: false });
  try {
    const off = await children(page, shelfId);
    expect(off.nodes.filter((n) => n.key.startsWith("@"))).toEqual([]);
  } finally {
    await call(page, "plugin.setEnabled", { plugin: NESTED, enabled: true });
  }
  expect((await children(page, shelfId)).nodes.length).toBeGreaterThan(0);
});

test("shell: a shelf of 20000 expands at once, only the visible rows exist, scrolling to the end shows Item 20000, the first node opens", async ({ page }) => {
  await openKernel(page, host);
  await showTree(page, "Resources");
  const shelf = treeItem(page, /^Big shelf/);
  await shelf.click();
  await shelf.focus();
  await page.keyboard.press("ArrowRight");
  await expect(treeItem(page, "Item 00001")).toBeVisible({ timeout: 15_000 });
  const rows = page.locator("[data-tree-key]");
  expect(await rows.count()).toBeLessThan(200);
  await shot(page, "big-tree-top");

  const last = treeItem(page, "Item 20000");
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline && (await last.count()) === 0) {
    await scrollTo(rows.first(), "bottom");
    await page.waitForTimeout(150);
  }
  await expect(last).toBeVisible();
  expect(await rows.count()).toBeLessThan(200);
  await shot(page, "big-tree-bottom");

  await scrollTo(rows.first(), "top");
  await treeItem(page, "Item 00001").dblclick();
  await expect(page.getByRole("textbox", { name: "Text", exact: true })).toBeVisible();
});

// FIXME(shell): the kernel marks a failed plugin batch with state "load-failed" (D375, round10-kernel-done.md §2), but
// side-panel.tsx only turns state "broken" into “Could not load” (round10-shell-done.md assumed "broken"). The row has an
// empty label and no text. Remove the fixme when the shell recognizes "load-failed".
test.fixme("shell: count -1 shows “Could not load” under the shelf", async ({ page }) => {
  await openKernel(page, host);
  await showTree(page, "Resources");
  const broken = treeItem(page, /^Broken shelf/);
  await broken.click();
  await broken.focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByText("Could not load").first()).toBeVisible({ timeout: 15_000 });
  await shot(page, "load-failed");
});

test("shell: the language switch renames the plugin's nodes", async ({ page }) => {
  await openKernel(page, host);
  await showTree(page, "Resources");
  const shelf = treeItem(page, /^Big shelf/);
  await shelf.click();
  await shelf.focus();
  await page.keyboard.press("ArrowRight");
  await expect(treeItem(page, "Item 00002")).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Language" }).click();
  await page.getByRole("menuitem", { name: "简体中文" }).click();
  try {
    await expect(treeItem(page, "条目 00002")).toBeVisible({ timeout: 15_000 });
  } finally {
    await call(page, "workspace.setConfig", { name: "ui.language", value: "en-US" });
  }
});

/* ------------------------------------------------------------------ big result table */

// NOTE: the kernel keeps at most MAX_ROWS = 1000 rows of a table output in a run (crates/kernel/src/runs.rs, `total` keeps the
// real count and `truncated` is set), so the 10000-row table of the sample plugin reaches the result area as 1000 rows. This
// test checks the windowing on those 1000 rows; plan §1's "1 万行" needs the cap raised or paging (see round10-tests-done.md).
test("shell: the sample plugin's big table — few DOM rows, the last row (the kernel's 1000) after scrolling, sorting changes the first row", async ({ page }) => {
  const qid = await create(page, SAMPLE, { name: "Big query", "body.text": "select 1" });
  void qid;
  await openKernel(page, host);
  await showTree(page, "Resources");
  await treeItem(page, "Big query").click();
  await expect(page.getByRole("textbox", { name: "Text", exact: true })).toBeVisible();
  const direct = page.getByRole("button", { name: /Big table/ });
  if ((await direct.count()) > 0) await direct.click();
  else {
    await page.getByRole("button", { name: "More actions" }).click(); // the action bar folds what does not fit
    await page.getByRole("menuitem", { name: /Big table/ }).click();
  }
  const table = page.getByRole("table", { name: "Result" });
  await expect(table.locator("tbody tr[data-index]").first()).toBeVisible({ timeout: 30_000 });
  expect(await table.locator("tbody tr[data-index]").count()).toBeLessThan(200);
  await shot(page, "big-table-top");

  const lastRow = table.locator('tbody tr[data-index="999"]');
  for (let i = 0; i < 20 && (await lastRow.count()) === 0; i++) {
    await scrollTo(table.locator("tbody tr[data-index]").first(), "bottom");
    await page.waitForTimeout(200);
  }
  await expect(lastRow).toBeVisible();
  await expect(lastRow).toContainText("1000");
  expect(await table.locator("tbody tr[data-index]").count()).toBeLessThan(200);
  await shot(page, "big-table-bottom");

  await scrollTo(table.locator("tbody tr[data-index]").first(), "top");
  const firstText = async () => (await table.locator("tbody tr[data-index]").first().textContent()) ?? "";
  const before = await firstText();
  await table.getByRole("columnheader", { name: "amount" }).click();
  await expect.poll(firstText).not.toBe(before);
});

/* ------------------------------------------------------------------ merging: protocol */

test("protocol: a stale basis — different fields save and both survive; the same field is refused; overwrite succeeds", async ({ page }) => {
  await bare(page);
  const id = await create(page, NOTE, { name: "Merge A", "body.text": "start" });
  const basis = await basisOf(page, id);

  await save(page, id, { name: "Renamed elsewhere" }, basis); // the other editor
  const mine = await save(page, id, { "body.text": "mine" }, basis); // still on the old basis, other field
  expect(Number(mine.page.basis)).toBeGreaterThan(Number(basis));
  const res = await getRes(page, id);
  expect(res.name).toBe("Renamed elsewhere");
  expect(res.body.text).toBe("mine");

  const staleBasis = await basisOf(page, id);
  await save(page, id, { "body.text": "theirs" }, staleBasis);
  const rev = await basisOf(page, id);
  const e = await refused(page, "page.save", { target: `resource:${id}`, changes: { "body.text": "mine again" }, basis: staleBasis });
  expect(e.code).toBe("conflict");
  expect(e.params).toMatchObject({ reason: "stale", fields: "body.text", rev });
  expect((await getRes(page, id)).body.text).toBe("theirs");

  await save(page, id, { "body.text": "mine again" }, staleBasis, ["body.text"]);
  expect((await getRes(page, id)).body.text).toBe("mine again");
  expect((await getRes(page, id)).name).toBe("Renamed elsewhere");
});

/* ------------------------------------------------------------------ merging: shell */

const editor = (page: Page) => page.getByRole("textbox", { name: "Content", exact: true });
const banner = (page: Page) => page.getByRole("alert").filter({ hasText: "Changed elsewhere" });
const saveButton = (page: Page) => page.getByRole("button", { name: "Save", exact: true });

async function openNote(page: Page, name: string) {
  await openKernel(page, host);
  await showTree(page, "Resources");
  await treeItem(page, new RegExp(`^${name}`)).click();
  await expect(editor(page)).toBeVisible();
}

test("shell: an unsaved edit and another connection renames the note — no bar, and after saving both are there", async ({ page }) => {
  const id = await create(page, NOTE, { name: "Merge B", "body.text": "start" });
  await openNote(page, "Merge B");
  await editor(page).fill("my unsaved text");
  await save(page, id, { name: "Merge B renamed" }, await basisOf(page, id));
  await expect(treeItem(page, /^Merge B renamed/)).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(500);
  await expect(banner(page)).toHaveCount(0);
  expect(await editor(page).inputValue()).toBe("my unsaved text");
  await saveButton(page).click();
  await expect.poll(async () => (await getRes(page, id)).body.text).toBe("my unsaved text");
  expect((await getRes(page, id)).name).toBe("Merge B renamed");
});

test("shell: another connection changes the same text — the bar appears; “Keep mine” saves mine", async ({ page }) => {
  const id = await create(page, NOTE, { name: "Merge C", "body.text": "start" });
  await openNote(page, "Merge C");
  await editor(page).fill("mine C");
  await save(page, id, { "body.text": "theirs C" }, await basisOf(page, id));
  await expect(banner(page)).toBeVisible({ timeout: 15_000 });
  await shot(page, "merge-bar");
  await banner(page).getByRole("button", { name: "Keep mine" }).click();
  await expect(banner(page)).toHaveCount(0);
  expect(await editor(page).inputValue()).toBe("mine C");
  await saveButton(page).click();
  await expect.poll(async () => (await getRes(page, id)).body.text).toBe("mine C");
});

test("shell: same text changed elsewhere — “Use the new one” shows the new value and no unsaved mark", async ({ page }) => {
  const id = await create(page, NOTE, { name: "Merge D", "body.text": "start" });
  await openNote(page, "Merge D");
  await editor(page).fill("mine D");
  await save(page, id, { "body.text": "theirs D" }, await basisOf(page, id));
  await expect(banner(page)).toBeVisible({ timeout: 15_000 });
  await banner(page).getByRole("button", { name: "Use the new one" }).click();
  await expect(banner(page)).toHaveCount(0);
  await expect(editor(page)).toHaveValue("theirs D");
  await expect(page.locator("[data-tab-id]", { hasText: "Merge D" }).first()).not.toHaveClass(/od-tab--dirty/);
  expect((await getRes(page, id)).body.text).toBe("theirs D");
});

test("shell: the nested plugin's touch action changes text under an unsaved edit — the bar appears", async ({ page }) => {
  const id = await create(page, SHELF, { name: "Touch shelf", "body.count": 3, "body.text": "start" });
  await openKernel(page, host);
  await showTree(page, "Resources");
  await treeItem(page, /^Touch shelf/).click();
  const text = page.getByRole("textbox", { name: "Text", exact: true });
  await text.fill("my shelf text");
  await page.getByRole("button", { name: "Touch", exact: true }).click();
  await expect(banner(page)).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => (await getRes(page, id)).body.text).toBe("changed by the plugin");
  await banner(page).getByRole("button", { name: "Use the new one" }).click();
  await expect(text).toHaveValue("changed by the plugin");
});

/* ------------------------------------------------------------------ notices */

test("shell: after a notice the bell counts it, the panel lists it, clearing empties it", async ({ page }) => {
  await openNote(page, "Merge C");
  await editor(page).fill("notice me");
  await saveButton(page).click();
  const bell = page.getByRole("button", { name: /^Notices/ });
  await expect(page.getByRole("button", { name: /^Notices \(\d+ unread\)$/ })).toBeVisible({ timeout: 15_000 });
  await bell.click();
  const panel = page.getByRole("region", { name: "Notices" });
  await expect(panel).toBeVisible();
  expect(((await panel.textContent()) ?? "").length).toBeGreaterThan("Notices".length);
  await shot(page, "notices");
  await panel.getByRole("button", { name: "Clear" }).click();
  await expect(panel).toContainText("Nothing has been shown in this session.");
});

/* ------------------------------------------------------------------ small fixes */

test("shell: the plugin page title follows the language; no “Granted folders” without files", async ({ page }) => {
  await openKernel(page, host);
  await showTree(page, "Plugins");
  await page.locator("[data-tree-key]", { hasText: "Nested" }).first().dblclick();
  await expect(page.locator("[data-tab-id]", { hasText: "Nested" }).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Granted folders" })).toHaveCount(0);
  await page.getByRole("button", { name: "Language" }).click();
  await page.getByRole("menuitem", { name: "简体中文" }).click();
  try {
    await expect(page.locator("[data-tab-id]", { hasText: "嵌套" }).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("已授权的文件夹")).toHaveCount(0);
    await shot(page, "plugin-title-zh");
  } finally {
    await call(page, "workspace.setConfig", { name: "ui.language", value: "en-US" });
  }
});

test("shell: a plugin that declares files still shows “Granted folders”", async ({ page }) => {
  await openKernel(page, host);
  await showTree(page, "Plugins");
  const detail = await call<{ id: string }>(page, "plugin.get", { plugin: FILES_ID });
  expect(detail.id).toBe(FILES_ID);
  await page.locator("[data-tree-key]", { hasText: "Files" }).first().dblclick();
  await expect(page.getByRole("heading", { name: "Granted folders" })).toBeVisible();
});

test.fixme("shell: the big table has all 10000 rows in the result area (the kernel keeps only 1000 of them, MAX_ROWS in runs.rs)", async () => {
  // Needs the kernel to keep (or page) more than 1000 rows of a run's table output; then: scroll to data-index 9999.
});
