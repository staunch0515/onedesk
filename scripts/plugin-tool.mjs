#!/usr/bin/env node
/**
 * Plugin author tool (D456). docs/plugins/workflow.md explains the process.
 *
 *   pnpm plugin:check <plugin-dir>          layout, manifest (strict, by the kernel), locales, UI and
 *                                           architecture rules, then the plugin's own tests
 *   pnpm plugin:pack  <plugin-dir> [--out <dir>] [--skip-tests]
 *                                           check, then write <out>/<id>-<version>.odplugin (default out: dist/plugins)
 *   pnpm plugin:pack-all [--out <dir>]      pack every package under plugins-external/
 *
 * The .odplugin file is a plain zip: manifest.json at the root, no tests, no `._*` / `.DS_Store`, no links.
 * Entries are sorted and carry a fixed time, so packing the same files twice gives the same bytes.
 */
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import { archProblems, layoutProblems, packageDirs, uiProblems, walkFiles } from "./plugin-rules.mjs";

const root = resolve(dirname(new URL(import.meta.url).pathname), "..");
const MAX_BYTES = 200 * 1024 * 1024; // the host refuses bigger packages (crates/host/src/install.rs)

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** The kernel's own strict manifest check, through the `onedesk-plugin` program (built on demand). */
function kernelCheck(dir) {
  const target = process.env.CARGO_TARGET_DIR || join(root, "target");
  const bin = join(target, "debug", "onedesk-plugin");
  const build = spawnSync("cargo", ["build", "-q", "-p", "onedesk-host", "--bin", "onedesk-plugin"], { cwd: root, stdio: "inherit" });
  if (build.status !== 0 && !existsSync(bin)) return [`无法构建 onedesk-plugin（需要 Rust 工具链）`];
  const out = spawnSync(bin, ["check", dir], { encoding: "utf8" });
  if (out.status === 0) return [];
  let r;
  try {
    r = JSON.parse(out.stdout);
  } catch {
    return [`内核检查失败：${out.stderr || out.stdout}`];
  }
  return [`清单被内核拒绝：${r.reason}${r.detail ? ` — ${r.detail}` : ""}`];
}

function check(dir, { tests = true } = {}) {
  const rel = (p) => {
    const r = relative(process.cwd(), p);
    return r.startsWith("..") ? p : r || ".";
  };
  const problems = [...layoutProblems(dir, rel)];
  if (problems.length === 0) problems.push(...kernelCheck(dir));
  problems.push(...uiProblems(dir, rel), ...archProblems(dir, rel));
  if (problems.length) fail(`插件检查失败（${problems.length}）：\n- ${problems.join("\n- ")}`);
  const testFiles = walkFiles(dir).filter((f) => /\.test\.ts$/.test(f) && !f.split(sep).pop().startsWith("._"));
  if (tests) {
    if (testFiles.length === 0) fail(`插件检查失败：${rel(dir)} 没有测试（至少要有 main.test.ts，见 docs/plugins/acceptance.md）`);
    const run = spawnSync("pnpm", ["exec", "vitest", "run", ...testFiles.map((f) => relative(root, f))], { cwd: root, stdio: "inherit" });
    if (run.status !== 0) fail("插件检查失败：测试没有通过");
  }
  const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  console.log(`插件检查通过：${m.id} ${m.version}${tests ? `（${testFiles.length} 个测试文件）` : ""}`);
  return m;
}

/** Files that go into the package, as [path inside the zip, absolute path], sorted. */
export function packageEntries(dir) {
  return walkFiles(dir)
    .filter((f) => {
      const name = f.split(sep).pop();
      return !/\.test\.[cm]?[jt]sx?$/.test(name) && !name.startsWith("._") && name !== ".DS_Store" && !lstatSync(f).isSymbolicLink();
    })
    .map((f) => [relative(dir, f).split(sep).join("/"), f])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** A minimal zip writer: deflate (or stored when that is smaller), fixed time 1980-01-01 00:00, no extras. */
export function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const deflated = deflateRawSync(data, { level: 9 });
    const stored = deflated.length >= data.length;
    const body = stored ? data : deflated;
    const crc = crc32(data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4); // version needed
    head.writeUInt16LE(0x0800, 6); // UTF-8 names
    head.writeUInt16LE(stored ? 0 : 8, 8);
    head.writeUInt16LE(0, 10); // time
    head.writeUInt16LE(0x21, 12); // date 1980-01-01
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(body.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(nameBuf.length, 26);
    head.writeUInt16LE(0, 28);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(0x0314, 4); // made by: Unix, 2.0
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(stored ? 0 : 8, 10);
    cen.writeUInt16LE(0, 12);
    cen.writeUInt16LE(0x21, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(body.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE((0o100644 << 16) >>> 0, 38); // regular file, rw-r--r--
    cen.writeUInt32LE(offset, 42);
    locals.push(head, nameBuf, body);
    centrals.push(cen, nameBuf);
    offset += head.length + nameBuf.length + body.length;
  }
  const cenSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cenSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

function pack(dir, out, opts) {
  const m = check(dir, opts);
  const entries = packageEntries(dir).map(([name, f]) => [name, readFileSync(f)]);
  const total = entries.reduce((n, [, d]) => n + d.length, 0);
  if (total > MAX_BYTES) fail(`插件太大：${total} 字节，上限 ${MAX_BYTES}`);
  mkdirSync(out, { recursive: true });
  const file = join(out, `${m.id}-${m.version}.odplugin`);
  writeFileSync(file, zip(entries));
  console.log(`已打包：${relative(process.cwd(), file)}（${entries.length} 个文件）`);
  return file;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (isMain) {
  const [cmd, target] = process.argv.slice(2);
  const out = resolve(arg("--out") ?? join(root, "dist", "plugins"));
  const opts = { tests: !process.argv.includes("--skip-tests") };
  const dirOf = (t) => {
    if (!t) fail("用法：pnpm plugin:check <插件文件夹> | pnpm plugin:pack <插件文件夹> [--out <目录>] | pnpm plugin:pack-all");
    const d = resolve(t);
    if (!existsSync(join(d, "manifest.json"))) fail(`${t} 不是插件文件夹（没有 manifest.json）`);
    return d;
  };
  if (cmd === "check") check(dirOf(target), opts);
  else if (cmd === "pack") pack(dirOf(target), out, opts);
  else if (cmd === "pack-all") for (const d of packageDirs(join(root, "plugins-external"))) pack(d, out, opts);
  else fail(`未知命令 ${cmd ?? ""}（check | pack | pack-all）`);
}

