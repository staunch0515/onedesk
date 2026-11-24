/**
 * The simplified layout (D465), against the demo data:
 *  1. the tab strip, the breadcrumb row and the actions row have one size (32px rows, 12px text, 14px icons, 26px
 *     controls) and the side panel's title row is level with the tab strip;
 *  2. the info panel is left of the content from 1600px up, right of it below, and changes sides when the window does;
 *  3. no title row: the breadcrumb ends in the page's name, bold, as the page's h1, with the badges right after it;
 *  4. the next row: environment first, a hairline, the actions (more than four go into "More"), the info toggle last;
 *  5. the tree's own buttons above the tree still work (new group, expand all, collapse all);
 *  6. the activity bar's switch: wide (280px, title row and search level with the tree's, every view as a tile), search,
 *     remembered across a reload.
 * Screenshots (not checked in): test-results/screenshots/layout-v2-dev/.
 */
import path from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";

const OUT = path.resolve(import.meta.dirname, "../test-results/screenshots/layout-v2-dev");

test.use({ locale: "en-US" });

const views = (page: Page) => page.getByRole("navigation", { name: "Views" });
const box = async (l: Locator) => (await l.boundingBox())!;

async function open(page: Page, width: number, query = "&quiet") {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`/workbench.html?reset${query}`);
  await expect(page.locator("[data-tab-id]", { hasText: "今日订单汇总" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "今日订单汇总" })).toBeVisible();
  // Drop ?reset so a reload restores the saved layout instead of starting over.
  await page.evaluate(() => history.replaceState(null, "", "/workbench.html"));
}

/** Where the info panel is: left or right of the page content, or not shown. */
async function infoSide(page: Page): Promise<"left" | "right" | "none"> {
  const info = page.getByRole("complementary", { name: "Info" });
  // Right after a resize the panel may be moving to the other side: no box yet reads as "none" (callers poll).
  const i = await info.boundingBox().catch(() => null);
  const content = await page.locator(".od-pf__content").boundingBox();
  if (!i || !content) return "none";
  if (Math.abs(i.x - content.x) < 2) return "left";
  if (Math.abs(i.x + i.width - (content.x + content.width)) < 2) return "right";
  return "none";
}

test("1: the tab strip, breadcrumb row and actions row share one size; the side title row is level with the tab strip", async ({ page }) => {
  await open(page, 1440);
  const strip = await box(page.locator(".od-tabstrip"));
  const crumbs = await box(page.locator(".od-titlebar__row"));
  const actions = await box(page.locator(".od-titlebar__actions-row"));
  expect([strip.height, crumbs.height, actions.height]).toEqual([32, 32, 32]);
  const side = await box(page.locator(".od-side__header"));
  expect(side.y).toBe(strip.y);
  expect(side.height).toBe(strip.height);

  const size = (l: Locator, prop: "fontSize" | "height" | "width") => l.first().evaluate((el, p) => getComputedStyle(el)[p], prop);
  const tab = page.locator(".od-tab--active");
  expect(await size(tab, "fontSize")).toBe("12px");
  expect(await size(page.locator(".od-titlebar__crumbs"), "fontSize")).toBe("12px");
  expect(await size(page.locator(".od-titlebar__title"), "fontSize")).toBe("12px");
  const run = page.locator(".od-titlebar__actions").getByRole("button", { name: "Run", exact: true });
  expect(await size(run, "fontSize")).toBe("12px");
  // Icons 14px in all three rows.
  expect(await size(tab.locator(".od-tab__icon"), "width")).toBe("14px");
  expect(await size(page.locator(".od-titlebar__current .od-icon"), "width")).toBe("14px");
  expect(await size(run.locator(".od-icon"), "width")).toBe("14px");
  // Controls 26px: buttons, "More", the environment selector, the info toggle.
  expect(await size(run, "height")).toBe("26px");
  expect(await size(page.getByRole("button", { name: "More actions" }), "height")).toBe("26px");
  expect(await size(page.getByRole("combobox", { name: "Environment of this tab" }), "height")).toBe("26px");
  expect(await size(page.locator(".od-titlebar__aside").getByRole("button", { name: "Hide info panel" }), "height")).toBe("26px");
});

test("2: the info panel is on the left from 1600px up, on the right below, and changes sides with the window", async ({ page }) => {
  await open(page, 1599);
  await expect.poll(() => infoSide(page)).toBe("right");
  await page.setViewportSize({ width: 1600, height: 900 });
  await expect.poll(() => infoSide(page)).toBe("left");
  await page.setViewportSize({ width: 1700, height: 900 });
  await expect.poll(() => infoSide(page)).toBe("left");
  await page.setViewportSize({ width: 1599, height: 900 });
  await expect.poll(() => infoSide(page)).toBe("right");

  // Folding and the remembered width still work on the right.
  const info = page.getByRole("complementary", { name: "Info" });
  const before = (await box(info)).width;
  const splitter = page.getByRole("separator", { name: "Resize info panel" });
  const s = await box(splitter);
  await page.mouse.move(s.x + s.width / 2, s.y + s.height / 2);
  await page.mouse.down();
  await page.mouse.move(s.x - 60, s.y + s.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await box(info)).width).toBeGreaterThan(before + 40);
  const widened = (await box(info)).width;
  await page.locator(".od-titlebar__aside").getByRole("button", { name: "Hide info panel" }).click();
  await expect(page.getByRole("complementary", { name: "Info" })).toBeHidden();
  await page.reload();
  await expect(page.getByRole("button", { name: "Show info panel" })).toBeVisible();
  await page.getByRole("button", { name: "Show info panel" }).click();
  await expect.poll(() => infoSide(page)).toBe("right");
  expect((await box(info)).width).toBe(widened);
  // On a wide window the same width, on the left.
  await page.setViewportSize({ width: 1700, height: 900 });
  await expect.poll(() => infoSide(page)).toBe("left");
  expect((await box(info)).width).toBe(widened);
});

test("3: no title row; the breadcrumb ends in the page's name in bold as the h1, the badges right after it", async ({ page }) => {
  await open(page, 1440);
  const nav = page.getByRole("navigation", { name: "Location" });
  const h1 = page.getByRole("heading", { level: 1 });
  await expect(h1).toHaveCount(1);
  await expect(nav.getByRole("heading", { level: 1, name: "今日订单汇总" })).toBeVisible();
  expect(Number(await h1.evaluate((el) => getComputedStyle(el).fontWeight))).toBeGreaterThanOrEqual(600);
  // Path → name → badges, left to right on the one row.
  const parent = nav.getByRole("button", { name: "日常核对 Daily checks" });
  const badge = nav.getByText("SQL query", { exact: true });
  const [p, t, b] = await Promise.all([box(parent), box(h1), box(badge)]);
  expect(p.x + p.width).toBeLessThan(t.x);
  expect(t.x + t.width).toBeLessThan(b.x);
  expect(Math.abs(p.y + p.height / 2 - (t.y + t.height / 2))).toBeLessThan(2);
  expect(Math.abs(b.y + b.height / 2 - (t.y + t.height / 2))).toBeLessThan(2);
  // The unsaved badge joins them.
  await page.locator(".od-code textarea").first().click();
  await page.keyboard.type(" ");
  await expect(nav.getByText("Unsaved")).toBeVisible();
  // A crumb still opens its place.
  await parent.click();
  await expect(page.locator('[data-tree-key][aria-selected="true"]')).toContainText("日常核对");
});

test("4: environment first, then the actions on the left (more than four in More), the info toggle at the right end", async ({ page }) => {
  await open(page, 1440);
  const row = page.locator(".od-titlebar__actions-row");
  const env = row.getByRole("combobox", { name: "Environment of this tab" });
  const actions = row.getByRole("toolbar", { name: "Actions" });
  const toggle = row.getByRole("button", { name: "Hide info panel" });
  const [r, e, a, i] = await Promise.all([box(row), box(env), box(actions), box(toggle)]);
  expect(e.x - r.x).toBeLessThan(20);
  expect(e.x + e.width).toBeLessThan(a.x);
  // The actions sit right after the environment, not pushed to the right.
  expect(a.x - (e.x + e.width)).toBeLessThan(30);
  expect(r.x + r.width - (i.x + i.width)).toBeLessThan(20);
  expect(a.x + a.width).toBeLessThan(i.x - 100);
  // A hairline between the environment and the actions.
  expect(await row.locator(".od-titlebar__lead").evaluate((el) => getComputedStyle(el).borderRightWidth)).toBe("1px");
  // Four buttons, the rest behind "More".
  const buttons = actions.getByRole("button");
  await expect(buttons).toHaveCount(5);
  await expect(buttons.last()).toHaveAccessibleName("More actions");
  await buttons.last().click();
  await expect(page.getByRole("menuitem").first()).toBeVisible();
  await page.keyboard.press("Escape");
  // The toggle folds and opens the info panel.
  await toggle.click();
  await expect(page.getByRole("complementary", { name: "Info" })).toBeHidden();
  await row.getByRole("button", { name: "Show info panel" }).click();
  await expect(page.getByRole("complementary", { name: "Info" })).toBeVisible();
});

test("5: the tree's buttons above the tree still work: new group, expand all, collapse all", async ({ page }) => {
  await open(page, 1440);
  const side = page.locator(".od-side");
  const rows = side.locator("[data-tree-key]");
  await side.getByRole("button", { name: "Collapse all" }).click();
  await expect.poll(() => side.locator("[aria-expanded='true']").count()).toBe(0);
  const collapsed = await rows.count();
  await side.getByRole("button", { name: "Expand all" }).click();
  await expect.poll(() => rows.count()).toBeGreaterThan(collapsed);
  await expect.poll(() => side.locator("[aria-expanded='false']").count()).toBe(0);
  await side.getByRole("button", { name: "Collapse all" }).click();
  await expect.poll(() => rows.count()).toBe(collapsed);
  await side.getByRole("button", { name: "New group" }).click();
  const name = side.getByRole("textbox", { name: "New name" });
  await expect(name).toBeVisible();
  await name.fill("Layout check");
  await name.press("Enter");
  await expect(side.locator("[data-tree-key]", { hasText: "Layout check" })).toBeVisible();
});

test("6: the activity bar switches to a wide grid of all views, with a search, and remembers it", async ({ page }) => {
  // Not quiet: the demo keeps a run going, so the run history view has a count.
  await open(page, 1440, "");
  await expect(views(page).locator(".od-activity__badge")).toHaveCount(1);
  const bar = views(page);
  expect((await box(bar)).width).toBe(48);
  const toggle = bar.getByRole("button", { name: "Show all views as icons" });
  // The switch is the first thing in the column.
  await expect(bar.getByRole("button").first()).toHaveAccessibleName("Show all views as icons");
  await toggle.click();
  expect((await box(bar)).width).toBe(280);
  // Title row and search level with the tree panel's.
  const [head, sideHead] = await Promise.all([box(bar.locator(".od-activity__head")), box(page.locator(".od-side__header"))]);
  expect(head.y).toBe(sideHead.y);
  expect(head.height).toBe(sideHead.height);
  const search = bar.getByRole("textbox", { name: "Find a view" });
  const [s, treeFilter] = await Promise.all([box(search), box(page.locator(".od-side").getByRole("textbox", { name: "Filter by name" }))]);
  expect(s.y).toBe(treeFilter.y);
  expect(s.height).toBe(treeFilter.height);
  await expect(bar.getByRole("heading", { name: "Views" })).toBeVisible();
  // Every view as a tile; the current one marked; the running count kept; settings at the bottom.
  const tiles = bar.getByRole("listitem");
  expect(await tiles.count()).toBeGreaterThan(5);
  await expect(bar.locator("[aria-current='true']")).toHaveCount(1);
  await expect(bar.locator("[aria-current='true']")).toContainText("Resources");
  await expect(bar.locator(".od-activity__badge")).toHaveCount(1);
  const settings = bar.getByRole("button", { name: "Settings" });
  expect((await box(settings)).y).toBeGreaterThan(Math.max(...(await Promise.all((await tiles.all()).map(async (t) => (await box(t)).y)))));
  await page.screenshot({ path: path.join(OUT, "wide-light-1440.png") });

  // Search: words of the name; nothing found says so.
  await search.fill("env");
  await expect(tiles).toHaveCount(1);
  await expect(tiles.first()).toContainText("Environments");
  await page.screenshot({ path: path.join(OUT, "wide-filtered-light-1440.png") });
  await tiles.first().click();
  await expect(page.locator(".od-side .od-side__title")).toContainText("Environments");
  await search.fill("zzzz");
  await expect(tiles).toHaveCount(0);
  await expect(bar.getByText("No view matches")).toBeVisible();
  await search.press("Escape");
  expect(await tiles.count()).toBeGreaterThan(5);

  // Remembered across a reload, both ways.
  await page.reload();
  expect((await box(views(page))).width).toBe(280);
  await views(page).getByRole("button", { name: "Back to the icon column" }).click();
  expect((await box(views(page))).width).toBe(48);
  await page.reload();
  await expect(views(page).getByRole("button", { name: "Show all views as icons" })).toBeVisible();
  expect((await box(views(page))).width).toBe(48);
});

for (const theme of ["light", "dark"] as const) {
  test(`screenshots ${theme}`, async ({ page }) => {
    for (const width of [1100, 1440, 1700]) {
      await open(page, width, `&quiet&theme=${theme}`);
      await page.mouse.move(width / 2, 2);
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(OUT, `${theme}-${width}.png`) });
    }
    await views(page).getByRole("button", { name: "Show all views as icons" }).click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT, `wide-${theme}-1700.png`) });
  });
}
