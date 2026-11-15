/**
 * Round 2 against the REAL kernel: environments and inheritance, configuration, history, favorites,
 * deleted items, search, audit. Same setup as week1.spec.ts (devhost on a temp dir, browser over
 * WebSocket). Screenshots: docs/screenshots/round2-*.png (light; a few also dark).
 */
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { DEVHOST, OUT, openKernel, rpc, startHost, stopHost, type Host } from "./kernel-host";
import { existsSync } from "node:fs";

test.use({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
test.describe.configure({ mode: "serial" });
test.setTimeout(120_000);

let host: Host;
let base: string;

test.beforeAll(async () => {
  test.skip(!existsSync(DEVHOST), `onedesk-devhost not built at ${DEVHOST}`);
  base = realpathSync(mkdtempSync(path.join(tmpdir(), "od-round2-")));
  host = await startHost(path.join(base, "data"));
});
test.afterAll(async () => {
  if (host) await stopHost(host);
  if (base) rmSync(base, { recursive: true, force: true });
});

const shot = async (page: Page, name: string, theme = "light") => {
  await page.mouse.move(640, 2);
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, `round2-${theme === "light" ? "" : "dark-"}${name}.png`) });
};

const call = <T = unknown>(page: Page, method: string, params: unknown = null) => rpc<T>(page, host, method, params);
type Node = { key: string; label: string };
const children = async (page: Page, tree: string, parent?: string) =>
  (await call<{ nodes: Node[] }>(page, "tree.children", { tree, parent })).nodes;
const nodeId = async (page: Page, tree: string, label: string) => (await children(page, tree)).find((n) => n.label === label)!.key;
const sideTab = (page: Page, name: string) => page.getByRole("navigation", { name: "Views" }).getByRole("button", { name, exact: true });
/** Shows a tree in the side panel; the activity button toggles, so click only when it is not active. */
const showTree = async (page: Page, name: string) => {
  const b = sideTab(page, name);
  if ((await b.getAttribute("aria-pressed")) !== "true") await b.click();
};
const treeItem = (page: Page, name: string) => page.getByRole("treeitem", { name, exact: true });

test("environments: a child inherits and shows where the value comes from", async ({ page }) => {
  await openKernel(page, host);
  const root = await nodeId(page, "env", "Default");
  await call(page, "params.set", { node: root, name: "region", value: "eu" });
  await call(page, "params.set", { node: root, name: "retries", value: "3" });

  await showTree(page, "Environments");
  await treeItem(page, "Default").click(); // the toolbar creates under the selected node
  await page.getByRole("button", { name: "New environment" }).first().click();
  await page.getByRole("textbox", { name: "New name" }).fill("Staging");
  await page.keyboard.press("Enter");
  await expect(treeItem(page, "Staging")).toBeVisible();
  await expect(treeItem(page, "Staging")).toHaveAttribute("aria-level", "2");
  await treeItem(page, "Staging").click();

  // inherited value and where it comes from
  await expect(page.getByRole("textbox", { name: "region", exact: true })).toHaveValue("eu");
  await expect(page.getByText("Inherited from Default").first()).toBeVisible();
  await shot(page, "env-inherited");
});

// FIXME(shell): env-page.tsx sends `basis` as a string (`String(env.data.rev)`) but `ParamSetParams.basis` /
// `ParamNameParams.basis` are numbers, so every override, "keep mine" and "use inherited" from the page fails
// with "The request was malformed" (invalidParams). See round2-tests-done.md, S-B1. Remove `.fixme` when fixed.
test.fixme("environments (UI): override, changed upstream, keep mine, use the inherited value", async ({ page }) => {
  await openKernel(page, host);
  const root = await nodeId(page, "env", "Default");
  await call(page, "params.set", { node: root, name: "region", value: "eu" });
  await showTree(page, "Environments");
  await treeItem(page, "Default").click();
  await page.keyboard.press("ArrowRight");
  await treeItem(page, "Staging").click();
  // override
  const region = page.getByRole("textbox", { name: "region", exact: true });
  await region.fill("us");
  await region.press("Enter");
  await expect(page.getByText("Overrides Default: eu")).toBeVisible();
  await expect(page.getByText("This environment").first()).toBeVisible();

  // the parent changes afterwards → "changed upstream"
  await call(page, "params.set", { node: root, name: "region", value: "ap" });
  await expect(page.getByText("Changed upstream")).toBeVisible();
  await shot(page, "env-changed-upstream");

  // keep mine clears the mark and keeps the override
  await page.getByRole("button", { name: "Keep mine" }).click();
  await expect(page.getByText("Changed upstream")).toHaveCount(0);
  await expect(region).toHaveValue("us");

  // another parent change marks it again; this time use the inherited value
  await call(page, "params.set", { node: root, name: "region", value: "sa" });
  await expect(page.getByText("Changed upstream")).toBeVisible();
  await page.getByRole("button", { name: /Use the inherited value/ }).click();
  await expect(region).toHaveValue("sa");
  await expect(page.getByText("Inherited from Default").first()).toBeVisible();
  await expect(page.getByText("Changed upstream")).toHaveCount(0);
  await shot(page, "env-use-inherited");
});

test("environments (protocol): override, changed upstream, acknowledge, unset", async ({ page }) => {
  await openKernel(page, host);
  const root = await nodeId(page, "env", "Default");
  const kid = (await children(page, "env", root)).find((n) => n.label === "Staging")!.key;
  type P = { name: string; value: string; own: boolean; changedUpstream?: { was: string; now: string }; inherited?: { value: string } };
  const param = async (name: string) => (await call<{ params: P[] }>(page, "params.env", { envId: kid })).params.find((p) => p.name === name)!;
  await call(page, "params.set", { node: root, name: "tier", value: "gold" });
  await call(page, "params.set", { node: kid, name: "tier", value: "silver" });
  expect(await param("tier")).toMatchObject({ value: "silver", own: true, inherited: { value: "gold" } });
  await call(page, "params.set", { node: root, name: "tier", value: "platinum" });
  expect((await param("tier")).changedUpstream).toEqual({ was: "gold", now: "platinum" });
  await call(page, "params.set", { node: root, name: "other", value: "1" }); // another parameter: no false mark
  expect((await param("tier")).changedUpstream).toBeDefined();
  expect((await param("other")).changedUpstream).toBeUndefined();
  await call(page, "params.acknowledge", { node: kid, name: "tier" });
  expect((await param("tier")).changedUpstream).toBeUndefined();
  await call(page, "params.unset", { node: kid, name: "tier" });
  expect(await param("tier")).toMatchObject({ value: "platinum", own: false });
});

async function restart(page: Page) {
  await stopHost(host);
  host = await startHost(path.join(base, "data"));
  await openKernel(page, host, null); // no ?theme: what the kernel stored must decide
}

test("configuration: a parameter edited on the page survives a restart", async ({ page }) => {
  await openKernel(page, host);
  await call(page, "workspace.setConfig", { name: "team.motto", value: "ship it" });
  await showTree(page, "Workspace configuration");
  await treeItem(page, "Workspace").click();
  const field = page.getByRole("textbox", { name: "team.motto", exact: true });
  await expect(field).toHaveValue("ship it");
  await field.fill("ship it twice");
  await field.press("Tab"); // autosave on commit
  await expect.poll(() => call(page, "workspace.getConfig", { name: "team.motto" })).toBe("ship it twice");
  await shot(page, "config-page");

  await restart(page);
  expect(await call(page, "workspace.getConfig", { name: "team.motto" })).toBe("ship it twice");
  await showTree(page, "Workspace configuration");
  await treeItem(page, "Workspace").click();
  await expect(page.getByRole("textbox", { name: "team.motto", exact: true })).toHaveValue("ship it twice");
});

test("language, theme and density are stored in the kernel and survive a restart", async ({ page }) => {
  await openKernel(page, host);
  await page.getByRole("button", { name: "Comfortable", exact: true }).click();
  await expect(page.getByRole("button", { name: "Compact", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Switch light / dark" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "Language" }).click();
  await page.getByRole("menuitem", { name: "简体中文" }).click();
  await expect(page.getByRole("button", { name: "紧凑", exact: true })).toBeVisible();
  await expect.poll(() => call(page, "workspace.getConfig", { name: "ui.language" })).toBe("zh-CN");
  expect(await call(page, "workspace.getConfig", { name: "ui.theme" })).toBe("dark");
  expect(await call(page, "workspace.getConfig", { name: "ui.density" })).toBe("compact");
  await shot(page, "settings-zh-dark-compact", "dark");

  await restart(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByRole("button", { name: "紧凑", exact: true })).toBeVisible();

  // put the defaults back for the tests that follow
  await call(page, "workspace.setConfig", { name: "ui.language", value: "en-US" });
  await call(page, "workspace.setConfig", { name: "ui.theme", value: "light" });
  await call(page, "workspace.setConfig", { name: "ui.density", value: "comfortable" });
});

const NOTE = "org.onedesk.note:note";
async function newNote(page: Page, name: string, text: string) {
  const r = await call<{ page: { target: string; resourceId: string } }>(page, "page.save", { target: `new:${NOTE}`, changes: { name, "body.text": text } });
  return r.page.resourceId;
}

test("favorites: add and remove, shown in the favorites tree", async ({ page }) => {
  await newNote(page, "Fav candidate", "x");
  await openKernel(page, host);
  await showTree(page, "Resources");
  await treeItem(page, "Fav candidate").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Add to favorites" }).click();

  await showTree(page, "Favorites");
  await expect(treeItem(page, "Fav candidate")).toBeVisible();
  await shot(page, "favorites");
  await treeItem(page, "Fav candidate").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Remove from favorites" }).click();
  await expect(treeItem(page, "Fav candidate")).toHaveCount(0);
  await showTree(page, "Resources");
  await expect(treeItem(page, "Fav candidate")).toBeVisible(); // still there, only unstarred
});

test("deleted items: delete, restore, delete again, delete permanently with confirmation", async ({ page }) => {
  const id = await newNote(page, "Doomed note", "bye");
  await openKernel(page, host);
  await showTree(page, "Resources");
  await treeItem(page, "Doomed note").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
  const confirm = page.getByRole("dialog");
  if (await confirm.isVisible().catch(() => false)) await confirm.getByRole("button", { name: /Delete/ }).click();
  await expect(treeItem(page, "Doomed note")).toHaveCount(0);

  await showTree(page, "Deleted");
  await expect(treeItem(page, "Doomed note")).toBeVisible(); // the tree lists deleted items; the page is the grid
  await page.getByRole("button", { name: "Open deleted items" }).click();
  await expect(page.getByRole("button", { name: "Restore", exact: true })).toBeVisible();
  await shot(page, "deleted");
  await page.getByRole("button", { name: "Restore", exact: true }).first().click();
  await showTree(page, "Resources");
  await expect(treeItem(page, "Doomed note")).toBeVisible();

  // delete again, then purge: the confirmation dialog must appear and Cancel keeps it
  await treeItem(page, "Doomed note").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
  if (await confirm.isVisible().catch(() => false)) await confirm.getByRole("button", { name: /Delete/ }).click();
  await showTree(page, "Deleted");
  await page.getByRole("button", { name: "Open deleted items" }).click();
  await page.getByRole("button", { name: /Delete permanently/ }).first().click();
  await expect(page.getByRole("dialog")).toContainText("cannot be undone");
  await shot(page, "deleted-purge-confirm");
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByText("Doomed note").first()).toBeVisible();
  await page.getByRole("button", { name: /Delete permanently/ }).first().click();
  await page.getByRole("dialog").getByRole("button", { name: /Delete permanently/ }).click();
  await expect(page.getByText("Nothing has been deleted")).toBeVisible();
  await expect(treeItem(page, "Doomed note")).toHaveCount(0);
  expect(await call(page, "resource.get", { id })).toBeNull();
});

// FIXME(shell): same cause as above (S-B1): editing the value on the environment page is refused.
test.fixme("history (UI): environment page lists rename and value changes and restores one", async ({ page }) => {
  await openKernel(page, host);
  const root = await nodeId(page, "env", "Default");
  await call(page, "command.execute", { id: "env.newChild", context: { tree: "env", nodeKey: root } });
  const kid = (await children(page, "env", root)).find((n) => n.label === "New environment")!.key;
  await call(page, "tree.rename", { tree: "env", key: kid, name: "History env" });
  await call(page, "params.set", { node: kid, name: "mode", value: "fast" });

  await showTree(page, "Environments");
  await treeItem(page, "Default").click();
  await page.keyboard.press("ArrowRight");
  await treeItem(page, "History env").click();
  const mode = page.getByRole("textbox", { name: "mode", exact: true });
  await expect(mode).toHaveValue("fast");
  await mode.fill("slow");
  await mode.press("Enter");
  const history = page.getByRole("table", { name: "History" });
  await expect(history.locator("tbody tr").first()).toContainText("slow");
  await expect(history.locator("tbody tr").first()).toContainText("fast"); // newest first: before=fast, after=slow
  await expect(history.getByText("New environment").first()).toBeVisible(); // the earlier rename, as before/after
  await shot(page, "history");

  await history.locator("tbody tr").first().getByRole("button", { name: "Restore" }).click();
  await expect(mode).toHaveValue("fast");
  await expect(history.locator("tbody tr").first()).toContainText("restore");
  await shot(page, "history-restored");
});

test("history: a note's rename and body change are listed newest first and can be restored (protocol)", async ({ page }) => {
  const id = await newNote(page, "Draft v1", "first");
  await openKernel(page, host);
  await call(page, "page.save", { target: `resource:${id}`, changes: { "body.text": "second" } });
  await call(page, "tree.rename", { tree: "resources", key: id, name: "Draft v2" });
  const h = await call<{ id: string; field: string; before: string; after: string; op: string }[]>(page, "resource.history", { id });
  expect(h[0]).toMatchObject({ field: "name", before: "Draft v1", after: "Draft v2" });
  expect(h.find((e) => e.field === "body.text")).toMatchObject({ before: "first", after: "second" });
  const bodyEntry = h.find((e) => e.field === "body.text")!;
  await call(page, "resource.restore", { id, entryId: bodyEntry.id });
  const r = await call<{ body: { text: string } }>(page, "resource.get", { id });
  expect(r.body.text).toBe("first");
  const h2 = await call<{ op: string; restoredFrom?: string }[]>(page, "resource.history", { id });
  expect(h2[0]).toMatchObject({ op: "restore", restoredFrom: bodyEntry.id });
});

test("search: finds notes by name, body and a two-character Chinese word; never deleted ones", async ({ page }) => {
  await newNote(page, "Quarterly roadmap", "launch the aurora project");
  await newNote(page, "项目周报", "本周完成");
  const gone = await newNote(page, "Zebra secret plan", "zebra");
  await call(page, "resource.delete", { id: gone });
  await openKernel(page, host);

  const search = async (text: string) => {
    await page.keyboard.press("ControlOrMeta+k");
    const box = page.getByRole("combobox", { name: "Search this workspace" });
    await expect(box).toBeFocused();
    await box.fill(text);
    return box;
  };
  await search("roadmap");
  await expect(page.getByRole("option", { name: /Quarterly roadmap/ })).toBeVisible();
  await shot(page, "search");
  await page.keyboard.press("Escape");

  await search("aurora"); // body text
  await expect(page.getByRole("option", { name: /Quarterly roadmap/ })).toBeVisible();
  await page.keyboard.press("Escape");

  await search("周报"); // two characters: below the trigram minimum
  await expect(page.getByRole("option", { name: /项目周报/ })).toBeVisible();
  await page.getByRole("option", { name: /项目周报/ }).click();
  await expect(ui2.tab(page, "项目周报")).toBeVisible();

  await search("zebra");
  await expect(page.getByRole("option", { name: /Zebra secret plan/ })).toHaveCount(0);
  await page.keyboard.press("Escape");
  const hits = await call<{ title: string }[]>(page, "search.query", { text: "zebra" });
  expect(hits.map((h) => h.title)).not.toContain("Zebra secret plan");
});

const ui2 = { tab: (page: Page, name: string) => page.locator("[data-tab-id]", { hasText: name }) };

test("audit: the page shows what was just done and filters by result", async ({ page }) => {
  await newNote(page, "Audit probe", "x");
  // a refused action: the files plugin may not read outside its (empty) grants
  await call(page, "page.resolve", { target: `node:org.onedesk.files:files/${encodeURIComponent("/etc/hosts")}` }).catch(() => undefined);
  await openKernel(page, host);
  await page.keyboard.press("ControlOrMeta+Shift+p");
  await page.getByPlaceholder("Type a command").fill("audit");
  await page.getByRole("option", { name: "Open audit log" }).click();
  const table = page.getByRole("table").filter({ has: page.getByRole("columnheader", { name: "Operation" }) });
  await expect(table.locator("tbody tr").first()).toBeVisible();

  await expect(table.locator("tbody tr").filter({ hasText: "Audit probe" }).first()).toBeVisible(); // newest rows first
  await shot(page, "audit");

  // filter by result: OK has rows; Denied rows (if the kernel audits the refusal) are all marked Denied
  await page.getByRole("combobox", { name: "Result" }).click();
  await page.getByRole("option", { name: "OK", exact: true }).click();
  await expect(table.locator("tbody tr").first()).toContainText("OK");
  await page.getByRole("combobox", { name: "Result" }).click();
  await page.getByRole("option", { name: "Denied", exact: true }).click();
  const denied = await call<{ result: string }[]>(page, "audit.list", { result: "denied" });
  expect(denied.length).toBeGreaterThan(0); // the refused read was audited
  await expect(table.locator("tbody tr")).toHaveCount(denied.length);
  await expect(table.locator("tbody tr").first()).toContainText("Denied");
  await shot(page, "audit-denied");
});

test("audit: the Contains filter finds a record by the target name", async ({ page }) => {
  await newNote(page, "Findable audit target", "x");
  await openKernel(page, host);
  const rows = await call<{ target: string }[]>(page, "audit.list", { text: "Findable audit target" });
  expect(rows.map((r) => r.target)).toContain("Findable audit target");
  await page.keyboard.press("ControlOrMeta+Shift+p");
  await page.getByPlaceholder("Type a command").fill("audit");
  await page.getByRole("option", { name: "Open audit log" }).click();
  await page.getByRole("textbox", { name: "Contains" }).fill("Findable audit target");
  const table = page.getByRole("table").filter({ has: page.getByRole("columnheader", { name: "Operation" }) });
  await expect(table.locator("tbody tr").first()).toContainText("Findable audit target");
});

test("dark screenshots of the environment page and the audit page", async ({ page }) => {
  await call(page, "workspace.setConfig", { name: "ui.theme", value: "dark" });
  await openKernel(page, host, "dark");
  await showTree(page, "Environments");
  await treeItem(page, "Default").click();
  await page.keyboard.press("ArrowRight");
  await treeItem(page, "Staging").click();
  await expect(page.getByRole("textbox", { name: "region", exact: true })).toBeVisible();
  await shot(page, "env-inherited", "dark");
  await page.keyboard.press("ControlOrMeta+Shift+p");
  await page.getByPlaceholder("Type a command").fill("audit");
  await page.getByRole("option", { name: "Open audit log" }).click();
  await expect(page.getByRole("columnheader", { name: "Operation" })).toBeVisible();
  await shot(page, "audit", "dark");
  await call(page, "workspace.setConfig", { name: "ui.theme", value: "light" });
});

test("note page: the info panel lists the rename and restoring it brings the old name back", async ({ page }) => {
  const id = await newNote(page, "Panel before", "body");
  await call(page, "tree.rename", { tree: "resources", key: id, name: "Panel after" });
  await openKernel(page, host);
  await showTree(page, "Resources");
  await treeItem(page, "Panel after").click();
  await expect(page.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("Panel after");
  await page.getByRole("button", { name: "Show changes" }).click();
  await expect(page.getByText("Panel before → Panel after")).toBeVisible();
  await shot(page, "info-history");
  await page.getByRole("button", { name: "Restore" }).first().click();
  await expect(page.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("Panel before");
  await expect(treeItem(page, "Panel before")).toBeVisible();
  await shot(page, "info-history-restored");
});
