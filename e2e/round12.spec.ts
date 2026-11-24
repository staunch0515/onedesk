/**
 * Round 12 against the REAL kernel: the composite plugin (drops become references), the collection plugin (conditions searched live),
 * the `requires.resources` permission and `resources.search` (peek / nopeek fixtures), and the completed HTTP request plugin
 * (against e2e/fixtures/transfer-server.mjs `/echo`).
 * devhost always runs with ONEDESK_SECRET_STORE=memory and a temp data directory (kernel-host.ts): the real keychain and
 * ~/Library/Application Support/onedesk* are never touched. Screenshots: docs/screenshots/round12-*.png.
 */
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { DEVHOST, OUT, ROOT, openKernel, rpc, startHost, stopHost, type Host } from "./kernel-host";
// @ts-ignore plain JS module, no types
import { startServer } from "./fixtures/transfer-server.mjs";

test.use({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
test.describe.configure({ mode: "default" });
test.setTimeout(120_000);

const FIX = path.join(ROOT, "e2e/fixtures/plugins");
const NOTE = "org.onedesk.note:note";
const LINK = "org.onedesk.link:link";
const COMPOSITE = "org.onedesk.composite:composite";
const COLLECTION = "org.onedesk.collection:collection";
const REQUEST = "org.onedesk.http:request";
const PROBE_PEEK = "com.example.peek:probe";
const PROBE_NOPEEK = "com.example.nopeek:probe";

let host: Host;
let base: string;
let srv: { port: number; url: string; close(): Promise<void> };

test.beforeAll(async () => {
  test.skip(!existsSync(DEVHOST), `onedesk-devhost not built at ${DEVHOST}`);
  base = realpathSync(mkdtempSync(path.join(tmpdir(), "od-round12-")));
  srv = await startServer({ port: 0 });
  host = await startHost(path.join(base, "data"));
});
test.afterAll(async () => {
  if (host) await stopHost(host);
  if (srv) await srv.close();
  if (base) rmSync(base, { recursive: true, force: true });
});

const shot = async (page: Page, name: string) => {
  await page.mouse.move(640, 2);
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, `round12-${name}.png`) });
};
const call = <T = unknown>(page: Page, method: string, params: unknown = null) => rpc<T>(page, host, method, params);
const bare = (page: Page) => page.goto("/workbench.html?reset&quiet");

type Saved = { page: { resourceId: string } };
const create = async (page: Page, kind: string, changes: Record<string, unknown>) => (await call<Saved>(page, "page.save", { target: `new:${kind}`, changes })).page.resourceId;
type Res = { id: string; name: string; parentId?: string; deleted: boolean; body: Record<string, unknown> };
const getRes = (page: Page, id: string) => call<Res>(page, "resource.get", { id });
type TNode = { key: string; label: string; icon: string; expandable: boolean; state: string; target?: string; draggable: boolean; accepts: string[]; dropAny?: boolean; kind: string };
type Level = { nodes: TNode[]; next?: number };
const children = (page: Page, parent?: string, offset?: number) => call<Level>(page, "tree.children", { tree: "resources", ...(parent ? { parent } : {}), ...(offset ? { offset } : {}), locale: "en-US" });
async function allChildren(page: Page, parent: string): Promise<TNode[]> {
  const out: TNode[] = [];
  let offset: number | undefined;
  let guard = 0;
  do {
    const level = await children(page, parent, offset);
    out.push(...level.nodes);
    offset = level.next;
  } while (offset !== undefined && ++guard < 100);
  return out;
}
const rootNode = async (page: Page, id: string) => (await children(page)).nodes.find((n) => n.key === id)!;
type Moved = { handled?: boolean; message?: unknown };
const dropOn = (page: Page, key: string, target: string) => call<Moved>(page, "tree.move", { tree: "resources", key, target, position: "inside", locale: "en-US" });
const text = (label: unknown): string => (typeof label === "string" ? label : (label as Record<string, string>)["en-US"] ?? "");
const items = async (page: Page, id: string) => (await getRes(page, id)).body.items as string[];

type RunInfo = { id: string; status: string; output?: { type: string; text?: string }; error?: { code: string; reason?: string; message: string; params?: Record<string, string> } };
const getRun = (page: Page, id: string) => call<RunInfo>(page, "run.get", { id });
async function finished(page: Page, runId: string): Promise<RunInfo> {
  await expect.poll(async () => (await getRun(page, runId)).status, { timeout: 60_000 }).not.toBe("running");
  return getRun(page, runId);
}
const startRun = (page: Page, action: string, id: string, input: Record<string, unknown> = {}, params: Record<string, string> = {}) =>
  call<string>(page, "run.start", { action, resourceId: id, target: `resource:${id}`, tabId: "t", input, params });

type Preview = { valid: boolean; problem?: unknown; id: string; version: string; fingerprint: string; permissions?: { id: string; detail: string }[] };
async function install(page: Page, folder: string) {
  const preview = await call<Preview>(page, "app.inspectPlugin", { folder });
  expect(preview.valid, JSON.stringify(preview.problem)).toBe(true);
  await call(page, "app.installPlugin", { folder, id: preview.id, version: preview.version, fingerprint: preview.fingerprint });
  return preview;
}

const showTree = async (page: Page, name: string) => {
  const b = page.getByRole("navigation", { name: "Views" }).getByRole("button", { name, exact: true });
  if ((await b.getAttribute("aria-pressed")) !== "true") await b.click();
};
const treeItem = (page: Page, name: string | RegExp) => page.getByRole("treeitem", { name, exact: typeof name === "string" });

/* ------------------------------------------------------------------ composite: protocol */

let compId = "";
let noteId = "";
let linkId = "";
let comp2Id = "";

test("composite: a new composite is a node that accepts drops from anything (dropAny); a note is not", async ({ page }) => {
  await bare(page);
  noteId = await create(page, NOTE, { name: "Plan", "body.text": "alpha" });
  linkId = await create(page, LINK, { name: "Docs", "body.url": "https://example.com" });
  compId = await create(page, COMPOSITE, { name: "Bundle" });
  const c = await rootNode(page, compId);
  expect(c).toMatchObject({ label: "Bundle", dropAny: true, expandable: true, kind: COMPOSITE });
  expect(c.accepts).toEqual([COMPOSITE]);
  expect((await rootNode(page, noteId)).dropAny).toBeUndefined();
  expect(await items(page, compId)).toEqual([]);
});

test("composite: moving a note and a link onto it adds references, moves nothing, and answers with the message", async ({ page }) => {
  await bare(page);
  const before = [(await getRes(page, noteId)).parentId, (await getRes(page, linkId)).parentId];
  const a = await dropOn(page, noteId, compId);
  expect(a.handled).toBe(true);
  expect(text(a.message)).toBe("Added 1 item(s)");
  const b = await dropOn(page, linkId, compId);
  expect(b.handled).toBe(true);
  expect([(await getRes(page, noteId)).parentId, (await getRes(page, linkId)).parentId]).toEqual(before);
  expect(await items(page, compId)).toEqual([noteId, linkId]);
  // both still show where they were
  const root = (await children(page)).nodes.map((n) => n.key);
  expect(root).toEqual(expect.arrayContaining([noteId, linkId, compId]));
});

test("composite: dropping the same one again adds nothing (still handled, still not moved)", async ({ page }) => {
  await bare(page);
  const again = await dropOn(page, noteId, compId);
  expect(again.handled).toBe(true);
  expect(text(again.message)).toBe("Added 0 item(s)");
  expect(await items(page, compId)).toEqual([noteId, linkId]);
  expect((await getRes(page, noteId)).parentId).toBeUndefined();
});

test("composite: the drop is in the audit log as tree.drop by the plugin", async ({ page }) => {
  await bare(page);
  type Audit = { operation: string; target: string; actor: string; source: string; detail: string };
  const rows = (await call<Audit[]>(page, "audit.list", { operation: "tree.drop" })).filter((a) => a.operation === "tree.drop");
  expect(rows.length).toBeGreaterThanOrEqual(2);
  expect(rows[0]!.target).toBe("Bundle");
  expect(rows[0]!.source).toBe("plugin");
  expect(rows[0]!.actor).toContain("org.onedesk.composite");
  expect(rows[0]!.detail).toContain("sources");
});

test("composite: children are the references in order, with a target, the original's name and icon", async ({ page }) => {
  await bare(page);
  const nodes = await allChildren(page, compId);
  expect(nodes.map((n) => [n.label, n.target])).toEqual([
    ["Plan", `resource:${noteId}`],
    ["Docs", `resource:${linkId}`],
  ]);
  for (const n of nodes) {
    expect(n.key).toBe(`@${compId}/ref-${n.target!.slice("resource:".length)}`);
    expect(n.draggable).toBe(false);
  }
});

test("composite: a referenced resource that is deleted turns into a node that says it is gone; restoring brings it back", async ({ page }) => {
  await bare(page);
  await call(page, "resource.delete", { id: linkId });
  let nodes = await allChildren(page, compId);
  expect(nodes.map((n) => n.label)).toEqual(["Plan", "(no longer exists)"]);
  expect(nodes[1]!.target).toBeUndefined();
  expect(nodes[1]!.icon).toBe("unlink");
  expect(await items(page, compId)).toEqual([noteId, linkId]); // the reference stays
  await call(page, "resource.undelete", { id: linkId });
  nodes = await allChildren(page, compId);
  expect(nodes.map((n) => n.label)).toEqual(["Plan", "Docs"]);
});

test("composite: a composite dropped on a composite is a real move (accepts), not a reference", async ({ page }) => {
  await bare(page);
  comp2Id = await create(page, COMPOSITE, { name: "Inner" });
  const r = await dropOn(page, comp2Id, compId);
  expect(r.handled).toBeFalsy();
  expect((await getRes(page, comp2Id)).parentId).toBe(compId);
  expect(await items(page, compId)).toEqual([noteId, linkId]);
  const kids = (await children(page, compId)).nodes;
  expect(kids.map((n) => n.key)).toContain(comp2Id);
  // nesting: put a note into the inner one
  await dropOn(page, noteId, comp2Id);
  expect(await items(page, comp2Id)).toEqual([noteId]);
});

test("composite: a resource outside the plugin's own kinds can be referenced and opened (target accepted for requires.resources)", async ({ page }) => {
  await bare(page);
  const nodes = await allChildren(page, compId);
  const note = nodes.find((n) => n.label === "Plan")!;
  expect(note.target).toBe(`resource:${noteId}`);
  expect(note.state).toBe("ok");
});

/* ------------------------------------------------------------------ composite: page buttons */

test("composite page: the buttons move and remove the chosen item; removing never deletes the resource", async ({ page }) => {
  await bare(page);
  const third = await create(page, NOTE, { name: "Third", "body.text": "c" });
  await dropOn(page, third, compId);
  expect(await items(page, compId)).toEqual([noteId, linkId, third]);
  const ev = (event: string, row: string) => call<{ message?: unknown }>(page, "page.event", { target: `resource:${compId}`, event, context: { row, locale: "en-US" } });
  await ev("up", third);
  expect(await items(page, compId)).toEqual([noteId, third, linkId]);
  await ev("down", noteId);
  expect(await items(page, compId)).toEqual([third, noteId, linkId]);
  await ev("up", third); // already first: unchanged
  expect(await items(page, compId)).toEqual([third, noteId, linkId]);
  const removed = await ev("remove", noteId);
  expect(text(removed.message)).toBe("Removed from this composite");
  expect(await items(page, compId)).toEqual([third, linkId]);
  const still = await getRes(page, noteId);
  expect(still.deleted).toBe(false);
  expect(still.name).toBe("Plan");
  expect(text((await ev("remove", "nope")).message)).toBe("Pick an item first.");
  await dropOn(page, noteId, compId); // put it back for the interface test
  expect(await items(page, compId)).toEqual([third, linkId, noteId]);
});

/* ------------------------------------------------------------------ composite: interface */

test("interface: dropping a note on the composite shows the message; expanding lists the reference; clicking opens the original", async ({ page }) => {
  await bare(page);
  const fresh = await create(page, COMPOSITE, { name: "Shelf" });
  const lone = await create(page, NOTE, { name: "Lone note", "body.text": "only here" });
  await openKernel(page, host);
  await showTree(page, "Resources");
  const from = (await treeItem(page, /^Lone note/).boundingBox())!;
  const to = (await treeItem(page, /^Shelf/).boundingBox())!;
  await page.mouse.move(from.x + 20, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 28, from.y + from.height / 2 + 8, { steps: 2 });
  await page.mouse.move(to.x + 40, to.y + to.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByText("Added 1 item(s)").first()).toBeVisible({ timeout: 15_000 });
  expect(await items(page, fresh)).toEqual([lone]);
  expect((await getRes(page, lone)).parentId).toBeUndefined();
  await expect(treeItem(page, /^Lone note/).first()).toBeVisible();
  await shot(page, "composite-dropped");
  // expand the composite: the reference is a child; click opens the original note
  await treeItem(page, /^Shelf/).first().focus();
  await page.keyboard.press("ArrowRight");
  const ref = page.locator(`[data-tree-key="@${fresh}/ref-${lone}"]`);
  await expect(ref).toBeVisible({ timeout: 15_000 });
  await ref.click();
  await expect(page.getByRole("tab", { name: /^Lone note/, selected: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("textbox", { name: "Content", exact: true })).toHaveValue("only here");
  await shot(page, "composite-expanded");
});

test("interface: the composite page lists the items with row keys, targets and row actions", async ({ page }) => {
  await bare(page);
  const id = await create(page, COMPOSITE, { name: "Board" });
  const one = await create(page, NOTE, { name: "One", "body.text": "1" });
  const two = await create(page, NOTE, { name: "Two", "body.text": "2" });
  await dropOn(page, one, id);
  await dropOn(page, two, id);
  await openKernel(page, host);
  await showTree(page, "Resources");
  await treeItem(page, /^Board/).first().click();
  await expect(page.getByRole("tab", { name: /^Board/, selected: true })).toBeVisible({ timeout: 15_000 });
  const rows = page.getByRole("row");
  await expect(rows.filter({ hasText: "One" })).toBeVisible({ timeout: 15_000 });
  // the table page: row keys and row buttons are accepted by the kernel
  const view = await call<{ view: { type: string; rowKeys?: string[]; rowTargets?: (string | null)[]; rowActions?: { id: string }[] }[] }>(page, "page.resolve", { target: `resource:${id}`, context: { locale: "en-US" } });
  expect(view.view[0]).toMatchObject({ type: "table", rowKeys: [one, two], rowTargets: [`resource:${one}`, `resource:${two}`] });
  expect(view.view[0]!.rowActions!.map((a) => a.id)).toEqual(["up", "down", "remove"]);
  await expect(rows.filter({ hasText: "Two" })).toBeVisible();
  await expect(page.getByRole("tab", { name: /^Board/, selected: true })).toBeVisible();
  expect(await page.locator("body").innerText()).not.toContain("[object Object]");
  await expect(rows.filter({ hasText: "Two" })).toContainText("Note");
  await shot(page, "composite-page");
});

test("interface: the row buttons move a row up and down and remove it, and removing never deletes the resource", async ({ page }) => {
  await bare(page);
  const id = await create(page, COMPOSITE, { name: "Rows" });
  const one = await create(page, NOTE, { name: "One", "body.text": "1" });
  const two = await create(page, NOTE, { name: "Two", "body.text": "2" });
  await dropOn(page, one, id);
  await dropOn(page, two, id);
  await openKernel(page, host);
  await showTree(page, "Resources");
  await treeItem(page, /^Rows/).first().click();
  const rows = page.getByRole("row");
  await expect(rows.filter({ hasText: "One" })).toBeVisible({ timeout: 15_000 });
  const rowOf = (name: string) => rows.filter({ hasText: name });
  // wait for the table to show the new order before every next click (the page refetches after the save)
  await rowOf("Two").getByRole("button", { name: "Move up", exact: true }).click();
  await expect.poll(() => items(page, id), { timeout: 15_000 }).toEqual([two, one]);
  await expect(rows.nth(1)).toContainText("Two"); // rows.nth(0) is the header row
  await rowOf("One").getByRole("button", { name: "Move up", exact: true }).click();
  await expect.poll(() => items(page, id), { timeout: 15_000 }).toEqual([one, two]);
  await expect(rows.nth(1)).toContainText("One");
  await rowOf("One").getByRole("button", { name: "Move down", exact: true }).click();
  await expect.poll(() => items(page, id), { timeout: 15_000 }).toEqual([two, one]);
  await expect(rows.nth(1)).toContainText("Two");
  await rowOf("Two").getByRole("button", { name: "Remove", exact: true }).click();
  await expect.poll(() => items(page, id), { timeout: 15_000 }).toEqual([one]);
  expect((await getRes(page, two)).deleted).toBe(false);
  await expect(rowOf("Two")).toHaveCount(0);
  await shot(page, "composite-page-removed");
});

/* ------------------------------------------------------------------ collection */

let colId = "";
const colSearch = async (page: Page, cond: Record<string, string>) => {
  colId = colId || (await create(page, COLLECTION, { name: "Smart" }));
  await call(page, "page.save", { target: `resource:${colId}`, changes: { "body.kinds": "", "body.tags": "", "body.text": "", ...Object.fromEntries(Object.entries(cond).map(([k, v]) => [`body.${k}`, v])) } });
  return (await allChildren(page, colId)).map((n) => n.label).sort();
};

test("collection: by type, by tag, by text — each returns what it should and every node opens its resource", async ({ page }) => {
  await bare(page);
  const n1 = await create(page, NOTE, { name: "Alpha note", "body.text": "kiwi smoothie recipe", tags: ["fruit", "food"] });
  await create(page, NOTE, { name: "Beta note", "body.text": "plain", tags: ["food"] });
  await create(page, LINK, { name: "Gamma link", "body.url": "https://example.com/kiwi", tags: ["fruit"] });
  expect(await colSearch(page, { kinds: NOTE })).toEqual(expect.arrayContaining(["Alpha note", "Beta note"]));
  expect(await colSearch(page, { kinds: NOTE })).not.toContain("Gamma link");
  expect(await colSearch(page, { kinds: `${LINK}, ${NOTE}` })).toEqual(expect.arrayContaining(["Alpha note", "Gamma link"]));
  expect(await colSearch(page, { tags: "fruit" })).toEqual(["Alpha note", "Gamma link"]);
  expect(await colSearch(page, { tags: "fruit, food" })).toEqual(["Alpha note"]);
  expect(await colSearch(page, { text: "smoothie" })).toEqual(["Alpha note"]);
  expect(await colSearch(page, { kinds: LINK, tags: "fruit" })).toEqual(["Gamma link"]);
  expect(await colSearch(page, { tags: "fruit, food" })).toEqual(["Alpha note"]);
  const nodes = await allChildren(page, colId);
  expect(nodes.map((n) => n.target)).toContain(`resource:${n1}`);
  expect(await colSearch(page, { text: "no-such-word-xyz" })).toEqual([]);
  expect(await colSearch(page, { kinds: "no.such:kind" })).toEqual([]);
});

test("collection: a new matching resource shows up on the next expand; an edited one that no longer matches goes away", async ({ page }) => {
  await bare(page);
  expect(await colSearch(page, { tags: "fresh" })).toEqual([]);
  const id = await create(page, NOTE, { name: "Fresh one", "body.text": "x", tags: ["fresh"] });
  expect(await colSearch(page, { tags: "fresh" })).toEqual(["Fresh one"]);
  await call(page, "page.save", { target: `resource:${id}`, changes: { tags: [] } });
  expect(await colSearch(page, { tags: "fresh" })).toEqual([]);
});

test("collection: with no condition nothing is listed and the page says to fill one in", async ({ page }) => {
  await bare(page);
  expect(await colSearch(page, {})).toEqual([]);
  await openKernel(page, host);
  await showTree(page, "Resources");
  await treeItem(page, /^Smart/).first().click();
  await expect(page.getByText("Fill in at least one condition.")).toBeVisible({ timeout: 15_000 });
  await shot(page, "collection-empty");
});

test("collection: the page shows the conditions, the total and a results table", async ({ page }) => {
  await bare(page);
  await create(page, NOTE, { name: "Alpha view", "body.text": "a", tags: ["pagefruit"] });
  await create(page, LINK, { name: "Gamma view", "body.url": "https://example.com/g", tags: ["pagefruit"] });
  await create(page, COLLECTION, { name: "Fruit view", "body.tags": "pagefruit" });
  await openKernel(page, host);
  await showTree(page, "Resources");
  await treeItem(page, /^Fruit view/).first().click();
  await expect(page.getByText("2 result(s)")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("row").filter({ hasText: "Alpha view" })).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: "Gamma view" })).toBeVisible();
  expect(await page.locator("body").innerText()).not.toContain("[object Object]");
  await expect(page.getByRole("row").filter({ hasText: "Alpha view" })).toContainText("Note");
  await shot(page, "collection-page");
  // D477: the kinds are ticked from a list of the kinds by name, not typed; only notes now.
  const kinds = page.getByRole("button", { name: "Types", exact: true });
  await expect(kinds).toContainText("Any type");
  await kinds.click();
  await expect(page.getByRole("menuitemcheckbox", { name: "Link" })).toBeVisible();
  await page.getByRole("menuitemcheckbox", { name: "Note" }).click();
  await page.keyboard.press("Escape");
  await expect(kinds).toContainText("Note");
  await expect(page.getByText("1 result(s)")).toBeVisible();
  await shot(page, "collection-kinds");
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(async () => (await call<{ body: { kinds?: string } }>(page, "resource.get", { id: (await call<{ nodes: { key: string; label: string }[] }>(page, "tree.children", { tree: "resources" })).nodes.find((n) => n.label === "Fruit view")!.key })).body.kinds).toBe(NOTE);
});

/* ------------------------------------------------------------------ permission: requires.resources / resources.search */

let peekId = "";
let nopeekId = "";

test("permission: inspecting a package that declares requires.resources lists resourcesAll; one that does not has none", async ({ page }) => {
  await bare(page);
  const peek = await call<Preview>(page, "app.inspectPlugin", { folder: path.join(FIX, "com.example.peek/0.1.0") });
  expect(peek.valid, JSON.stringify(peek.problem)).toBe(true);
  expect(peek.permissions!.map((p) => p.id)).toContain("resourcesAll");
  expect(peek.permissions!.find((p) => p.id === "resourcesAll")!.detail).toBe("");
  const nope = await call<Preview>(page, "app.inspectPlugin", { folder: path.join(FIX, "com.example.nopeek/0.1.0") });
  expect(nope.permissions!.map((p) => p.id)).not.toContain("resourcesAll");
  const comp = await call<{ permissions?: { id: string }[] }>(page, "plugin.get", { plugin: "org.onedesk.composite" });
  expect(JSON.stringify(comp)).toContain("resourcesAll");
  // the install dialog (before the package is installed) shows the sentence; the zh/ja texts exist under the key the shell looks up
  await openKernel(page, host);
  await showTree(page, "Plugins");
  await page.getByRole("button", { name: "Install a plugin…" }).click();
  await page.getByRole("textbox", { name: "Folder path" }).fill(path.join(FIX, "com.example.peek/0.1.0"));
  await page.getByRole("button", { name: "Look inside" }).click();
  await expect(page.getByRole("dialog")).toContainText("Read the name, type and location (not the content) of everything in this workspace", { timeout: 15_000 });
  await shot(page, "permission-dialog");
  await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
  const zh = await call<{ texts: Record<string, string> }>(page, "i18n.shell", { locale: "zh-CN" });
  expect(zh.texts["kernel.permission.resourcesAll"]).toBe("读取本工作区所有内容的名称、类型和位置（不含正文）");
  const ja = await call<{ texts: Record<string, string> }>(page, "i18n.shell", { locale: "ja-JP" });
  expect(ja.texts["kernel.permission.resourcesAll"]).toMatch(/[\u3040-\u30ff]/);
  await install(page, path.join(FIX, "com.example.peek/0.1.0"));
  await install(page, path.join(FIX, "com.example.nopeek/0.1.0"));
  peekId = await create(page, PROBE_PEEK, { name: "Peeker" });
  nopeekId = await create(page, PROBE_NOPEEK, { name: "Blind" });
});

const peek = async (page: Page, id: string, query: Record<string, unknown>) => {
  const run = await finished(page, await startRun(page, `${id === peekId ? "com.example.peek" : "com.example.nopeek"}:peek`, id, { "body.query": JSON.stringify(query) }));
  return run;
};

test("permission: search returns basic info only — no body, no description — and honours kinds, tags, text, ids, limit and total", async ({ page }) => {
  await bare(page);
  const one = await create(page, NOTE, { name: "Peekaboo", description: "secret description", "body.text": "zebrasecretbody", tags: ["peek"] });
  await create(page, NOTE, { name: "Peek filler", "body.text": "filler" });
  const run = await peek(page, peekId, { text: "zebrasecretbody" });
  expect(run.status).toBe("success");
  const res = JSON.parse(run.output!.text!) as { items: Record<string, unknown>[]; total: number; next?: number };
  expect(res.total).toBe(1);
  expect(res.items[0]).toMatchObject({ id: one, name: "Peekaboo", kind: NOTE, tags: ["peek"], deleted: false });
  expect(Object.keys(res.items[0]!)).not.toContain("body");
  expect(Object.keys(res.items[0]!)).not.toContain("description");
  expect(JSON.stringify(res)).not.toContain("zebrasecretbody");
  expect(JSON.stringify(res)).not.toContain("secret description");
  const limited = JSON.parse((await peek(page, peekId, { kinds: [NOTE], limit: 2 })).output!.text!) as { items: unknown[]; total: number; next?: number };
  expect(limited.items).toHaveLength(2);
  expect(limited.total).toBeGreaterThan(2);
  expect(limited.next).toBe(2);
  const byIds = JSON.parse((await peek(page, peekId, { ids: [one, "0".repeat(32)] })).output!.text!) as { items: { id: string }[] };
  expect(byIds.items.map((i) => i.id)).toEqual([one]);
  await call(page, "resource.delete", { id: one });
  const gone = JSON.parse((await peek(page, peekId, { ids: [one] })).output!.text!) as { items: { id: string; deleted: boolean }[] };
  expect(gone.items).toEqual([expect.objectContaining({ id: one, deleted: true })]);
  const hidden = JSON.parse((await peek(page, peekId, { tags: ["peek"] })).output!.text!) as { items: unknown[] };
  expect(hidden.items).toEqual([]);
});

test("permission: a plugin that did not declare requires.resources is refused with denied/notRequested", async ({ page }) => {
  await bare(page);
  const run = await peek(page, nopeekId, { kinds: [NOTE] });
  expect(run.status).toBe("success");
  expect(JSON.parse(run.output!.text!)).toEqual({ error: "denied", reason: "notRequested" });
});

/* ------------------------------------------------------------------ HTTP request */

type Echo = { method: string; path: string; query: Record<string, string | string[]>; headers: Record<string, string>; body: string };
let httpSeq = 0;
let netReady = false;
async function allowLocal(page: Page) {
  if (netReady) return;
  const cfg = (await call<{ nodes: { key: string; label: string }[] }>(page, "tree.children", { tree: "config" })).nodes.find((n) => n.label === "Workspace")!.key;
  await call(page, "params.set", { node: cfg, name: "network.allow", value: `127.0.0.1:${srv.port}` });
  netReady = true;
}
async function sendRequest(page: Page, fields: { method?: string; path?: string; query?: string; headers?: string; body?: string; url?: string }) {
  await allowLocal(page);
  const url = fields.url ?? `${srv.url}${fields.path ?? "/echo"}`;
  const input = { "body.method": fields.method ?? "GET", "body.url": url, "body.query": fields.query ?? "", "body.headers": fields.headers ?? "", "body.body": fields.body ?? "" };
  const id = await create(page, REQUEST, { name: `Req ${++httpSeq}`, "body.method": input["body.method"], "body.url": url, "body.query": input["body.query"], "body.headers": input["body.headers"], "body.body": input["body.body"] });
  const run = await finished(page, await startRun(page, "org.onedesk.http:send", id, input));
  return { id, run };
}
const echoOf = (run: RunInfo) => JSON.parse(run.output!.text!) as Echo;
const tabView = (page: Page, run: string, tabId: string) => call<{ type: string; rows?: unknown[][]; text?: string }[]>(page, "run.render", { id: run, tabId, locale: "en-US" });

test("http: every method reaches the server with its body; the summary has status text, time and size", async ({ page }) => {
  await bare(page);
  for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    const { run } = await sendRequest(page, { method, body: method === "GET" ? "" : `{"m":"${method}"}`, headers: "Content-Type: application/json" });
    expect(run.status, JSON.stringify(run.error)).toBe("success");
    const echo = echoOf(run);
    expect(echo.method).toBe(method);
    expect(echo.body).toBe(method === "GET" ? "" : `{"m":"${method}"}`); // GET sends no body
  }
  const { run } = await sendRequest(page, { path: "/echo" });
  expect((run as RunInfo & { summary?: { message?: string } }).summary?.message ?? "").toMatch(/^200 OK · \d+ ms · \d+ bytes$/);
});

test("http: query parameters are added to the address, percent-encoded, after one already there", async ({ page }) => {
  await bare(page);
  const { run } = await sendRequest(page, { path: "/echo/items?fixed=1", query: "page=2\nname=a b&c\n# comment\nflag" });
  const echo = echoOf(run);
  expect(echo.path).toBe("/echo/items");
  expect(echo.query).toEqual({ fixed: "1", page: "2", name: "a b&c", flag: "" });
});

test("http: request headers are sent", async ({ page }) => {
  await bare(page);
  const { run } = await sendRequest(page, { headers: "X-Test: hello\nAccept: application/json" });
  expect(echoOf(run).headers["x-test"]).toBe("hello");
});

test("http: the response body is pretty printed JSON; the Status tab and the headers table show what came back", async ({ page }) => {
  await bare(page);
  const { run } = await sendRequest(page, { query: "a=1" });
  const out = run.output!.text!;
  expect(out).toContain('\n  "method": "GET"');
  expect(JSON.parse(out).query).toEqual({ a: "1" });
  const info = await tabView(page, run.id, "info");
  const rows = info[0]!.rows!;
  expect(rows[0]).toEqual(["Status", "200 OK"]);
  expect(String(rows[1]![1])).toMatch(/^\d+ ms$/);
  expect(String(rows[2]![1])).toMatch(/^\d+ bytes$/);
  const headers = await tabView(page, run.id, "headers");
  const table = new Map(headers[0]!.rows!.map((r) => [String(r[0]).toLowerCase(), String(r[1])]));
  expect(table.get("x-echo")).toBe("yes");
  expect(table.get("content-type")).toContain("application/json");
});

test("http: HEAD shows no body but still the status and headers", async ({ page }) => {
  await bare(page);
  const { run } = await sendRequest(page, { method: "HEAD", body: "ignored" });
  expect(run.status, JSON.stringify(run.error)).toBe("success");
  expect(run.output!.text).toBe("");
  const headers = await tabView(page, run.id, "headers");
  expect(headers[0]!.rows!.map((r) => String(r[0]).toLowerCase())).toContain("x-echo");
  expect((await tabView(page, run.id, "info"))[0]!.rows![0]).toEqual(["Status", "200 OK"]);
});

test("http: a non-2xx status is a finished run with that status; an unreachable or forbidden address fails with a clear error", async ({ page }) => {
  await bare(page);
  const missing = await sendRequest(page, { path: "/status/404" });
  expect(missing.run.status).toBe("success");
  expect(missing.run.output!.text).toBe("status 404");
  expect((await tabView(page, missing.run.id, "info"))[0]!.rows![0]).toEqual(["Status", "404 Not Found"]);
  const refused = await sendRequest(page, { url: "http://example.com/" });
  expect(refused.run.status).toBe("error");
  expect(refused.run.error).toMatchObject({ code: "denied" });
  const empty = await sendRequest(page, { url: " " });
  expect(empty.run.status).toBe("error");
  expect(empty.run.error!.message).toContain("The address is empty.");
});

test("http: the request page shows the method list, address, query, headers and body; Send fills the Response tab", async ({ page }) => {
  // its own kernel with one resource: the shared workspace has dozens of resources by now and the tree is virtualized
  const dir2 = realpathSync(mkdtempSync(path.join(tmpdir(), "od-round12b-")));
  const host2 = await startHost(path.join(dir2, "data"));
  try {
    await bare(page);
    const call2 = <T = unknown>(method: string, params: unknown = null) => rpc<T>(page, host2, method, params);
    const cfg = (await call2<{ nodes: { key: string; label: string }[] }>("tree.children", { tree: "config" })).nodes.find((n) => n.label === "Workspace")!.key;
    await call2("params.set", { node: cfg, name: "network.allow", value: `127.0.0.1:${srv.port}` });
    await call2("page.save", { target: `new:${REQUEST}`, changes: { name: "Shown request", "body.method": "POST", "body.url": `${srv.url}/echo`, "body.query": "q=1", "body.headers": "X-Test: yes", "body.body": '{"a":1}' } });
    await openKernel(page, host2);
    await showTree(page, "Resources");
    await treeItem(page, /^Shown request/).first().click();
    await expect(page.getByRole("tab", { name: /^Shown request/, selected: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Query parameters")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Headers", { exact: true }).first()).toBeVisible();
    await page.getByRole("button", { name: "Send", exact: true }).first().click();
    await expect(page.getByText(/200 OK · \d+ ms/).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('"method": "POST"').first()).toBeVisible();
    await shot(page, "http-response");
  } finally {
    await stopHost(host2);
    rmSync(dir2, { recursive: true, force: true });
  }
});

/* last: it fills the tree with 230 notes, which would push the others out of the virtualized tree */
test("collection: more than 200 hits come in batches of 200 with a continuation", async ({ page }) => {
  await bare(page);
  const big = await create(page, COLLECTION, { name: "Everything tagged bulk", "body.tags": "bulk" });
  const ids: string[] = [];
  for (let i = 0; i < 230; i++) ids.push(await create(page, NOTE, { name: `Bulk ${String(i).padStart(3, "0")}`, "body.text": "b", tags: ["bulk"] }));
  const first = await children(page, big);
  expect(first.nodes).toHaveLength(200);
  expect(first.next).toBe(200);
  const second = await children(page, big, first.next);
  expect(second.nodes).toHaveLength(30);
  expect(second.next).toBeUndefined();
  const keys = new Set([...first.nodes, ...second.nodes].map((n) => n.key));
  expect(keys.size).toBe(230);
  void ids;
});
