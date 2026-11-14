import { writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

/** Cold start to menu in browser preview mode (vite dev server): reads `[onedesk] menu-ready <ms>`. */
test("menu-ready timing is logged", async ({ browser }) => {
  const runs: number[] = [];
  for (let i = 0; i < 5; i++) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const ready = new Promise<number>((resolve) => {
      page.on("console", (msg) => {
        const m = /\[onedesk\] menu-ready ([\d.]+)/.exec(msg.text());
        if (m) resolve(Number(m[1]));
      });
    });
    await page.goto("/");
    runs.push(await ready);
    await context.close();
  }
  console.log(`[perf] menu-ready ms: ${runs.map((v) => v.toFixed(0)).join(", ")}`);
  writeFileSync(path.resolve(import.meta.dirname, "../test-results/menu-ready.json"), JSON.stringify(runs));
  expect(runs.length).toBe(5);
  // Run 1 includes vite's first compile; warm runs are the meaningful ones, bounded generously here.
  expect(Math.min(...runs)).toBeLessThan(5000);
});
