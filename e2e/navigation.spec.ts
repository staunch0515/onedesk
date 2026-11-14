import { expect, sidebar, t, test } from "./fixtures/app";
import { createResource, gotoPage, openFromMenu, openPalette } from "./fixtures/helpers";

const main = (page: import("@playwright/test").Page) => page.getByRole("main", { name: t("app.mainLabel") });
const html = (page: import("@playwright/test").Page) => page.locator("html");

test("startup: menu lists the seeded resources grouped, with the fixed bottom entries", async ({ app }) => {
  const menu = sidebar(app);
  for (const name of ["读书笔记", "周报提示词", "获取示例数据", "OneDesk 项目主页"]) {
    await expect(menu.getByRole("button", { name, exact: true })).toBeVisible();
  }
  await expect(menu.getByRole("button", { name: "个人", exact: true })).toBeVisible();
  await expect(menu.getByRole("button", { name: "工作", exact: true })).toBeVisible();
  for (const key of ["nav.allResources", "nav.collections", "nav.plugins", "nav.settings"] as const) {
    await expect(menu.getByRole("button", { name: t(key), exact: true })).toBeVisible();
  }
  await expect(main(app).getByRole("heading", { level: 1, name: t("all.title") })).toBeVisible();
});

test.describe("search", () => {
  const search = async (page: import("@playwright/test").Page, query: string) => {
    const box = page.getByRole("searchbox", { name: t("topbar.searchLabel") });
    await box.fill(query);
    await box.press("Enter");
    await expect(main(page).getByRole("heading", { level: 1, name: t("search.title", { query }) })).toBeVisible();
  };

  test("by name", async ({ app }) => {
    await search(app, "周报");
    await expect(main(app).getByRole("gridcell", { name: "周报提示词" })).toBeVisible();
    await expect(main(app).getByRole("gridcell", { name: "读书笔记" })).toHaveCount(0);
  });

  test("by tag", async ({ app }) => {
    await search(app, "接口");
    await expect(main(app).getByRole("gridcell", { name: "获取示例数据" })).toBeVisible();
  });

  test("by body text", async ({ app }) => {
    await search(app, "关键观点");
    await expect(main(app).getByRole("gridcell", { name: "读书笔记" })).toBeVisible();
  });

  test("no result gives a one-line empty state", async ({ app }) => {
    await search(app, "不存在的词语");
    await expect(main(app).getByText(t("search.empty", { query: "不存在的词语" }))).toBeVisible();
  });
});

test.describe("command palette", () => {
  test("opens with the keyboard shortcut and closes with Esc", async ({ app }) => {
    await app.keyboard.press("ControlOrMeta+k");
    const dialog = app.getByRole("dialog", { name: t("palette.label") });
    await expect(dialog).toBeVisible();
    await app.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });

  test("search a resource and jump to it", async ({ app }) => {
    await openPalette(app);
    await app.getByRole("combobox", { name: t("palette.label") }).fill("读书");
    await app.getByRole("option", { name: /读书笔记/ }).first().click();
    await expect(main(app).getByRole("heading", { level: 1, name: "读书笔记" }).first()).toBeVisible();
  });

  test("find a resource by body text", async ({ app }) => {
    for (const query of ["每周读完", "关键观点", "完美"]) {
      await openPalette(app);
      await app.getByRole("combobox", { name: t("palette.label") }).fill(query);
      await expect(app.getByRole("option", { name: /读书笔记/ }).first(), `body text ${query}`).toBeVisible();
      await app.keyboard.press("Escape");
    }
    await openPalette(app);
    await app.getByRole("combobox", { name: t("palette.label") }).fill("每周读完");
    await app.getByRole("option", { name: /读书笔记/ }).first().click();
    await expect(main(app).getByRole("heading", { level: 1, name: "读书笔记" }).first()).toBeVisible();
  });

  test("find a resource by tag", async ({ app }) => {
    await openPalette(app);
    await app.getByRole("combobox", { name: t("palette.label") }).fill("接口");
    await expect(app.getByRole("option", { name: /获取示例数据/ }).first()).toBeVisible();
    await app.getByRole("option", { name: /获取示例数据/ }).first().click();
    await expect(main(app).getByRole("heading", { level: 1, name: "获取示例数据" }).first()).toBeVisible();
  });

  test("run an action of the current resource", async ({ app }) => {
    await openFromMenu(app, "OneDesk 项目主页");
    await openPalette(app);
    await app.getByRole("option", { name: /^打开 / }).click();
    await expect.poll(() => app.evaluate(() => window.__opened)).toEqual(["https://example.com/"]);
  });

  test("create from the palette", async ({ app }) => {
    await openPalette(app);
    await app.getByRole("option", { name: t("palette.createKind", { kind: "笔记" }) }).click();
    const dialog = app.getByRole("dialog", { name: t("new.title") });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("combobox", { name: t("new.kind") })).toHaveText("笔记");
  });

  test("go to a page", async ({ app }) => {
    await openPalette(app);
    await app.getByRole("option", { name: t("palette.goto", { page: t("nav.plugins") }) }).click();
    await expect(main(app).getByRole("heading", { level: 1, name: t("plugins.title") })).toBeVisible();
  });
});

test("theme and density switch and persist across reload", async ({ app }) => {
  await openPalette(app);
  await app.getByRole("option", { name: t("palette.themeTo", { theme: t("settings.theme.dark") }) }).click();
  await expect(html(app)).toHaveAttribute("data-theme", "dark");
  await openPalette(app);
  await app.getByRole("option", { name: t("palette.densityTo", { density: t("settings.density.compact") }) }).click();
  await expect(html(app)).toHaveAttribute("data-density", "compact");

  await app.reload();
  await expect(sidebar(app)).toBeVisible();
  await expect(html(app)).toHaveAttribute("data-theme", "dark");
  await expect(html(app)).toHaveAttribute("data-density", "compact");

  // And back through the settings page.
  await gotoPage(app, "nav.settings");
  await app.getByRole("combobox", { name: t("settings.theme") }).click();
  await app.getByRole("option", { name: t("settings.theme.light") }).click();
  await expect(html(app)).toHaveAttribute("data-theme", "light");
  await app.getByRole("combobox", { name: t("settings.density") }).click();
  await app.getByRole("option", { name: t("settings.density.comfortable") }).click();
  await expect(html(app)).toHaveAttribute("data-density", "comfortable");
});

test("disable the HTTP plugin: menu item gone, grey in all resources; enable restores", async ({ app }) => {
  const menu = sidebar(app);
  await expect(menu.getByRole("button", { name: "获取示例数据", exact: true })).toBeVisible();

  await gotoPage(app, "nav.plugins");
  const toggle = main(app).getByRole("switch", { name: t("plugins.toggle", { name: "HTTP 请求" }) });
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await expect(menu.getByRole("button", { name: "获取示例数据", exact: true })).toHaveCount(0);
  await expect(main(app).getByText(t("plugins.kept", { count: 1 }))).toBeVisible();

  await gotoPage(app, "nav.allResources");
  const row = main(app).getByRole("row", { name: /获取示例数据/ });
  await expect(row).toBeVisible();
  await expect(row.getByRole("gridcell", { name: t("all.disabledKind", { kind: "HTTP 请求" }) })).toBeVisible();
  // Grey: the row text is dimmed compared to an active row.
  const dim = await row.getByRole("gridcell").first().evaluate((el) => getComputedStyle(el).color);
  const normal = await main(app).getByRole("row", { name: /读书笔记/ }).getByRole("gridcell").first().evaluate((el) => getComputedStyle(el).color);
  expect(dim).not.toBe(normal);

  // The data is kept and readable, with an enable button.
  await row.getByRole("gridcell", { name: "获取示例数据" }).click();
  await expect(main(app).getByText(t("resource.pluginDisabled"))).toBeVisible();

  await main(app).getByRole("button", { name: t("resource.enablePlugin") }).click();
  await expect(menu.getByRole("button", { name: "获取示例数据", exact: true })).toBeVisible();
  await expect(main(app).getByText(t("resource.pluginDisabled"))).toHaveCount(0);
});

test("collection: create by type and see its resources", async ({ app }) => {
  await gotoPage(app, "nav.collections");
  await main(app).getByRole("button", { name: t("collections.new") }).first().click();
  const dialog = app.getByRole("dialog");
  await dialog.getByRole("textbox", { name: t("collections.name") }).fill("所有笔记");
  await dialog.getByRole("combobox", { name: t("collections.ruleType") }).click();
  await app.getByRole("option", { name: t("collections.rule.kind") }).click();
  await dialog.getByRole("combobox", { name: t("collections.ruleKindValue") }).click();
  await app.getByRole("option", { name: "笔记", exact: true }).click();
  await dialog.getByRole("button", { name: t("common.create") }).click();
  // Creating a collection opens it.
  await expect(main(app).getByRole("heading", { level: 1, name: "所有笔记" })).toBeVisible();
  await expect(main(app).getByRole("gridcell", { name: "读书笔记" })).toBeVisible();
  await expect(main(app).getByRole("gridcell", { name: "周报提示词" })).toHaveCount(0);
  await main(app).getByRole("button", { name: t("collections.back") }).click();
  await expect(main(app).getByRole("gridcell", { name: "所有笔记" })).toBeVisible();
});

test("delete a resource asks for confirmation", async ({ app }) => {
  await createResource(app, "笔记", "临时笔记");
  await app.getByRole("button", { name: t("common.more") }).first().click();
  await app.getByRole("menuitem", { name: t("resource.delete") }).click();
  const dialog = app.getByRole("dialog", { name: t("resource.deleteTitle", { name: "临时笔记" }) });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: t("common.delete") }).click();
  await expect(sidebar(app).getByRole("button", { name: "临时笔记", exact: true })).toHaveCount(0);
});

test("leaving the edit view with unsaved changes asks first", async ({ app }) => {
  await openFromMenu(app, "读书笔记");
  await app.getByRole("tab", { name: "编辑" }).click();
  await app.getByRole("textbox", { name: "名称" }).fill("读书笔记（改）");
  await expect(main(app).getByText(t("edit.unsaved")).first()).toBeVisible();
  await sidebar(app).getByRole("button", { name: t("nav.plugins"), exact: true }).click();
  const dialog = app.getByRole("dialog", { name: t("edit.leaveTitle") });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: t("common.keepEditing") }).click();
  await expect(main(app).getByRole("textbox", { name: "名称" })).toHaveValue("读书笔记（改）");
});

test("keyboard: Tab moves through the page with a visible focus ring", async ({ app }) => {
  const seen = new Set<string>();
  for (let i = 0; i < 12; i++) {
    await app.keyboard.press("Tab");
    const info = await app.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      const style = getComputedStyle(el);
      return {
        label: el.getAttribute("aria-label") ?? el.textContent?.trim().slice(0, 30) ?? "",
        visible: el.matches(":focus-visible") && style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0,
      };
    });
    expect(info, `Tab ${i + 1} should land on an element`).not.toBeNull();
    expect(info!.visible, `focus ring on "${info!.label}"`).toBe(true);
    seen.add(info!.label);
  }
  expect(seen.size).toBeGreaterThan(5);

  // Enter on a focused menu button opens the page.
  const item = sidebar(app).getByRole("button", { name: t("nav.plugins"), exact: true });
  await item.focus();
  await expect(item).toBeFocused();
  await app.keyboard.press("Enter");
  await expect(main(app).getByRole("heading", { level: 1, name: t("plugins.title") })).toBeVisible();
});

test("shortcut: Cmd/Ctrl+N opens the new-resource dialog", async ({ app }) => {
  await app.keyboard.press("ControlOrMeta+n");
  await expect(app.getByRole("dialog", { name: t("new.title") })).toBeVisible();
});

test("disable plugin, open its resource, enable from the page, then navigate freely", async ({ app }) => {
  await gotoPage(app, "nav.plugins");
  await main(app).getByRole("switch", { name: t("plugins.toggle", { name: "HTTP 请求" }) }).click();
  await gotoPage(app, "nav.allResources");
  await main(app).getByRole("gridcell", { name: "获取示例数据" }).click();
  await expect(main(app).getByText(t("resource.pluginDisabled"))).toBeVisible();
  await main(app).getByRole("button", { name: t("resource.enablePlugin") }).click();
  await expect(sidebar(app).getByRole("button", { name: "获取示例数据", exact: true })).toBeVisible();
  await expect(main(app).getByRole("tab", { name: "响应" })).toBeVisible();

  // No false "unsaved changes" prompt when leaving.
  await openFromMenu(app, "读书笔记");
  await expect(app.getByRole("dialog", { name: t("edit.leaveTitle") })).toHaveCount(0);
  await gotoPage(app, "nav.plugins");
  await expect(app.getByRole("dialog", { name: t("edit.leaveTitle") })).toHaveCount(0);
  await openFromMenu(app, "获取示例数据");
  await gotoPage(app, "nav.settings");
  await expect(app.getByRole("dialog", { name: t("edit.leaveTitle") })).toHaveCount(0);
});
