import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dir = (p: string) => new URL(`../${p}`, import.meta.url);
const read = (p: string) => JSON.parse(readFileSync(dir(p), "utf8")) as Record<string, string>;
const holes = (s: string) => (s.replace(/\{\{[^{}]*\}\}/g, "").match(/\{[a-zA-Z_]+\}/g) ?? []).sort().join();

// Round 11 plugins and the ones that gained a Japanese file: English, Chinese and Japanese carry the same keys.
const PLUGINS = ["org.onedesk.link", "org.onedesk.prompt", "org.onedesk.note", "org.onedesk.http", "org.onedesk.welcome", "org.onedesk.lang.zh-cn", "org.onedesk.lang.ja-jp"];

describe.each(PLUGINS)("%s locales", (p) => {
  it("en-US, zh-CN and ja-JP have the same keys and {holes}", () => {
    const en = read(`${p}/locales/en-US.json`);
    for (const l of ["zh-CN", "ja-JP"]) {
      const other = read(`${p}/locales/${l}.json`);
      expect(Object.keys(other).sort(), l).toEqual(Object.keys(en).sort());
      for (const k of Object.keys(en)) expect(holes(other[k]!), `${l} ${k}`).toBe(holes(en[k]!));
    }
  });

  it("every file the manifest names exists", () => {
    const m = JSON.parse(readFileSync(dir(`${p}/manifest.json`), "utf8"));
    for (const f of Object.values(m.contributes.locales) as string[]) expect(readdirSync(dir(`${p}/locales`))).toContain(f.split("/")[1]);
  });
});
