/**
 * D473 against the REAL kernel (devhost on a temp dir): resource trees of the user's own and default environments.
 *  - installed: one tree, "Resources", as before;
 *  - "New resource tree" in the activity bar adds one; it is named, described and given an icon in its info panel;
 *  - what is created in its view goes into it; a resource moves to another tree from its menu;
 *  - a default environment is set on a tree, a group or a resource (nearest wins); a tab nobody chose an environment for
 *    opens in it, one chosen by hand keeps its own.
 * Screenshots (not checked in): test-results/screenshots/resource-trees-*.png.
 */
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { DEVHOST, OUT, openKernel, rpc, startHost, stopHost, type Host } from "./kernel-host";

test.use({ viewport: { width: 1440, height: 900 }, locale: "en-US" });
test.describe.configure({ mode: "serial" });
test.setTimeout(120_000);

const NOTE = "org.onedesk.note:note";
let host: Host;
let base: string;

test.beforeAll(async () => {
  test.skip(!existsSync(DEVHOST), `onedesk-devhost not built at ${DEVHOST}`);
  base = realpathSync(mkdtempSync(path.join(tmpdir(), "od-trees-")));
  host = await startHost(path.join(base, "data"));
});

test.afterAll(async () => {
  if (host) await stopHost(host);
  if (base) rmSync(base, { recursive: true, force: true });
});

const call = <T = unknown>(page: Page, method: string, params: unknown = null) => rpc<T>(page, host, method, params);
type Node = { key: string; label: string };
const children = async (page: Page, tree: string, parent?: string) => (await call<{ nodes: Node[] }>(page, "tree.children", { tree, parent })).nodes;
const views = (page: Page) => page.getByRole("navigation", { name: "Views" });
const info = (page: Page) => page.getByRole("complementary", { name: "Info" });
const envSelect = (page: Page) => page.getByRole("combobox", { name: "Environment of this tab" });

test("installed there is one tree, Resources; a new one is added from the activity bar and named in its info panel", async ({ page }) => {
  await openKernel(page, host);
  type T = { id: string; title: string };
  const resourceViews = async () => (await call<T[]>(page, "tree.list")).filter((t) => t.id === "resources" || t.id.startsWith("resources."));
  expect((await resourceViews()).map((t) => t.title)).toEqual(["resources"]);
  await expect(views(page).getByRole("button", { name: "Resources", exact: true })).toBeVisible();
  await views(page).getByRole("button", { name: "New resource tree" }).click();
  // Its page opens with the info panel: named there, the activity bar follows.
  await expect(info(page)).toBeVisible();
  const name = info(page).getByRole("textbox", { name: "Name" });
  await expect(name).toHaveValue("New tree");
  await name.fill("Data center");
  await name.press("Enter");
  await info(page).getByRole("textbox", { name: "Description" }).fill("Servers and databases of the data center");
  await info(page).getByRole("textbox", { name: "Description" }).blur();
  await info(page).getByRole("button", { name: "Choose an icon" }).click();
  await page.getByRole("button", { name: "server", exact: true }).click();
  await expect(views(page).getByRole("button", { name: "Data center", exact: true })).toBeVisible();
  // Its view is the one shown beside it.
  await expect(views(page).getByRole("button", { name: "Data center", exact: true })).toHaveAttribute("aria-pressed", "true");
  const list = await resourceViews();
  expect(list.map((t) => t.title)).toEqual(["resources", "Data center"]);
  expect((await call<Array<{ id: string; icon: string }>>(page, "tree.list")).find((t) => t.id === list[1]!.id)?.icon).toBe("server");
  await page.screenshot({ path: path.join(OUT, "resource-trees-new.png") });
});

test("what is created in a tree's view goes into it; a resource moves to another tree from its menu", async ({ page }) => {
  await openKernel(page, host);
  const view = (await call<Array<{ id: string; title: string }>>(page, "tree.list")).find((t) => t.title === "Data center")!.id;
  await views(page).getByRole("button", { name: "Data center", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Data center" }).first()).toBeVisible();
  // A note made from this view's "New" is saved into this tree.
  await page.getByRole("button", { name: "New", exact: true }).first().click();
  await page.getByRole("menuitem", { name: "Note", exact: true }).click();
  await info(page).getByRole("textbox", { name: "Name" }).fill("Runbook");
  await page.keyboard.press("ControlOrMeta+s");
  await expect(page.getByRole("heading", { level: 1, name: "Runbook" })).toBeVisible();
  await expect.poll(async () => (await children(page, view)).map((n) => n.label)).toEqual(["Runbook"]);
  expect((await children(page, "resources")).map((n) => n.label)).not.toContain("Runbook");
  // Location says the tree.
  await expect(info(page).getByText("Data center", { exact: true })).toBeVisible();
  // Another note in Resources, moved here from its menu.
  await call(page, "page.save", { target: `new:${NOTE}`, changes: { name: "Moving note", "body.text": "" } });
  await views(page).getByRole("button", { name: "Resources", exact: true }).click();
  await page.getByRole("treeitem", { name: "Moving note", exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to another tree…" }).click();
  const dialog = page.getByRole("alertdialog").or(page.getByRole("dialog"));
  await expect(dialog).toContainText("Move it to which tree?");
  await page.screenshot({ path: path.join(OUT, "resource-trees-move.png") });
  await dialog.getByRole("button", { name: "Data center" }).click();
  await expect.poll(async () => (await children(page, view)).map((n) => n.label)).toEqual(["Runbook", "Moving note"]);
  await expect(page.getByRole("treeitem", { name: "Moving note", exact: true })).toBeVisible();
});

test("a default environment set on the tree, a group or the resource: the nearest one opens the tab; one picked by hand stays", async ({ page }) => {
  await openKernel(page, host);
  const def = (await children(page, "env"))[0]!.key;
  for (const name of ["Production", "Testing"]) await call(page, "command.execute", { id: "env.newChild", context: { tree: "env", nodeKey: def, args: { name } } });
  const envs = await children(page, "env", def);
  const prod = envs.find((n) => n.label === "Production")!.key;
  const testing = envs.find((n) => n.label === "Testing")!.key;
  const view = (await call<Array<{ id: string; title: string }>>(page, "tree.list")).find((t) => t.title === "Data center")!.id;
  const runbook = (await children(page, view)).find((n) => n.label === "Runbook")!.key;
  // The tree's info panel: Production.
  await views(page).getByRole("button", { name: "Data center", exact: true }).click();
  await page.getByRole("button", { name: "Tree information" }).click();
  await info(page).getByRole("combobox", { name: "Default environment" }).click();
  await page.getByRole("option", { name: "Production" }).click();
  await expect.poll(async () => (await call<{ defaultEnv?: string }>(page, "resource.get", { id: view.replace("resources.", "") })).defaultEnv).toBe(prod);
  // The note opens in Production; its info panel says where that comes from.
  await page.getByRole("treeitem", { name: "Runbook", exact: true }).click();
  await expect(envSelect(page)).toContainText("Production");
  await expect(info(page).getByRole("combobox", { name: "Default environment" })).toContainText("As above: Production (from Data center)");
  await page.screenshot({ path: path.join(OUT, "resource-trees-env.png") });
  // Its own: Testing, nearer than the tree's. A new tab of it opens in Testing.
  await info(page).getByRole("combobox", { name: "Default environment" }).click();
  await page.getByRole("option", { name: "Testing" }).click();
  await expect.poll(async () => (await call<{ defaultEnv?: string }>(page, "resource.get", { id: runbook })).defaultEnv).toBe(testing);
  await page.keyboard.press("ControlOrMeta+w");
  await page.getByRole("treeitem", { name: "Runbook", exact: true }).click();
  await expect(envSelect(page)).toContainText("Testing");
  // Picked by hand on the tab: kept.
  await envSelect(page).click();
  await page.getByRole("option", { name: /^\s*Default$/ }).click();
  await expect(envSelect(page)).toContainText("Default");
  await page.getByRole("tab", { name: /Data center/ }).first().click();
  await page.getByRole("tab", { name: /Runbook/ }).first().click();
  await expect(envSelect(page)).toContainText("Default");
});
