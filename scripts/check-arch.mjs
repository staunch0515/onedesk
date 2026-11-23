#!/usr/bin/env node
/**
 * Architecture boundary check (fails closed: when unsure, reject).
 *  1. crates/kernel, crates/worker, crates/protocol, crates/host, src-tauri: source (not tests/fixtures)
 *     must not mention any plugin id under plugins/ or its kind names, nor the banned tool words
 *     (note, sql, postgres, ssh, docker, psql, video, ffmpeg) as whole words.
 *  2. crates/kernel must not depend on tauri.
 *  3. src/workbench must not import plugins/; only main.tsx may import protocol/mock.
 *  4. plugins/<id> and plugins-external/<id>: no imports outside the package, no browser/sandbox-absent globals
 *     (the rule itself is in plugin-rules.mjs, shared with `pnpm plugin:check`).
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { stripAllowedAi } from "./check-arch-ai.mjs";
import { archProblems } from "./plugin-rules.mjs";
import { join, relative, resolve, dirname, sep } from "node:path";

const root = resolve(dirname(new URL(import.meta.url).pathname), "..");
const errors = [];
const rel = (p) => relative(root, p);
const walk = (dir, re) =>
  !existsSync(dir)
    ? []
    : readdirSync(dir).flatMap((n) => {
        if (n === "node_modules" || n === "target" || n === "generated") return [];
        const p = join(dir, n);
        return statSync(p).isDirectory() ? walk(p, re) : re.test(n) ? [p] : [];
      });
const importsOf = (code) =>
  [...code.matchAll(/(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s*['"]([^'"]+)['"]/gm)].map((m) => m[1] ?? m[2] ?? m[3]);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ---- plugins: ids and kind names come from the manifests every run (bundled and external, D456)
const pluginRoots = [join(root, "plugins"), join(root, "plugins-external")];
const plugins = [];
for (const pluginsDir of pluginRoots) {
  if (!existsSync(pluginsDir)) continue;
  for (const d of readdirSync(pluginsDir)) {
    const mf = join(pluginsDir, d, "manifest.json");
    if (!existsSync(mf)) continue;
    try {
      const m = JSON.parse(readFileSync(mf, "utf8"));
      const kinds = (m.contributes?.kinds ?? []).map((k) => k.id);
      plugins.push({ dir: join(pluginsDir, d), id: m.id, kinds });
    } catch (e) {
      errors.push(`${rel(mf)}: manifest.json 不是合法 JSON（${e.message}）`);
    }
  }
}

// ---- 1: kernel-side sources know no concrete plugin
const BANNED_WORDS = ["note", "sql", "postgres", "postgresql", "ssh", "docker", "psql", "video", "ffmpeg", "bash", "pg_dump", "pg_restore", "disk-file", "anthropic", "ollama", "claude", "ai", "sse", "ndjson", "sqlpool", "list_tables", "run_sql", "search_queries", "describe_query", "run_query"]; // round 19: + sqlpool and its five tool names (the generic tools are search/describe/run/get_run; `mcp` itself stays allowed: it is the kernel's generic command prefix). round 18: + anthropic, ollama, claude, ai, sse, ndjson (whole words, case-insensitive; `ai` also matches the id segment in org.onedesk.ai). round 17: + bash, pg_dump, pg_restore, disk-file (ssh and docker were already here)
const wordRe = new RegExp(`(?<![A-Za-z0-9_])(${BANNED_WORDS.join("|")})(?![A-Za-z0-9_])`, "i");
const wordReNoSql = new RegExp(`(?<![A-Za-z0-9_])(${BANNED_WORDS.filter((w) => w !== "sql").join("|")})(?![A-Za-z0-9_])`, "i");
// Round 15 (D412): the kernel's own SQLite layer makes the word `sql` unusable as a ban there, so what is
// banned in crates/kernel is what only a database plugin would write: a "sql" string (a language or kind
// name), PostgreSQL's words, and read-only transaction / timeout statements.
const kernelDbRe = /["'`]sql["'`]|postgres|pg_dump|pg_restore|statement_timeout|BEGIN\s+READ\s+ONLY|READ\s+ONLY\s*;/i;
const kernelSide = ["crates/kernel", "crates/worker", "crates/protocol", "crates/host", "src-tauri"].map((d) => join(root, d));
const isFixture = (f) => f.includes(`${sep}tests${sep}fixtures${sep}`) || f.includes(`${sep}gen${sep}`);
// Doc comments and `#[cfg(test)]` modules (last in the file by convention) are not scanned for words.
const stripRust = (f, code) => {
  if (!f.endsWith(".rs")) return code;
  const cut = code.indexOf("#[cfg(test)]");
  return (cut >= 0 ? code.slice(0, cut) : code).replace(/\/\/.*$/gm, "");
};
let scanned = 0;
for (const dir of kernelSide) {
  for (const f of walk(dir, /\.(rs|toml|json|sql|ts|js|mjs)$/)) {
    if (isFixture(f) || /(^|\/)(Cargo\.lock|package-lock\.json)$/.test(f)) continue;
    scanned++;
    const code = stripRust(f, readFileSync(f, "utf8"));
    const errors_ = errors;
    for (const p of plugins) {
      if (p.id && code.includes(p.id)) errors_.push(`${rel(f)}: 出现内置插件 id "${p.id}"`);
      for (const k of p.kinds) {
        if (new RegExp(`${esc(p.id)}:${esc(k)}\\b`).test(code)) errors_.push(`${rel(f)}: 出现内置类型 "${p.id}:${k}"`);
      }
    }
    // `sql` is a database word in crates/kernel (SQLite layer), and tests use made-up plugin ids such as
    // org.test.note; the real-id/kind checks above still apply to both.
    const isTestFile = f.includes(`${sep}tests${sep}`);
    const re = f.includes(`${sep}crates${sep}kernel${sep}`) ? wordReNoSql : wordRe;
    if (isTestFile) continue;
    const inKernel = f.includes(`${sep}crates${sep}kernel${sep}`) && f.endsWith(".rs");
    code.split("\n").forEach((rawLine, i) => {
      // Migration file names (`include_str!("migrations/0003_x.sql")`) and the SQLite binding's own names
      // (`rusqlite`, `SQLITE_*`) belong to the kernel's storage layer, not to a database plugin.
      const line = stripAllowedAi(rawLine, f).replace(/include_str!\s*\([^)]*\)/g, "").replace(/\brusqlite\b|\bSQLITE_[A-Z0-9_]+/g, "");
      const m = re.exec(line);
      if (m) errors_.push(`${rel(f)}:${i + 1}: 出现具体插件相关的词 "${m[1]}"`);
      const k = inKernel ? kernelDbRe.exec(line) : null;
      if (k) errors_.push(`${rel(f)}:${i + 1}: 内核里出现数据库插件才会写的内容 "${k[0]}"`);
    });
  }
}

// ---- 2: kernel must not depend on tauri
const kernelToml = join(root, "crates/kernel/Cargo.toml");
if (existsSync(kernelToml) && /^\s*tauri[\w-]*\s*[=.{]/m.test(readFileSync(kernelToml, "utf8"))) errors.push("crates/kernel/Cargo.toml: 内核不得依赖 tauri");
for (const f of walk(join(root, "crates/kernel"), /\.rs$/)) {
  if (/\btauri\b/.test(readFileSync(f, "utf8").replace(/\/\/.*$/gm, ""))) errors.push(`${rel(f)}: 内核源码不得使用 tauri`);
}

// ---- 3: workbench imports
const wb = join(root, "src/workbench");
for (const f of walk(wb, /\.(ts|tsx)$/)) {
  const isMain = f === join(wb, "main.tsx");
  const isTest = /\.test\.tsx?$/.test(f);
  for (const spec of importsOf(readFileSync(f, "utf8"))) {
    if (/(^|\/)plugins(-external)?(\/|$)/.test(spec) && spec.startsWith(".")) errors.push(`${rel(f)}: 外壳不得 import plugins/ ("${spec}")`);
    const toMock = /(^|\/)mock(\/|$)/.test(spec) && (/protocol\/mock/.test(spec) || f.includes(`${sep}protocol${sep}`));
    if (toMock && !isMain && !isTest && !f.includes(`${sep}protocol${sep}mock${sep}`)) errors.push(`${rel(f)}: 只有 main.tsx 可以 import protocol/mock ("${spec}")`);
  }
}

// ---- 4: plugin packages
let pluginFiles = 0;
for (const p of plugins) {
  pluginFiles += walk(p.dir, /\.(js|mjs|ts|tsx)$/).length;
  errors.push(...archProblems(p.dir, rel));
}

if (errors.length) {
  console.error(`架构检查失败（${errors.length}）：\n- ${errors.join("\n- ")}`);
  process.exit(1);
}
console.log(`架构检查通过（内核侧 ${scanned} 个文件，内置插件 ${plugins.length} 个，插件文件 ${pluginFiles} 个）`);
