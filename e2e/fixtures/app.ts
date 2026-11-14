import { test as base, expect, type Page } from "@playwright/test";
import { zhCN } from "../../src/shell/i18n/zh-CN";
import { startHttpServer, type TestServer } from "./http-server";

type Key = keyof typeof zhCN;

/** UI copy from the i18n file, with {{name}} placeholders filled. */
export function t(key: Key, params: Record<string, string | number> = {}): string {
  return zhCN[key].replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(params[name] ?? ""));
}

declare global {
  interface Window {
    __opened: string[];
  }
}

interface Fixtures {
  server: TestServer;
  /** Opens the app (each test has a fresh context, so a fresh preview database) and waits for the menu. */
  app: Page;
}

export const test = base.extend<Fixtures, { httpServer: TestServer }>({
  httpServer: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const server = await startHttpServer();
      await use(server);
      await server.close();
    },
    { scope: "worker" },
  ],
  server: async ({ httpServer }, use) => use(httpServer),
  context: async ({ context }, use) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await use(context);
  },
  app: async ({ page }, use) => {
    // Record window.open calls (the preview platform's openExternal) instead of opening tabs.
    await page.addInitScript(() => {
      window.__opened = [];
      window.open = ((url?: string | URL) => {
        window.__opened.push(String(url));
        return null;
      }) as typeof window.open;
    });
    await page.goto("/");
    await expect(sidebar(page)).toBeVisible();
    await expect(sidebar(page).getByRole("link", { name: t("nav.allResources") }).or(sidebar(page).getByRole("button", { name: t("nav.allResources") }))).toBeVisible();
    await use(page);
  },
});

export { expect };

export const sidebar = (page: Page) => page.getByRole("navigation", { name: t("app.sidebarLabel") });
