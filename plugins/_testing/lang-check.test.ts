import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { enUS } from "../../src/workbench/i18n/en-US";

const read = (p: string) => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url), "utf8")) as Record<string, string>;
// `{{secret:name}}` is a literal example in the text (the name after the colon is translated), not a placeholder.
const holes = (s: string) => (s.replace(/\{\{[^{}]*\}\}/g, "").match(/\{[^{}]+\}/g) ?? []).sort();

const LANGS = [
  { plugin: "org.onedesk.lang.zh-cn", locale: "zh-CN" },
  { plugin: "org.onedesk.lang.ja-jp", locale: "ja-JP" },
];

describe.each(LANGS)("language plugin $plugin", ({ plugin, locale }) => {
  const texts = read(`${plugin}/shell/${locale}.json`);
  const manifest = JSON.parse(readFileSync(new URL(`../${plugin}/manifest.json`, import.meta.url), "utf8"));

  it("declares exactly its one language", () => {
    expect(manifest.contributes.languages).toHaveLength(1);
    expect(manifest.contributes.languages[0]).toMatchObject({ locale, shell: `shell/${locale}.json` });
  });

  it("has exactly the keys of en-US.ts", () => {
    expect(Object.keys(texts).sort()).toEqual(Object.keys(enUS).sort());
  });

  it("keeps every {placeholder} and has no empty value", () => {
    const bad: string[] = [];
    for (const [k, en] of Object.entries(enUS)) {
      const v = texts[k];
      if (typeof v !== "string" || v.trim() === "") bad.push(`${k}: empty`);
      else if (holes(v).join() !== holes(en).join()) bad.push(`${k}: ${holes(en)} vs ${holes(v)}`);
    }
    expect(bad).toEqual([]);
  });

  it("is a flat string table under 1 MB", () => {
    expect(Object.values(texts).every((v) => typeof v === "string")).toBe(true);
    expect(JSON.stringify(texts).length).toBeLessThan(1_000_000);
  });
});
