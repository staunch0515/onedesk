/**
 * Round 3 against the REAL kernel: the sample plugin end to end (page, parameters, runs, progress,
 * cancel, failure, history, run records), plugin state and settings, command palette.
 * Same setup as week1/round2 specs. Screenshots: docs/screenshots/round3-*.png.
 */
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { DEVHOST, OUT, openKernel, rpc, startHost, stopHost, type Host } from "./kernel-host";

test.use({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
test.describe.configure({ mode: "serial" });
test.setTimeout(120_000);

let host: Host;
let base: string;

test.beforeAll(async () => {
  test.skip(!existsSync(DEVHOST), `onedesk-devhost not built at ${DEVHOST}`);
  base = realpathSync(mkdtempSync(path.join(tmpdir(), "od-round3-")));
  host = await startHost(path.join(base, "data"));
});
test.afterAll(async () => {
  if (host) await stopHost(host);
  if (base) rmSync(base, { recursive: true, force: true });
});

const SAMPLE = "org.onedesk.sample:query";
const shot = async (page: Page, name: string) => {
  await page.mouse.move(640, 2);
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, `round3-${name}.png`) });
};
const call = <T = unknown>(page: Page, method: string, params: unknown = null) => rpc<T>(page, host, method, params);
const tab = (page: Page, name: string) => page.locator("[data-tab-id]", { hasText: name });
const sideTab = (page: Page, name: string) => page.getByRole("navigation", { name: "Views" }).getByRole("button", { name, exact: true });
const showTree = async (page: Page, name: string) => {
  const b = sideTab(page, name);
  if ((await b.getAttribute("aria-pressed")) !== "true") await b.click();
};
const treeItem = (page: Page, name: string | RegExp) => page.getByRole("treeitem", { name, exact: typeof name === "string" });
const editor = (page: Page) => page.getByRole("textbox", { name: "Text", exact: true });

/** Creates a saved sample query through the protocol (fast, no UI dependency). */
async function newQuery(page: Page, name: string, text: string) {
  const r = await call<{ page: { resourceId: string } }>(page, "page.save", { target: `new:${SAMPLE}`, changes: { name, "body.text": text } });
  return r.page.resourceId;
}
async function openQuery(page: Page, name: string) {
  await showTree(page, "Resources");
  await treeItem(page, name).click();
  await expect(editor(page)).toBeVisible();
}
const run = (page: Page) => page.getByRole("button", { name: "Run", exact: true });
const resultTable = (page: Page) => page.getByRole("table", { name: "Result" });

test("new sample query from the New menu; typing :name adds a parameter field", async ({ page }) => {
  await openKernel(page, host);
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByRole("menuitem", { name: "Sample query" }).click();
  await expect(editor(page)).toBeVisible();
  await expect(page.getByRole("button", { name: "Save & run" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Explain", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "More actions" }).click(); // event actions live in the overflow menu
  await expect(page.getByRole("menuitem", { name: "Tidy" })).toBeVisible();
  await page.keyboard.press("Escape");
  await editor(page).click();
  await page.keyboard.type("select * from orders where user_id = :user_id");
  await expect(page.getByRole("textbox", { name: "user_id", exact: true })).toBeVisible({ timeout: 5000 });
  await shot(page, "new-query-params");
  await page.keyboard.type(" and created_time > :start_time");
  await expect(page.getByRole("textbox", { name: "start_time", exact: true })).toBeVisible({ timeout: 5000 });
});

test("run: the table appears; status bar and task panel show the run", async ({ page }) => {
  await newQuery(page, "Orders", "select * from orders where user_id = :user_id");
  await openKernel(page, host);
  await openQuery(page, "Orders");
  await page.getByRole("textbox", { name: "user_id", exact: true }).fill("7");
  await run(page).click();
  await expect(resultTable(page).locator("tbody tr").first()).toBeVisible({ timeout: 15_000 });
  await expect(resultTable(page).getByRole("columnheader", { name: "customer" })).toBeVisible();
  await shot(page, "run-table");
  await expect(page.getByRole("status").getByText(/#1/)).toBeVisible();
  await page.getByRole("button", { name: /Tasks: \d+/ }).click();
  await expect(page.getByRole("region", { name: "Tasks" })).toContainText("Orders");
  await shot(page, "tasks-panel");
});

test("a slow run shows progress and can be cancelled; the cancel is kept in the history", async ({ page }) => {
  await newQuery(page, "Slow one", "select 1 !slow");
  await openKernel(page, host);
  await openQuery(page, "Slow one");
  await run(page).click();
  await expect(page.getByText(/Working… \d+\/20/).first()).toBeVisible({ timeout: 10_000 });
  await shot(page, "run-progress");
  await expect(page.getByRole("status").getByText(/Working… \d+\/20/)).toBeVisible(); // status bar summary
  await page.getByRole("button", { name: "Cancel run" }).click();
  await expect(page.getByText("This run was cancelled")).toBeVisible();
  await shot(page, "run-cancelled");
  await page.getByRole("tab", { name: "History" }).click();
  await expect(page.getByRole("table", { name: "History" }).locator("tbody tr").first()).toContainText(/Cancelled/i);
});

test("a failing run keeps its reason in the result area", async ({ page }) => {
  await newQuery(page, "Broken", "select 1 !fail");
  await openKernel(page, host);
  await openQuery(page, "Broken");
  await run(page).click();
  await expect(page.getByText(/this run fails on purpose/)).toBeVisible({ timeout: 15_000 });
  await shot(page, "run-failed");
});

test("the page refreshes when a run ends and shows the stored last-run summary", async ({ page }) => {
  await newQuery(page, "Refresh me", "select 1");
  await openKernel(page, host);
  await openQuery(page, "Refresh me");
  // (the plugin keeps one summary for all its resources, so earlier tests may have left one: compare with this run)
  await run(page).click();
  await expect(resultTable(page).locator("tbody tr").first()).toBeVisible({ timeout: 15_000 });
  const latest = (await call<{ id: string; seq: number }[]>(page, "run.tasks")).sort((a, b) => b.seq - a.seq)[0]!;
  const full = await call<{ summary: { rows: number }; output: { total: number } }>(page, "run.get", { id: latest.id });
  await expect(page.getByText(`Last run: ${full.summary.rows} of ${full.output.total} rows`)).toBeVisible();
});

test("after reopening the page the last-run summary is there", async ({ page }) => {
  await openKernel(page, host);
  await openQuery(page, "Orders");
  await expect(page.getByText(/Last run: \d+ of \d+ rows/)).toBeVisible();
});

test("environment values: the strip shows the value and where it comes from; Explain lists them", async ({ page }) => {
  await newQuery(page, "Explainer", "select :tenant_id, :channel");
  await openKernel(page, host);
  const env = (await call<{ nodes: { key: string; label: string }[] }>(page, "tree.children", { tree: "env" })).nodes.find((n) => n.label === "Default")!.key;
  await call(page, "params.set", { node: env, name: "tenant_id", value: "42" });
  await openKernel(page, host);
  await openQuery(page, "Explainer");
  const tenant = page.getByRole("textbox", { name: "tenant_id", exact: true });
  await expect(tenant).toBeVisible();
  await expect(tenant).toHaveAttribute("placeholder", /42/);
  await expect(page.getByText("Default").first()).toBeVisible(); // the source name next to it
  await shot(page, "param-from-env");
  await page.getByRole("textbox", { name: "channel", exact: true }).fill("web");
  await page.getByRole("button", { name: "Explain", exact: true }).click();
  const text = page.getByRole("region", { name: "Result area" });
  await expect(text).toContainText("tenant_id = 42 (from environment Default)", { timeout: 15_000 });
  await expect(text).toContainText("channel = web (entered here)");
  await shot(page, "explain");
});

test("Tidy changes the unsaved content; the tab shows it is unsaved", async ({ page }) => {
  await newQuery(page, "Messy", "x");
  await openKernel(page, host);
  await openQuery(page, "Messy");
  await editor(page).fill("select a from b where c = 1");
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Tidy" }).click();
  await expect(editor(page)).toHaveValue("SELECT a FROM b WHERE c = 1");
  await expect(tab(page, "Messy")).toHaveClass(/od-tab--dirty/);
  await shot(page, "tidy");
});

test("Final text tab, history entry opens that run read only, run records tree", async ({ page }) => {
  await newQuery(page, "Replay", "select * from t where id = :item_id");
  await openKernel(page, host);
  await openQuery(page, "Replay");
  await page.getByRole("textbox", { name: "item_id", exact: true }).fill("99");
  await run(page).click();
  await expect(resultTable(page).locator("tbody tr").first()).toBeVisible({ timeout: 15_000 });

  await page.getByRole("tab", { name: "Final text" }).click();
  await expect(page.getByRole("textbox", { name: "final" })).toHaveValue("select * from t where id = 99");
  await shot(page, "final-text");

  await page.getByRole("tab", { name: "History" }).click();
  const history = page.getByRole("table", { name: "History" });
  await expect(history.locator("tbody tr")).toHaveCount(1);
  await shot(page, "history-tab");
  // change the saved text so the old run proves it shows its own snapshot
  await editor(page).fill("select 'changed later'");
  await page.keyboard.press("Meta+s");
  await history.locator("tbody tr").first().click();
  await expect(tab(page, "Replay")).toHaveCount(2); // a second tab: the run's page
  await expect(editor(page)).toHaveValue("select * from t where id = :item_id");
  await expect(editor(page)).not.toBeEditable();
  await shot(page, "run-tab-readonly");

  await showTree(page, "Run records");
  await expect(treeItem(page, /#\d+/).first()).toBeVisible();
  await shot(page, "run-records-tree");
});

const openPlugin = async (page: Page, name: string) => {
  await showTree(page, "Plugins");
  await treeItem(page, new RegExp(`^${name} \\d`)).click(); // the node label carries the version
};
const enabledSwitch = (page: Page) => page.getByRole("switch", { name: "Enabled in this workspace" });

test("plugin tree and page: disable greys the resources and refuses work, enable restores", async ({ page }) => {
  await newQuery(page, "Plug target", "select 1");
  await openKernel(page, host);
  await showTree(page, "Plugins");
  for (const name of ["Sample", "Notes", "Files"]) await expect(treeItem(page, new RegExp(`^${name} \\d`))).toBeVisible();
  await shot(page, "plugin-tree");
  await openPlugin(page, "Sample");
  await expect(enabledSwitch(page)).toBeChecked();
  await shot(page, "plugin-page");

  await enabledSwitch(page).click();
  await expect(enabledSwitch(page)).not.toBeChecked();
  await showTree(page, "Resources");
  await expect(page.locator('[data-tree-key]', { hasText: "Plug target" }).first()).toHaveAttribute("data-state", "disabled");
  await treeItem(page, "Plug target").click(); // greyed but still openable
  await expect(page.getByText(/disabled/i).first()).toBeVisible(); // the page says the plugin is disabled
  await shot(page, "plugin-disabled-page");

  // refused: a run and a save of a sample resource, and the New menu has no sample item
  const id = (await call<{ nodes: { key: string; label: string }[] }>(page, "tree.children", { tree: "resources" })).nodes.find((n) => n.label === "Plug target")!.key;
  const runId = await call<string>(page, "run.start", { action: "run", resourceId: id, target: `resource:${id}`, tabId: "x", input: { "body.text": "select 1" }, params: {} });
  await expect.poll(async () => (await call<{ status: string; error?: { code: string } }>(page, "run.get", { id: runId }))?.error?.code).toBe("pluginDisabled");
  await expect(call(page, "page.save", { target: `resource:${id}`, changes: { "body.text": "nope" } })).rejects.toThrow(/denied|pluginDisabled/);
  const items = await call<{ id: string }[]>(page, "command.newItems");
  expect(items.map((i) => i.id)).not.toContain(`new:${SAMPLE}`);

  await openPlugin(page, "Sample"); // the greyed plugin node can still be opened
  await enabledSwitch(page).click();
  await expect(enabledSwitch(page)).toBeChecked();
  await showTree(page, "Resources");
  await expect(page.locator('[data-tree-key]', { hasText: "Plug target" }).first()).toHaveAttribute("data-state", "ok");
  await openQuery(page, "Plug target");
  await shot(page, "plugin-enabled-again");
});

test("plugin setting rowLimit changes the number of rows a run returns", async ({ page }) => {
  await newQuery(page, "Limited", "select :user_id");
  await openKernel(page, host);
  await openPlugin(page, "Sample");
  const limit = page.getByRole("textbox", { name: "Row limit" }).or(page.getByRole("spinbutton", { name: "Row limit" }));
  await limit.fill("3");
  await limit.press("Enter");
  await expect.poll(async () => (await call<{ settings: { name: string; value: string }[] }>(page, "plugin.get", { plugin: "org.onedesk.sample" })).settings.find((s) => s.name === "rowLimit")?.value).toBe("3");
  await shot(page, "plugin-settings");
  await openQuery(page, "Limited");
  await page.getByRole("textbox", { name: "user_id", exact: true }).fill("7");
  await run(page).click();
  await expect(resultTable(page).locator("tbody tr")).toHaveCount(3, { timeout: 15_000 });
  await call(page, "plugin.setSetting", { plugin: "org.onedesk.sample", name: "rowLimit", value: "200" });
});

test("plugin page lists the granted folders and removes one", async ({ page }) => {
  const dir = path.join(base, "granted");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(dir, { recursive: true });
  await openKernel(page, host);
  await call(page, "plugin.grantFolder", { plugin: "org.onedesk.files", path: dir });
  await openPlugin(page, "Files");
  await expect(page.getByText(dir)).toBeVisible();
  await shot(page, "plugin-folders");
  // (the versions table has Remove buttons too: take the one in the same row as the folder path)
  await page.getByText(dir).locator("xpath=ancestor::*[.//button[normalize-space()='Remove']][1]").getByRole("button", { name: "Remove" }).click();
  await expect(page.getByText("No folder granted yet.")).toBeVisible();
  expect((await call<{ folders: string[] }>(page, "plugin.grants", { plugin: "org.onedesk.files" })).folders).toEqual([]);
});

test("command palette lists a kernel command and a plugin item and runs them", async ({ page }) => {
  await openKernel(page, host);
  await page.keyboard.press("ControlOrMeta+Shift+p");
  const box = page.getByPlaceholder("Type a command");
  await expect(box).toBeVisible();
  await expect(page.getByRole("option", { name: "New group" }).first()).toBeVisible(); // kernel command
  await expect(page.getByRole("option", { name: /Sample query/ }).first()).toBeVisible(); // from the sample plugin's menus.new
  await expect(page.getByRole("option", { name: /Duplicate/ })).toHaveCount(0); // plugin commands only when the manifest says palette: true
  await shot(page, "palette");
  await box.fill("New group");
  await page.getByRole("option", { name: "New group" }).first().click();
  await showTree(page, "Resources");
  await expect(treeItem(page, /^New group/).first()).toBeVisible();
  await page.getByRole("textbox", { name: "New name" }).press("Enter"); // the command starts an inline rename

  await page.keyboard.press("ControlOrMeta+Shift+p");
  await page.getByPlaceholder("Type a command").fill("Sample query");
  await page.getByRole("option", { name: /Sample query/ }).first().click();
  await expect(tab(page, "Untitled sample query")).toBeVisible();
});

test("running directly on an unsaved new page works", async ({ page }) => {
  await openKernel(page, host);
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByRole("menuitem", { name: "Sample query" }).click();
  await editor(page).fill("select :n_id");
  await page.getByRole("textbox", { name: "n_id", exact: true }).fill("5");
  await run(page).click();
  // the run itself succeeds without saving first: the status bar shows it, and it is in the kernel's records
  await expect(page.getByRole("status").getByText(/#\d+ · \d+ rows/)).toBeVisible({ timeout: 15_000 });
  await shot(page, "run-unsaved-new-page");
  const runs = await call<{ status: string; params: Record<string, string> }[]>(page, "run.tasks");
  expect(runs.some((r) => r.status === "success" && r.params.n_id === "5")).toBe(true);
});

test("running on an unsaved new page shows the result table", async ({ page }) => {
  await openKernel(page, host);
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByRole("menuitem", { name: "Sample query" }).click();
  await editor(page).fill("select 1");
  await run(page).click();
  await expect(resultTable(page).locator("tbody tr").first()).toBeVisible({ timeout: 15_000 });
});

test("run history survives a restart of the kernel", async ({ page }) => {
  await openKernel(page, host);
  const before = await call<{ id: string }[]>(page, "run.tasks");
  await stopHost(host);
  host = await startHost(path.join(base, "data"));
  await openKernel(page, host);
  await showTree(page, "Run records");
  await expect(treeItem(page, /#\d+/).first()).toBeVisible();
  const under = async (parent: string) => (await call<{ nodes: { label: string }[] }>(page, "tree.children", { tree: "runs", parent })).nodes.length;
  expect((await under("@runs:recent")) + (await under("@runs:saved"))).toBeGreaterThanOrEqual(5);
  expect(before).toBeDefined();
  await openQuery(page, "Replay");
  await page.getByRole("tab", { name: "History" }).click();
  await expect(page.getByRole("table", { name: "History" }).locator("tbody tr").first()).toBeVisible();
  await shot(page, "history-after-restart");
});
