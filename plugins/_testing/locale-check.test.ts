import { existsSync, readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Official plugins live in plugins/ (bundled) and plugins-external/ (D456); both are checked.
const ROOTS = [new URL("../", import.meta.url), new URL("../../plugins-external/", import.meta.url)];
const dir = (p: string) => {
  const [first] = p.split("/");
  const root = ROOTS.find((r) => first && existsSync(new URL(first, r))) ?? ROOTS[0]!;
  return new URL(p, root);
};
const read = (p: string) => JSON.parse(readFileSync(dir(p), "utf8")) as Record<string, string>;
const holes = (s: string) => (s.replace(/\{\{[^{}]*\}\}/g, "").match(/\{[a-zA-Z_]+\}/g) ?? []).sort().join();

// Every built-in plugin: English, Chinese and Japanese carry the same keys, and the manifest names all three files.
const PLUGINS = ROOTS.flatMap((r) => (existsSync(r) ? readdirSync(r) : [])).filter((d) => d.startsWith("org.onedesk.")).sort();

describe.each(PLUGINS)("%s locales", (p) => {
  it("en-US, zh-CN and ja-JP have the same keys and {holes}", () => {
    const en = read(`${p}/locales/en-US.json`);
    for (const l of ["zh-CN", "ja-JP"]) {
      const other = read(`${p}/locales/${l}.json`);
      expect(Object.keys(other).sort(), l).toEqual(Object.keys(en).sort());
      for (const k of Object.keys(en)) expect(holes(other[k]!), `${l} ${k}`).toBe(holes(en[k]!));
    }
  });

  it("the manifest names en-US, zh-CN and ja-JP", () => {
    const m = JSON.parse(readFileSync(dir(`${p}/manifest.json`), "utf8"));
    expect(Object.keys(m.contributes.locales).sort()).toEqual(["en-US", "ja-JP", "zh-CN"]);
  });

  it("every file the manifest names exists", () => {
    const m = JSON.parse(readFileSync(dir(`${p}/manifest.json`), "utf8"));
    for (const f of Object.values(m.contributes.locales) as string[]) expect(readdirSync(dir(`${p}/locales`))).toContain(f.split("/")[1]);
  });
});
