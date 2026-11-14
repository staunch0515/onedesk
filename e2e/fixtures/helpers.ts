import type { Page } from "@playwright/test";
import { expect, sidebar, t } from "./app";

/** Creates a resource through the 新建 dialog; lands on its 编辑 tab. `fields` maps field label -> value. */
export async function createResource(page: Page, kind: string, name: string, fields: Record<string, string> = {}, group?: string) {
  await page.getByRole("button", { name: t("topbar.new"), exact: true }).click();
  const dialog = page.getByRole("dialog", { name: t("new.title") });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("combobox", { name: t("new.kind") }).click();
  await page.getByRole("option", { name: kind, exact: true }).click();
  await dialog.getByRole("textbox", { name: t("new.name") }).fill(name);
  if (group) await dialog.getByRole("textbox", { name: t("new.group") }).fill(group);
  for (const [label, value] of Object.entries(fields)) {
    await dialog.getByRole("textbox", { name: label }).fill(value);
  }
  await dialog.getByRole("button", { name: t("new.submit") }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
}

export async function openFromMenu(page: Page, name: string) {
  await sidebar(page).getByRole("button", { name, exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name }).first()).toBeVisible();
}

export async function gotoPage(page: Page, key: "nav.allResources" | "nav.collections" | "nav.plugins" | "nav.settings") {
  await sidebar(page).getByRole("button", { name: t(key), exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: t(key === "nav.allResources" ? "all.title" : key === "nav.collections" ? "collections.title" : key === "nav.plugins" ? "plugins.title" : "settings.title") })).toBeVisible();
}

export async function openPalette(page: Page) {
  await page.getByRole("button", { name: t("topbar.paletteLabel") }).click();
  await expect(page.getByRole("dialog", { name: t("palette.label") })).toBeVisible();
}
