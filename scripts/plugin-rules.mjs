/**
 * Rules for ONE plugin package folder, shared by scripts/check-arch.mjs, scripts/check-ui.mjs and
 * scripts/plugin-tool.mjs (D456). Every function returns a list of problems (strings, Chinese like the
 * other checks); an empty list means the folder passes. Fails closed: when unsure, report.
 *
 * Package layout (docs/plugins/spec.md): manifest.json, main.js, locales/*.json, optional README.md,
 * tests next to the source (*.test.ts, never packed).
 */
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

/** Every file under `dir` (not following links); links are reported by `layoutProblems`. */
export function walkFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((n) => {
    if (n === "node_modules") return [];
    const p = join(dir, n);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) return [p];
    return st.isDirectory() ? walkFiles(p) : [p];
  });
}

export const importsOf = (code) =>
  [...code.matchAll(/(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s*['"]([^'"]+)['"]/gm)].map((m) => m[1] ?? m[2] ?? m[3]);

const isTest = (f) => /\.test\.tsx?$/.test(f);
/** What a test file may import besides its own package: the shared test kit and generated protocol types. */
const TEST_IMPORT_OK = (spec) =>
  ["vitest", "node:fs", "node:path", "node:url"].includes(spec) ||
  /^(\.\.\/)+(plugins\/)?_testing\//.test(spec) ||
  /^(\.\.\/)+src\/workbench\/protocol\/generated/.test(spec);

const SANDBOX_ABSENT = /(?<![\w.$])(console|setTimeout|setInterval|fetch|XMLHttpRequest|window|document|localStorage|require|process)\s*[.(]/;

/** Architecture rule 4: no imports outside the package, no globals the sandbox does not have. */
export function archProblems(dir, rel = (p) => p) {
  const errors = [];
  for (const f of walkFiles(dir).filter((f) => /\.(js|mjs|ts|tsx)$/.test(f))) {
    const code = readFileSync(f, "utf8");
    for (const spec of importsOf(code)) {
      if (isTest(f) && TEST_IMPORT_OK(spec)) continue;
      if (spec.startsWith(".")) {
        const target = resolve(dirname(f), spec);
        if (target === dir || target.startsWith(dir + sep)) continue;
      }
      errors.push(`${rel(f)}: 插件只能 import 自己文件夹内的文件，发现 "${spec}"`);
    }
    if (!isTest(f)) {
      code.split("\n").forEach((line, i) => {
        const l = line.replace(/\/\/.*$/, "");
        if (SANDBOX_ABSENT.test(l)) errors.push(`${rel(f)}:${i + 1}: 沙箱里没有这个全局对象 → ${line.trim()}`);
      });
    }
  }
  return errors;
}

/** UI rule (D31): plugins return view trees only. */
export function uiProblems(dir, rel = (p) => p) {
  const errors = [];
  for (const f of walkFiles(dir)) {
    if (/\.(css|scss|less|tsx|jsx|html)$/.test(f)) errors.push(`${rel(f)}: 插件不得包含 CSS、TSX/JSX 或 HTML，只能返回视图树`);
  }
  for (const f of walkFiles(dir).filter((f) => /\.(js|mjs|ts)$/.test(f) && !isTest(f))) {
    readFileSync(f, "utf8").split("\n").forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, "");
      if (/\b(style|className)\s*[:=]|\.style\b|innerHTML/.test(code)) errors.push(`${rel(f)}:${i + 1}: 插件不得使用样式、class 或 HTML`);
      if (/["'`][^"'`]*#[0-9a-fA-F]{3,8}\b[^"'`]*["'`]/.test(code) || /["'`]\s*-?\d+px\s*["'`]/.test(code)) errors.push(`${rel(f)}:${i + 1}: 插件中写死颜色或像素值`);
    });
  }
  return errors;
}

const holes = (s) => (String(s).replace(/\{\{[^{}]*\}\}/g, "").match(/\{[a-zA-Z_]+\}/g) ?? []).sort().join();

/** Layout, manifest basics and locale completeness (the strict manifest check is the kernel's: plugin-tool runs it). */
export function layoutProblems(dir, rel = (p) => p) {
  const errors = [];
  const mfPath = join(dir, "manifest.json");
  if (!existsSync(mfPath)) return [`${rel(dir)}: 缺少 manifest.json`];
  let m;
  try {
    m = JSON.parse(readFileSync(mfPath, "utf8"));
  } catch (e) {
    return [`${rel(mfPath)}: 不是合法 JSON（${e.message}）`];
  }
  // `._*` and `.DS_Store` (macOS on exFAT/network disks) are not errors: the kernel ignores them (D455) and
  // plugin:pack leaves them out.
  for (const f of walkFiles(dir)) if (lstatSync(f).isSymbolicLink()) errors.push(`${rel(f)}: 包里不能有链接`);
  const folder = dir.split(sep).pop();
  if (folder !== m.id && folder !== m.version) errors.push(`${rel(dir)}: 文件夹名应等于清单 id "${m.id}"`);
  if (m.apiVersion !== "2") errors.push(`${rel(mfPath)}: apiVersion 必须是 "2"`);
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(String(m.version ?? ""))) errors.push(`${rel(mfPath)}: version 不是 semver："${m.version}"`);
  if (!/^[a-z0-9]+(\.[a-z0-9-]+)+$/.test(String(m.id ?? ""))) errors.push(`${rel(mfPath)}: id 应是反向域名形式（小写），如 org.example.notes`);
  if (!existsSync(join(dir, m.main ?? "main.js"))) errors.push(`${rel(dir)}: 缺少入口文件 ${m.main ?? "main.js"}`);
  const locales = m.contributes?.locales ?? {};
  if (!locales["en-US"]) errors.push(`${rel(mfPath)}: contributes.locales 必须有 en-US（兜底语言）`);
  let en = null;
  const read = (l, p) => {
    try {
      return JSON.parse(readFileSync(join(dir, p), "utf8"));
    } catch (e) {
      errors.push(`${rel(join(dir, p))}: ${l} 语言文件不存在或不是合法 JSON`);
      return null;
    }
  };
  if (locales["en-US"]) en = read("en-US", locales["en-US"]);
  if (en) {
    for (const key of [m.name, m.description].filter(Boolean)) if (!(key in en)) errors.push(`${rel(mfPath)}: 语言键 "${key}" 不在 en-US 里`);
    for (const [l, p] of Object.entries(locales)) {
      if (l === "en-US") continue;
      const other = read(l, p);
      if (!other) continue;
      const missing = Object.keys(en).filter((k) => !(k in other));
      const extra = Object.keys(other).filter((k) => !(k in en));
      if (missing.length) errors.push(`${rel(join(dir, p))}: 缺少 ${missing.length} 个键（如 ${missing.slice(0, 3).join(", ")}）`);
      if (extra.length) errors.push(`${rel(join(dir, p))}: 多出 ${extra.length} 个 en-US 没有的键（如 ${extra.slice(0, 3).join(", ")}）`);
      for (const k of Object.keys(en)) if (k in other && holes(other[k]) !== holes(en[k])) errors.push(`${rel(join(dir, p))}: "${k}" 的 {占位} 与 en-US 不一致`);
    }
  }
  return errors;
}

/** Plugin package folders directly under `root` (folders with a manifest.json; `_*` are test kits). */
export function packageDirs(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((d) => !d.startsWith("_") && !d.startsWith("."))
    .map((d) => join(root, d))
    .filter((d) => existsSync(join(d, "manifest.json")));
}

export const relTo = (root) => (p) => relative(root, p);
