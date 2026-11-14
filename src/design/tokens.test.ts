import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Contrast check for every text/background pair the components use (WCAG AA ≥ 4.5:1 for text,
 * ≥ 3:1 for the focus ring). Run with OD_CONTRAST_REPORT=1 to print the full table.
 */
const css = readFileSync(fileURLToPath(new URL("./tokens.css", import.meta.url)), "utf8");

function block(startMarker: string, from = 0): string {
  const start = css.indexOf(startMarker, from);
  if (start < 0) throw new Error(`tokens.css: 找不到 ${startMarker}`);
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  return css.slice(open + 1, close);
}

function decls(body: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) map.set(m[1]!, m[2]!.trim());
  return map;
}

const light = decls(block(':root,\n[data-theme="light"]'));
const dark = decls(block(':root[data-theme="dark"]'));
const darkSystem = decls(block(":root:not([data-theme])", css.indexOf("@media (prefers-color-scheme: dark)")));

type Rgb = [number, number, number];
function parseHex(value: string): Rgb {
  const m = /^#([0-9a-f]{6})$/i.exec(value);
  if (!m) throw new Error(`不是 6 位十六进制颜色：${value}`);
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function luminance([r, g, b]: Rgb): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
function contrast(a: string, b: string): number {
  const la = luminance(parseHex(a));
  const lb = luminance(parseHex(b));
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const TEXT = 4.5;
const UI = 3;
const surfaces = ["--bg-app", "--bg-surface", "--bg-subtle", "--bg-hover", "--bg-elevated", "--bg-inset"];
const pairs: Array<[fg: string, bg: string, min: number]> = [
  ...["--fg-default", "--fg-muted", "--fg-subtle"].flatMap((fg) => surfaces.map((bg): [string, string, number] => [fg, bg, TEXT])),
  ...surfaces.map((bg): [string, string, number] => ["--fg-inactive", bg, TEXT]),
  ["--fg-default", "--bg-active", TEXT],
  ["--fg-muted", "--bg-active", TEXT],
  ["--fg-default", "--bg-selected", TEXT],
  ["--fg-selected", "--bg-selected", TEXT],
  ["--accent-text", "--bg-surface", TEXT],
  ["--accent-text", "--bg-app", TEXT],
  ["--accent-text", "--accent-subtle", TEXT],
  ["--fg-on-accent", "--accent", TEXT],
  ["--fg-on-accent", "--accent-hover", TEXT],
  ["--fg-on-accent", "--accent-active", TEXT],
  ["--fg-on-accent", "--danger", TEXT],
  ["--fg-on-accent", "--danger-hover", TEXT],
  ["--fg-on-accent", "--success", TEXT],
  ["--fg-inverse", "--bg-inverse", TEXT],
  ...["success", "warning", "danger", "info"].flatMap((tone): Array<[string, string, number]> => [
    [`--${tone}-text`, `--${tone}-subtle`, TEXT],
    [`--${tone}-text`, "--bg-surface", TEXT],
    ["--fg-default", `--${tone}-subtle`, TEXT],
  ]),
  ["--focus-ring", "--bg-surface", UI],
  ["--focus-ring", "--bg-app", UI],
  ["--focus-ring", "--bg-selected", UI],
];

function report(theme: Map<string, string>) {
  return pairs.map(([fg, bg, min]) => {
    const ratio = contrast(theme.get(fg)!, theme.get(bg)!);
    return { fg, bg, min, ratio: Math.round(ratio * 100) / 100 };
  });
}

describe("design tokens", () => {
  it("defines the dark palette identically for the attribute and the system preference", () => {
    expect([...darkSystem.entries()]).toEqual([...dark.entries()]);
  });

  it("defines the same color tokens in light and dark", () => {
    expect([...dark.keys()].sort()).toEqual([...light.keys()].sort());
  });

  for (const [name, theme] of [["light", light], ["dark", dark]] as const) {
    it(`meets WCAG AA contrast in ${name}`, () => {
      const rows = report(theme);
      if (process.env.OD_CONTRAST_REPORT) console.table(rows);
      const failures = rows.filter((r) => r.ratio < r.min);
      expect(failures).toEqual([]);
    });
  }
});
