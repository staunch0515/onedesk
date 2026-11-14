#!/usr/bin/env node
/**
 * Architecture boundary check (fails closed: when unsure, reject).
 *  1. src/kernel must not import plugins/, shell/, design/, platform/ (or react).
 *  2. src/kernel must not mention any built-in plugin id or kind (ids and kinds are read from
 *     src/plugins/<dir>/manifest.json every run, so the list never goes stale).
 *  3. src/plugins/<dir> may only import `@onedesk/plugin-api` and files inside its own folder.
 *  4. src/plugin-api must not import kernel/, shell/, design/, platform/, plugins/.
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, resolve, dirname, sep } from "node:path";

const root = resolve(dirname(new URL(import.meta.url).pathname), "..");
const src = join(root, "src");
const errors = [];
const warnings = [];

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx|mjs|js)$/.test(name) ? [p] : [];
  });
}
const rel = (p) => relative(root, p);
const importsOf = (code) =>
  [...code.matchAll(/(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1] ?? m[2]);

// Words that are also generic view-node / output types in the public API. A kind with such a name is
// ambiguous for a plain string search, so we warn and fall back to kind-specific patterns.
const GENERIC_WORDS = new Set(["form", "table", "text", "link", "file", "none"]);

// ---- collect built-in plugin ids and kinds from manifests
const pluginsDir = join(src, "plugins");
const builtins = [];
if (existsSync(pluginsDir)) {
  for (const d of readdirSync(pluginsDir)) {
    const mf = join(pluginsDir, d, "manifest.json");
    if (!existsSync(mf)) continue;
    try {
      const m = JSON.parse(readFileSync(mf, "utf8"));
      builtins.push({ dir: d, id: m.id, kinds: m.provides?.kinds ?? [] });
    } catch (e) {
      errors.push(`${rel(mf)}: manifest.json 不是合法 JSON（${e.message}）`);
    }
  }
}

// ---- 1 & 2: kernel
const kernelFiles = walk(join(src, "kernel"));
for (const f of kernelFiles) {
  const code = readFileSync(f, "utf8");
  const isTest = /\.test\.tsx?$/.test(f) || f.includes(`${sep}testing${sep}`);
  for (const spec of importsOf(code)) {
    if (/(^|\/)(plugins|shell|design|platform)(\/|$)/.test(spec) || spec === "react" || spec.startsWith("@tauri-apps/")) {
      // Tests may load built-in plugins to exercise the real public path, never production kernel code.
      if (isTest && /(^|\/)plugins(\/|$)/.test(spec)) continue;
      errors.push(`${rel(f)}: 内核不得 import "${spec}"`);
    }
  }
  if (isTest) continue;
  for (const b of builtins) {
    if (b.id && code.includes(b.id)) errors.push(`${rel(f)}: 内核出现内置插件 id "${b.id}"`);
    for (const k of b.kinds) {
      if (GENERIC_WORDS.has(k)) {
        warnings.push(`kind "${k}"（${b.dir}）与通用视图节点/输出类型同名，只检查 kind 相关写法`);
        const re = new RegExp(`kind\\s*(===|!==|==|:)\\s*["'\`]${k}["'\`]|["'\`]${k}["'\`]\\s*(===|!==|==)\\s*\\w*kind`);
        if (re.test(code)) errors.push(`${rel(f)}: 内核出现针对 kind "${k}" 的判断`);
      } else if (new RegExp(`["'\`]${k.replace(/[-]/g, "\\-")}["'\`]`).test(code)) {
        errors.push(`${rel(f)}: 内核出现内置 kind "${k}"`);
      }
    }
  }
}

// ---- 3: plugins
for (const b of builtins) {
  const dir = join(pluginsDir, b.dir);
  for (const f of walk(dir)) {
    for (const spec of importsOf(readFileSync(f, "utf8"))) {
      if (spec === "@onedesk/plugin-api") continue;
      if (/\.test\.tsx?$/.test(f) && (spec === "vitest" || /(^|\/)(kernel|plugins)\/testing(\/|$)|^\.\.\/testing(\/|$)/.test(spec))) continue;
      if (spec.startsWith(".")) {
        const target = resolve(dirname(f), spec);
        if (target === dir || target.startsWith(dir + sep)) continue;
      }
      errors.push(`${rel(f)}: 插件只能 import "@onedesk/plugin-api" 和自己文件夹内的文件，发现 "${spec}"`);
    }
  }
}

// ---- 4: plugin-api
for (const f of walk(join(src, "plugin-api"))) {
  for (const spec of importsOf(readFileSync(f, "utf8"))) {
    if (/(^|\/)(kernel|shell|design|platform|plugins)(\/|$)/.test(spec)) errors.push(`${rel(f)}: plugin-api 不得 import "${spec}"`);
  }
}

for (const w of new Set(warnings)) console.warn(`警告：${w}`);
if (errors.length) {
  console.error(`架构检查失败（${errors.length}）：\n- ${errors.join("\n- ")}`);
  process.exit(1);
}
console.log(`架构检查通过（内核 ${kernelFiles.length} 个文件，内置插件 ${builtins.length} 个）`);
