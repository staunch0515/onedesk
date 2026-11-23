/**
 * No page jitter: the window itself never scrolls or bounces. Only the inner scroll areas scroll, and a wheel that reaches
 * the end of one does not move the page (src/design/base.css; the root is exactly the window and `overflow: hidden`).
 * Checked at the window's minimum width (1100), at 1280 and at 1440, against the demo data. The elastic bounce of the
 * real macOS window (WKWebView) cannot be seen here: check it once in the app (docs/decisions.md D464).
 */
import { expect, test, type Page } from "@playwright/test";

/** Positions of the fixed parts of the window, and the document's own scroll offsets. */
async function frameState(page: Page) {
  return page.evaluate(() => {
    const rect = (sel: string) => {
      const r = document.querySelector(sel)?.getBoundingClientRect();
      return r ? [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)].join(",") : "none";
    };
    const doc = document.scrollingElement!;
    return { top: rect(".od-wb__topbar"), side: rect(".od-side"), main: rect(".od-wb__main"), status: rect(".od-wb__status"), scrollTop: doc.scrollTop, scrollLeft: doc.scrollLeft, bodyTop: document.body.scrollTop, bodyLeft: document.body.scrollLeft };
  });
}

/** Centres of every element that can scroll, plus the top bar. */
async function scrollAreas(page: Page) {
  return page.evaluate(() => {
    const out: Array<{ x: number; y: number; what: string }> = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("body *"))) {
      const cs = getComputedStyle(el);
      const y = /(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 1;
      const x = /(auto|scroll)/.test(cs.overflowX) && el.scrollWidth > el.clientWidth + 1;
      if (!x && !y) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 20 || r.height < 20) continue;
      out.push({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + Math.min(r.height / 2, 200)), what: `${el.tagName}.${el.className}`.slice(0, 80) });
    }
    const top = document.querySelector(".od-wb__topbar")!.getBoundingClientRect();
    out.push({ x: Math.round(top.x + top.width / 2), y: Math.round(top.y + top.height / 2), what: "topbar" });
    return out;
  });
}

async function wheelEverywhere(page: Page) {
  const before = await frameState(page);
  const areas = await scrollAreas(page);
  expect(areas.length).toBeGreaterThan(1);
  for (const area of areas) {
    await page.mouse.move(area.x, area.y);
    for (const [dx, dy] of [[0, 4000], [0, 4000], [4000, 0], [0, -8000], [-8000, 0]] as const) await page.mouse.wheel(dx, dy);
    expect(await frameState(page), `wheel over ${area.what}`).toEqual(before);
  }
}

for (const width of [1100, 1280, 1440]) {
  test(`no page jitter at ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 760 });
    await page.goto("/workbench.html?reset&quiet&theme=light");
    await expect(page.locator(".od-wb__topbar")).toBeVisible();
    // Long content in the side tree and in a page: everything expanded, then the first resource opened.
    await page.getByRole("button", { name: "Expand all" }).first().click();
    await page.locator("[data-tree-key]").filter({ hasNot: page.locator("[aria-expanded]") }).first().dblclick();
    await wheelEverywhere(page);
    const doc = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, sh: document.documentElement.scrollHeight, ch: document.documentElement.clientHeight }));
    expect(doc.sw, "the page is never wider than the window").toBeLessThanOrEqual(doc.cw);
    expect(doc.sh, "the page is never taller than the window").toBeLessThanOrEqual(doc.ch);
  });
}
