// Test fixture: generates N minimal valid plugin packages (for the "10 000 manifests" start-up check).
//   node e2e/fixtures/make-many-plugins.mjs <dir> <count>
// Writes <dir>/<id>/0.1.0/{manifest.json,main.js,locales/en-US.json}; ids are com.example.many-00001 … Only writes inside
// <dir>; refuses the real data directory (~/Library/Application Support/onedesk*) and anything inside it.
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const VERSION = "0.1.0";
export const MAX_COUNT = 100000;

export function packageId(i) {
  return `com.example.many-${String(i + 1).padStart(5, "0")}`;
}

export function manifestOf(id) {
  return {
    id,
    version: VERSION,
    apiVersion: "2",
    name: "plugin.name",
    description: "plugin.description",
    icon: "box",
    main: "main.js",
    author: "OneDesk",
    license: "MIT",
    requires: { files: false },
    contributes: { locales: { "en-US": "locales/en-US.json" } },
  };
}

/** True when `dir` is (inside) a real OneDesk data directory. */
export function isProtected(dir, home = homedir()) {
  const p = resolve(dir);
  const base = join(home, "Library", "Application Support");
  return p === base || p.startsWith(base + sep + "onedesk") || /\/Library\/Application Support\/onedesk[^/]*(\/|$)/i.test(p);
}

/** Creates `count` packages under `dir`; returns the package ids in order. */
export function makeManyPlugins(dir, count) {
  if (typeof dir !== "string" || !dir) throw new Error("a target directory is required");
  if (!Number.isInteger(count) || count < 0 || count > MAX_COUNT) throw new Error(`count must be an integer from 0 to ${MAX_COUNT}`);
  const root = resolve(dir);
  if (isProtected(root)) throw new Error(`refusing to write into a OneDesk data directory: ${root}`);
  const ids = [];
  for (let i = 0; i < count; i++) {
    const id = packageId(i);
    const pkg = join(root, id, VERSION);
    mkdirSync(join(pkg, "locales"), { recursive: true });
    writeFileSync(join(pkg, "manifest.json"), JSON.stringify(manifestOf(id), null, 2) + "\n");
    writeFileSync(join(pkg, "main.js"), "export default { activate() {} };\n");
    writeFileSync(join(pkg, "locales", "en-US.json"), JSON.stringify({ "plugin.name": `Many ${i + 1}`, "plugin.description": "Generated test package." }, null, 2) + "\n");
    ids.push(id);
  }
  return ids;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [dir, n] = process.argv.slice(2);
  try {
    const ids = makeManyPlugins(dir, Number(n));
    console.log(`wrote ${ids.length} packages to ${resolve(dir)}`);
  } catch (e) {
    console.error(String(e && e.message));
    process.exit(1);
  }
}
