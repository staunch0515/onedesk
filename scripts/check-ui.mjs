#!/usr/bin/env node
/**
 * UI rule check (D31). Fails closed.
 *  - CSS files are only allowed in src/design/ (pages are composed from components; no one-off styles).
 *  - Outside src/design/tokens.css, CSS must not hard-code colors (#hex, rgb(), hsl(), named colors in
 *    color properties), px/rem/em lengths, or ms/s durations. Use var(--token).
 *    Allowed literals: 0, 1 (unitless), 100%/50% and other percentages, `none`, `auto`, `inherit`, `currentColor`, `transparent`.
 *  - TSX in src/workbench, src/design must not use inline `style=` (exception: a line ending with
 *    `// od-allow-inline-style: <reason>`), nor hex colors / px values in string literals.
 *  - plugins/ and plugins-external/ must not contain CSS, TSX/JSX or HTML, nor inline styles / class names in JS (they return view trees only).
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, resolve, dirname, sep } from "node:path";
import { packageDirs, uiProblems } from "./plugin-rules.mjs";

const root = resolve(dirname(new URL(import.meta.url).pathname), "..");
const src = join(root, "src");
const errors = [];
const rel = (p) => relative(root, p);
function walk(dir, re) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p, re) : re.test(n) ? [p] : [];
  });
}

const tokensFile = join(src, "design", "tokens.css");

// CSS location
for (const f of walk(src, /\.css$/)) {
  if (!f.startsWith(join(src, "design") + sep)) errors.push(`${rel(f)}: CSS 只能放在 src/design/ 中`);
}

// CSS literals
const cssRules = [
  { re: /#[0-9a-fA-F]{3,8}\b/, msg: "写死的颜色（#hex）" },
  { re: /\b(rgba?|hsla?|oklch|lab|lch)\(/, msg: "写死的颜色函数" },
  { re: /(?<![\w-])-?\d*\.?\d+(px|rem|em|pt|vh|vw)\b/, msg: "写死的长度" },
  { re: /(?<![\w-])\d*\.?\d+m?s\b/, msg: "写死的时长" },
  { re: /(^|[\s:])(color|background|border(-\w+)?|outline|fill|stroke)\s*:\s*[^;]*\b(white|black|red|blue|green|gray|grey|orange|yellow|purple)\b/, msg: "写死的颜色名" },
  { re: /\bz-index\s*:\s*\d+/, msg: "写死的 z-index（用 --z-* token）" },
  { re: /font-family\s*:/, msg: "font-family 只能在 tokens.css 中定义" },
];
for (const f of walk(join(src, "design"), /\.css$/)) {
  if (f === tokensFile) continue;
  readFileSync(f, "utf8").split("\n").forEach((line, i) => {
    const code = line.replace(/\/\*.*?\*\//g, "");
    for (const { re, msg } of cssRules) if (re.test(code)) errors.push(`${rel(f)}:${i + 1}: ${msg} → ${line.trim()}`);
  });
}

// TSX rules
for (const dir of ["workbench", "design"]) {
  for (const f of walk(join(src, dir), /\.tsx?$/)) {
    if (/\.test\.tsx?$/.test(f)) continue;
    readFileSync(f, "utf8").split("\n").forEach((line, i) => {
      if (/\bstyle=\{/.test(line) && !/\/\/\s*od-allow-inline-style:\s*\S/.test(line)) errors.push(`${rel(f)}:${i + 1}: 不允许内联 style`);
      if (/["'`][^"'`]*#[0-9a-fA-F]{3,8}\b[^"'`]*["'`]/.test(line) && !/https?:\/\//.test(line)) errors.push(`${rel(f)}:${i + 1}: 代码中写死颜色`);
      if (/["'`]\s*-?\d+px\s*["'`]/.test(line)) errors.push(`${rel(f)}:${i + 1}: 代码中写死像素值`);
    });
  }
}

// Plugins render only through view trees (bundled and external, D456; rule in plugin-rules.mjs)
for (const dir of [...packageDirs(join(root, "plugins")), ...packageDirs(join(root, "plugins-external"))]) errors.push(...uiProblems(dir, rel));

if (errors.length) {
  console.error(`界面规范检查失败（${errors.length}）：\n- ${errors.join("\n- ")}`);
  process.exit(1);
}
console.log("界面规范检查通过");
