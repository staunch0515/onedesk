/**
 * Workbench prototype (stage 0): click-through checks against the mock kernel, plus the screenshots
 * in docs/screenshots/workbench-*.png. Run only this file:
 *   E2E_PORT=1432 pnpm exec playwright test e2e/workbench.spec.ts
 */
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

const OUT = path.resolve(import.meta.dirname, "../docs/screenshots");
const EXTRA = process.env.WB_SHOT_DIR; // optional: also save 1600×1000 shots here for review

const tab = (page: Page, name: string) => page.locator("[data-tab-id]", { hasText: name });
const node = (page: Page, key: string) => page.locator(`[data-tree-key="${key}"]`);
const activity = (page: Page, name: string) => page.getByRole("navigation", { name: "Views" }).getByRole("button", { name, exact: true });

async function open(page: Page, query = "") {
  await page.goto(`/workbench.html?reset&quiet${query}`);
  await expect(tab(page, "今日订单汇总")).toBeVisible();
  // Drop ?reset so a later reload restores instead of resetting.
  await page.evaluate(() => history.replaceState(null, "", "/workbench.html"));
}

async function shot(page: Page, name: string) {
  await page.mouse.move(640, 2);
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, `workbench-${name}.png`) });
}

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, hold?: () => Promise<void>) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 8, from.y + 8, { steps: 2 });
  await page.mouse.move(to.x, to.y, { steps: 8 });
  if (hold) await hold();
  await page.mouse.up();
}

const center = async (_page: Page, locator: ReturnType<Page["locator"]>) => {
  const box = (await locator.boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, box };
};

async function runTodayOrders(page: Page, run = "Run", result = "Result") {
  await page.getByRole("textbox", { name: "start_time", exact: true }).fill("2026-11-14T00:00");
  await page.getByRole("button", { name: run, exact: true }).click();
  await expect(page.getByRole("table", { name: result }).locator("tbody tr").first()).toBeVisible({ timeout: 10_000 });
}

test.use({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
// The fake runs take real seconds; leave room on a busy machine.
test.setTimeout(120_000);

for (const theme of ["light", "dark"] as const) {
  test.describe(`screenshots ${theme}`, () => {
    test("sql page", async ({ page }) => {
      await open(page, `&theme=${theme}`);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await runTodayOrders(page);
      await page.getByRole("columnheader", { name: "amount" }).click();
      await page.getByRole("columnheader", { name: "amount" }).click();
      await expect(page.getByRole("columnheader", { name: "amount" })).toHaveAttribute("aria-sort", "descending");
      await shot(page, `${theme}-sql`);
      if (EXTRA) {
        await page.setViewportSize({ width: 1600, height: 1000 });
        await page.waitForTimeout(300);
        await page.screenshot({ path: path.join(EXTRA, `wide-${theme}-sql.png`) });
      }
    });

    test("environment page", async ({ page }) => {
      await open(page, `&theme=${theme}`);
      await tab(page, "正式 Production").click();
      await expect(page.getByRole("table", { name: "Parameters" })).toBeVisible();
      await expect(page.getByText("Changed upstream")).toBeVisible();
      await activity(page, "Environments").click();
      await expect(node(page, "env-prod")).toBeVisible();
      await shot(page, `${theme}-env`);
      if (EXTRA) {
        await page.setViewportSize({ width: 1600, height: 1000 });
        await page.waitForTimeout(300);
        await page.screenshot({ path: path.join(EXTRA, `wide-${theme}-env.png`) });
      }
    });

    test("plugin page", async ({ page }) => {
      await open(page, `&theme=${theme}`);
      await tab(page, "SQL").click();
      await expect(page.getByRole("table", { name: "Versions" })).toBeVisible();
      await activity(page, "Plugins").click();
      await expect(node(page, "org.onedesk.mongo")).toBeVisible();
      await shot(page, `${theme}-plugin`);
      if (EXTRA) {
        await page.setViewportSize({ width: 1600, height: 1000 });
        await page.waitForTimeout(300);
        await page.screenshot({ path: path.join(EXTRA, `wide-${theme}-plugin.png`) });
      }
    });

    test("tree states and context menu", async ({ page }) => {
      await open(page, `&theme=${theme}`);
      await page.getByRole("button", { name: "Expand all" }).click();
      await expect(node(page, "h-health")).toBeVisible();
      await node(page, "q-revenue").click({ button: "right" });
      await expect(page.getByRole("menuitem", { name: "Rename" })).toBeVisible();
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(OUT, `workbench-${theme}-tree-menu.png`) });
    });

    test("task panel", async ({ page }) => {
      await open(page, `&theme=${theme}`);
      await runTodayOrders(page);
      await node(page, "g-ops").click();
      await node(page, "q-export").click();
      await page.getByRole("textbox", { name: "start_date", exact: true }).fill("2026-11-01");
      await page.getByRole("button", { name: "Run", exact: true }).click();
      await page.getByRole("button", { name: "New", exact: true }).click();
      await page.getByRole("menuitem", { name: "Import folder…" }).click();
      await expect(page.getByRole("region", { name: "Tasks" })).toBeVisible();
      await expect(page.getByRole("region", { name: "Tasks" }).getByText(/Imported \d+ \/ 212 files/)).toBeVisible({ timeout: 10_000 });
      await shot(page, `${theme}-tasks`);
    });
  });
}

test.describe("behaviour", () => {
  test.beforeEach(async ({ page }) => {
    await open(page);
  });

  test("typing :name adds a parameter field; tab shows the unsaved dot; save clears it", async ({ page }) => {
    const editor = page.getByRole("textbox", { name: "SQL" });
    await editor.click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type("  AND o.status = :order_status");
    await expect(page.getByRole("textbox", { name: "order_status", exact: true })).toBeVisible({ timeout: 2000 });
    await expect(tab(page, "今日订单汇总")).toHaveClass(/od-tab--dirty/);
    await page.keyboard.press("ControlOrMeta+s");
    await expect(tab(page, "今日订单汇总")).not.toHaveClass(/od-tab--dirty/);
    await expect(page.getByRole("textbox", { name: "order_status", exact: true })).toBeVisible();
  });

  test("a failing query leaves the error in the result area", async ({ page }) => {
    await node(page, "q-refund-recon").click();
    await page.getByRole("textbox", { name: "start_date", exact: true }).fill("2026-11-01");
    await page.getByRole("button", { name: "Run", exact: true }).click();
    const error = page.getByText("Table 'shop.legacy_orders_2019' doesn't exist").first();
    await expect(error).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(4500);
    await expect(error).toBeVisible();
  });

  test("history row opens that run in a new tab; sent SQL has the values filled in", async ({ page }) => {
    await page.getByRole("tab", { name: "History" }).click();
    const rows = page.getByRole("table", { name: "History" }).locator("tbody tr");
    await expect(rows.first()).toBeVisible();
    const count = await page.locator("[data-tab-id]").count();
    await rows.first().click();
    await expect(page.locator("[data-tab-id]")).toHaveCount(count + 1);
    await expect(page.getByText("Reuse parameters")).toBeVisible();
    await page.getByRole("tab", { name: "Sent SQL" }).click();
    await expect(page.getByRole("textbox", { name: "sent" })).toHaveValue(/tenant_id = \d+/);
  });

  test("tree: drag onto a group moves the node; an invalid target shows the uniform hint", async ({ page }) => {
    // A group cannot go into its own child.
    const parent = await center(page, node(page, "g-orders"));
    const child = await center(page, node(page, "g-orders-daily"));
    await drag(page, parent, { x: child.x, y: child.y }, async () => {
      await expect(page.getByText("Cannot drop here")).toBeVisible();
      await expect(node(page, "g-orders-daily")).toHaveClass(/od-tree__row--drop-denied/);
    });
    await expect(node(page, "g-orders")).toHaveAttribute("aria-level", "1");
    await expect(page.getByText("Cannot drop here")).toBeHidden();
    // A query dropped on another group moves there.
    const source = await center(page, node(page, "q-orders-overdue"));
    const group = await center(page, node(page, "g-users"));
    await drag(page, source, { x: group.x, y: group.y });
    await expect(node(page, "q-orders-overdue")).toHaveAttribute("aria-level", "2");
    await expect(node(page, "q-orders-overdue")).toBeVisible();
  });

  test("tree: hover does not move anything; collapse state survives a reload; filter; rename", async ({ page }) => {
    const before = await node(page, "g-users").boundingBox();
    await node(page, "q-orders-today").hover();
    expect(await node(page, "g-users").boundingBox()).toEqual(before);
    await node(page, "g-finance").click();
    await expect(node(page, "q-invoices")).toBeVisible();
    await page.waitForTimeout(400);
    await page.reload();
    await expect(node(page, "q-invoices")).toBeVisible();
    await page.getByRole("textbox", { name: "Filter by name" }).fill("lag");
    await expect(node(page, "q-repl")).toBeVisible();
    await expect(node(page, "q-invoices")).toBeHidden();
    await page.getByRole("textbox", { name: "Filter by name" }).fill("");
    await node(page, "q-invoices").click();
    await tab(page, "今日订单汇总").click();
    await node(page, "q-invoices").click({ button: "right" });
    await page.getByRole("menuitem", { name: "Rename" }).click();
    await page.getByRole("textbox", { name: "New name" }).fill("发票明细 v2");
    await page.keyboard.press("Enter");
    await expect(node(page, "q-invoices")).toContainText("发票明细 v2");
    await expect(tab(page, "发票明细 v2")).toBeVisible();
  });

  test("tabs: pin, reorder by drag, close all keeps pinned, restored after reload", async ({ page }) => {
    await tab(page, "SQL").click({ button: "right" });
    await page.getByRole("menuitem", { name: "Pin", exact: true }).click();
    await expect(page.locator("[data-tab-id]").first()).toHaveClass(/od-tab--pinned/);
    const from = await center(page, tab(page, "值班手册"));
    const to = await center(page, tab(page, "今日订单汇总"));
    await drag(page, from, { x: to.box.x + 6, y: to.y });
    await expect(page.locator("[data-tab-id]").nth(1)).toContainText("值班手册");
    await page.waitForTimeout(400);
    await page.reload();
    await expect(page.locator("[data-tab-id]").nth(1)).toContainText("值班手册");
    await expect(page.locator("[data-tab-id]")).toHaveCount(4);
    await page.getByRole("button", { name: "Close all tabs" }).click();
    await expect(page.locator("[data-tab-id]")).toHaveCount(1);
    await expect(page.locator("[data-tab-id]").first()).toHaveClass(/od-tab--pinned/);
  });

  test("closing a tab with unsaved changes asks first", async ({ page }) => {
    await page.getByRole("textbox", { name: "SQL" }).click();
    await page.keyboard.type("-- edit\n");
    await tab(page, "今日订单汇总").getByRole("button").click();
    await expect(page.getByRole("dialog")).toContainText("unsaved changes");
    await page.getByRole("button", { name: "Don't save" }).click();
    await expect(tab(page, "今日订单汇总")).toHaveCount(0);
  });

  test("splitters: sizes change by drag and are remembered", async ({ page }) => {
    const side = page.getByRole("separator", { name: "Resize side panel" });
    const s = await center(page, side);
    await drag(page, s, { x: s.x + 80, y: s.y });
    const result = page.getByRole("separator", { name: "Resize result area" });
    const r = await center(page, result);
    await drag(page, r, { x: r.x, y: r.y - 100 });
    const info = page.getByRole("separator", { name: "Resize info panel" });
    const i = await center(page, info);
    await drag(page, i, { x: i.x - 60, y: i.y });
    const sizes = async () => ({
      side: Math.round((await page.getByRole("separator", { name: "Resize side panel" }).boundingBox())!.x),
      result: Math.round((await page.getByRole("separator", { name: "Resize result area" }).boundingBox())!.y),
      info: Math.round((await page.getByRole("separator", { name: "Resize info panel" }).boundingBox())!.x),
    });
    const after = await sizes();
    expect(after.side).toBeGreaterThan(Math.round(s.x) + 60);
    expect(after.result).toBeLessThan(Math.round(r.y) - 80);
    await page.waitForTimeout(400);
    await page.reload();
    await expect(tab(page, "今日订单汇总")).toBeVisible();
    expect(await sizes()).toEqual(after);
  });

  test("result grid: three-state sort and column resize", async ({ page }) => {
    await runTodayOrders(page);
    const header = page.getByRole("columnheader", { name: "customer" });
    await header.click();
    await expect(header).toHaveAttribute("aria-sort", "ascending");
    await header.click();
    await expect(header).toHaveAttribute("aria-sort", "descending");
    await header.click();
    await expect(header).toHaveAttribute("aria-sort", "none");
    const box = (await header.boundingBox())!;
    await drag(page, { x: box.x + box.width - 1, y: box.y + box.height / 2 }, { x: box.x + box.width + 79, y: box.y + box.height / 2 });
    expect(Math.round((await header.boundingBox())!.width)).toBeGreaterThan(Math.round(box.width) + 60);
  });

  test("language switch applies at once; density and theme switch", async ({ page }) => {
    await page.getByRole("button", { name: "Language" }).click();
    await page.getByRole("menuitem", { name: "简体中文" }).click();
    await expect(page.getByRole("button", { name: "执行", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "资源" })).toBeVisible();
    await page.getByRole("button", { name: /宽松/ }).click();
    await expect(page.locator("html")).toHaveAttribute("data-density", "compact");
    await page.keyboard.press("ControlOrMeta+Shift+p");
    await page.getByRole("option", { name: "主题：深色" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  });

  test("environment: override, reset to inherited, restore from history", async ({ page }) => {
    await tab(page, "正式 Production").click();
    const params = page.getByRole("table", { name: "Parameters" });
    const tenant = params.getByRole("textbox", { name: "tenant_id" });
    await expect(tenant).toHaveValue("1001");
    await tenant.fill("2002");
    await tenant.press("Enter");
    const row = params.locator("tbody tr", { has: page.getByRole("textbox", { name: "tenant_id" }) });
    await expect(row).toContainText("This environment");
    const history = page.getByRole("table", { name: "History" });
    await expect(history.locator("tbody tr").first()).toContainText("tenant_id");
    await row.getByRole("button", { name: /Use the inherited value/ }).click();
    await expect(row).toContainText("Inherited from 默认 Default");
    await history.locator("tbody tr").first().getByRole("button", { name: "Restore" }).click();
    await expect(params.getByRole("textbox", { name: "tenant_id" })).toHaveValue("2002");
  });

  test("plugin: disabling greys its resources; search, ⌘K, command palette, audit page", async ({ page }) => {
    await tab(page, "SQL").click();
    await page.getByRole("switch", { name: "Enabled in this workspace" }).click();
    await expect(node(page, "q-orders-today")).toHaveAttribute("data-state", "disabled");
    await page.getByRole("switch", { name: "Enabled in this workspace" }).click();
    await expect(node(page, "q-orders-today")).toHaveAttribute("data-state", "ok");
    await activity(page, "Plugins").click();
    await node(page, "com.example.slack-notify").click();
    await expect(page.getByText("Failed to load").first()).toBeVisible();
    await page.getByRole("button", { name: "Activate" }).click();
    await expect(page.getByText(/Loaded in \d+ ms/)).toBeVisible();
    await page.keyboard.press("ControlOrMeta+k");
    await expect(page.getByRole("combobox", { name: "Search this workspace" })).toBeFocused();
    await page.keyboard.type("replication");
    await page.getByRole("option", { name: /Replication lag/ }).first().click();
    await expect(tab(page, "Replication lag")).toBeVisible();
    await page.keyboard.press("ControlOrMeta+Shift+p");
    await page.getByPlaceholder("Type a command").fill("audit");
    await page.getByRole("option", { name: "Open audit log" }).click();
    await expect(page.getByRole("table", { name: "审计 Audit" }).locator("tbody tr").first()).toBeVisible();
  });

  test("new query is created on first save; note and data source pages; cancel a run; deleted items", async ({ page }) => {
    // New: nothing exists until the first save (§9.1).
    await page.getByRole("button", { name: "New", exact: true }).click();
    await page.getByRole("menuitem", { name: "SQL query" }).click();
    await expect(tab(page, "Untitled query")).toBeVisible();
    await page.getByRole("textbox", { name: "SQL" }).click();
    await page.keyboard.type("SELECT * FROM coupons WHERE id = :coupon_id");
    await expect(page.getByRole("textbox", { name: "coupon_id", exact: true })).toBeVisible({ timeout: 2000 });
    await page.keyboard.press("ControlOrMeta+s");
    await expect(page.locator('[data-tree-key^="r-"]', { hasText: "Untitled query" })).toBeVisible();
    await expect(tab(page, "Untitled query")).not.toHaveClass(/od-tab--dirty/);

    // Note: a second kind, drawn by the same form page, without a result area.
    await tab(page, "值班手册").click();
    await expect(page.getByRole("textbox", { name: "Summary" })).toHaveValue("数据库值班：常见告警与处理");
    await expect(page.getByRole("region", { name: "Result area" })).toHaveCount(0);

    // Data source: test connection writes a text result.
    await activity(page, "Data sources").click();
    await node(page, "dg-prod").click();
    await node(page, "ds-prod").click();
    await page.getByRole("button", { name: "Test connection" }).click();
    await expect(page.getByText(/Connected to db-prod-01/)).toBeVisible({ timeout: 10_000 });

    // Cancel a long run from the result area.
    // (The Ops group is already open: the tree followed the runbook tab.)
    await activity(page, "Resources").click();
    await node(page, "q-export").click();
    await page.getByRole("textbox", { name: "start_date", exact: true }).fill("2026-11-01");
    await page.getByRole("button", { name: "Run", exact: true }).click();
    await page.getByRole("button", { name: "Cancel run" }).click();
    await expect(page.getByText("This run was cancelled")).toBeVisible();

    // Delete → Deleted tree → restore.
    await node(page, "q-sizes").click({ button: "right" });
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await expect(node(page, "q-sizes")).toHaveCount(0);
    await activity(page, "Deleted").click();
    await node(page, "del:q-sizes").click();
    await page.getByRole("row", { name: /表空间占用/ }).getByRole("button", { name: "Restore" }).click();
    await activity(page, "Resources").click();
    await expect(node(page, "q-sizes")).toBeVisible();
  });

  test("review shots: compact density, Chinese, other pages at 1600×1000", async ({ page }) => {
    test.skip(!EXTRA, "set WB_SHOT_DIR to produce review screenshots");
    await page.setViewportSize({ width: 1600, height: 1000 });
    await open(page, "&density=compact&lang=zh-CN&theme=dark");
    await runTodayOrders(page, "执行", "结果");
    await page.screenshot({ path: path.join(EXTRA!, "wide-compact-zh-sql.png") });
    await tab(page, "值班手册").click();
    await page.screenshot({ path: path.join(EXTRA!, "wide-note.png") });
    await page.keyboard.press("ControlOrMeta+Shift+p");
    await page.getByPlaceholder("输入命令").fill("审计");
    await page.getByRole("option", { name: "打开审计记录" }).click();
    await expect(page.locator("tbody tr").first()).toBeVisible();
    await page.screenshot({ path: path.join(EXTRA!, "wide-audit.png") });
    await node(page, "q-refund-recon").click();
    await page.getByRole("textbox", { name: "start_date", exact: true }).fill("2026-11-01");
    await page.getByRole("button", { name: "执行", exact: true }).click();
    await expect(page.getByText("legacy_orders_2019' doesn't exist").first()).toBeVisible({ timeout: 10_000 });
    await page.getByRole("button", { name: /^全部标签页 \(/ }).click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(EXTRA!, "wide-error-alltabs.png") });
    await page.keyboard.press("Escape");
    await page.getByRole("tab", { name: "历史" }).click();
    await page.getByRole("table", { name: "历史" }).locator("tbody tr").nth(1).click();
    await expect(page.getByText("复用参数")).toBeVisible();
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(EXTRA!, "wide-run.png") });
  });
});
