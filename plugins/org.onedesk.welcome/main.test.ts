import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-ignore plain JS module, no types
import plugin, { ENTRIES } from "./main.js";
import { RENDER_KEYS, checkView, onlyKeys, registry, t } from "../_testing/view-check";

const ctxOf = (locale = "en-US") => ({ target: "page:org.onedesk.welcome/welcome", locale, host: {}, t });

describe("welcome plugin", () => {
  it("registers only the welcome page", () => {
    expect(Object.keys(registry(plugin).pages)).toEqual(["welcome"]);
  });

  it("renders a Markdown intro and the four entries as links", async () => {
    const { pages } = registry(plugin);
    const out = await pages.welcome.render(ctxOf());
    expect(checkView(out.view)).toEqual([]);
    expect(onlyKeys(out, RENDER_KEYS)).toEqual([]);
    expect(out.title).toBe("page.title");
    expect(out.view[0]).toMatchObject({ type: "text", format: "markdown", text: "intro" });
    expect(out.view.slice(1).map((n: any) => n.target)).toEqual([
      "new:org.onedesk.note:note",
      "new:org.onedesk.link:link",
      "new:org.onedesk.prompt:prompt",
      "new:org.onedesk.http:request",
    ]);
    expect(ENTRIES).toHaveLength(4);
  });

  it("picks the current locale's text from the label", async () => {
    const out = await registry(plugin).pages.welcome.render(ctxOf("zh-CN"));
    expect(out.view[0].text).toBe("zh:intro");
  });

  it("the manifest: a standalone startup page with no kinds", () => {
    const m = JSON.parse(readFileSync(new URL("./manifest.json", import.meta.url), "utf8"));
    expect(m.contributes.pages).toEqual([{ id: "welcome", startup: true }]);
    expect(m.contributes.kinds).toBeUndefined();
  });
});
