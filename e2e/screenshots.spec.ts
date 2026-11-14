import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, sidebar, t, test } from "./fixtures/app";
import { createResource, gotoPage, openFromMenu, openPalette } from "./fixtures/helpers";

const OUT = path.resolve(import.meta.dirname, "../docs/screenshots");
const main = (page: Page) => page.getByRole("main", { name: t("app.mainLabel") });

async function setTheme(page: Page, theme: "light" | "dark") {
  await openPalette(page);
  await page.getByRole("option", { name: t("palette.themeTo", { theme: t(theme === "dark" ? "settings.theme.dark" : "settings.theme.light") }) }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  await expect(page.getByRole("dialog", { name: t("palette.label") })).toBeHidden();
}

async function shot(page: Page, theme: string, name: string) {
  // Let transitions and toasts settle, and move the pointer away so no hover state is captured.
  await page.mouse.move(0, 0);
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT, `${theme}-${name}.png`) });
}

for (const theme of ["light", "dark"] as const) {
  test.describe(`screenshots ${theme}`, () => {
    test.beforeEach(async ({ app }) => {
      await setTheme(app, theme);
    });

    test("menu + form (edit view)", async ({ app }) => {
      await openFromMenu(app, "OneDesk 项目主页");
      await app.getByRole("tab", { name: "编辑" }).click();
      await expect(app.getByRole("textbox", { name: "网址" })).toBeVisible();
      await shot(app, theme, "menu-form");
    });

    test("table (all resources)", async ({ app }) => {
      await gotoPage(app, "nav.allResources");
      await expect(main(app).getByRole("gridcell", { name: "读书笔记" })).toBeVisible();
      await shot(app, theme, "table");
    });

    test("empty state (empty collection)", async ({ app }) => {
      // Delete the only note, then open a collection of notes: nothing in it.
      await openFromMenu(app, "读书笔记");
      await app.getByRole("button", { name: t("common.more") }).first().click();
      await app.getByRole("menuitem", { name: t("resource.delete") }).click();
      await app.getByRole("dialog").getByRole("button", { name: t("common.delete") }).click();
      await expect(sidebar(app).getByRole("button", { name: "读书笔记", exact: true })).toHaveCount(0);
      await createResource(app, "笔记", "占位");
      await gotoPage(app, "nav.collections");
      await main(app).getByRole("button", { name: t("collections.new") }).first().click();
      const dialog = app.getByRole("dialog");
      await dialog.getByRole("textbox", { name: t("collections.name") }).fill("所有笔记");
      await dialog.getByRole("combobox", { name: t("collections.ruleType") }).click();
      await app.getByRole("option", { name: t("collections.rule.kind") }).click();
      await dialog.getByRole("combobox", { name: t("collections.ruleKindValue") }).click();
      await app.getByRole("option", { name: "笔记", exact: true }).click();
      await dialog.getByRole("button", { name: t("common.create") }).click();
      await expect(main(app).getByRole("heading", { level: 1, name: "所有笔记" })).toBeVisible();
      // Remove the placeholder note so the collection is empty.
      await openFromMenu(app, "占位");
      await app.getByRole("button", { name: t("common.more") }).first().click();
      await app.getByRole("menuitem", { name: t("resource.delete") }).click();
      await app.getByRole("dialog").getByRole("button", { name: t("common.delete") }).click();
      await gotoPage(app, "nav.collections");
      await main(app).getByRole("gridcell", { name: "所有笔记" }).click();
      await expect(main(app).getByText(t("collections.itemsEmpty"))).toBeVisible();
      await shot(app, theme, "empty");
    });

    test("error state (action failed)", async ({ app }) => {
      await createResource(app, "HTTP 请求", "无法连接的请求", { 网址: "http://127.0.0.1:1/never" });
      await app.getByRole("tab", { name: "响应" }).click();
      await app.getByRole("button", { name: "发送", exact: true }).click();
      await expect(main(app).getByText(t("action.error", { label: "发送" }))).toBeVisible();
      await expect(main(app).getByText(/处理方式/)).toBeVisible();
      await shot(app, theme, "error");
    });
  });
}
