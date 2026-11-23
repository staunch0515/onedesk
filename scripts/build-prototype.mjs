// Builds the workbench prototype into ONE self-contained HTML file (dist/prototype/workbench.html) that opens
// by double-click, with no server and no network. Run: pnpm prototype:build
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const outDir = mkdtempSync(join(tmpdir(), "onedesk-prototype-"));

await build({
  root,
  configFile: false,
  logLevel: "warn",
  plugins: [react()],
  base: "./",
  build: {
    outDir,
    emptyOutDir: true,
    cssCodeSplit: false,
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    rollupOptions: { input: join(root, "workbench.html"), output: { codeSplitting: false } },
  },
});

let html = readFileSync(join(outDir, "workbench.html"), "utf8");
const assets = join(outDir, "assets");
const files = readdirSync(assets);
const leftovers = files.filter((f) => !f.endsWith(".js") && !f.endsWith(".css"));
if (leftovers.length > 0) throw new Error(`Not inlined: ${leftovers.join(", ")}`);
const scripts = files.filter((f) => f.endsWith(".js"));
if (scripts.length !== 1) throw new Error(`Expected one script, got ${scripts.length}: ${scripts.join(", ")}`);

for (const f of files.filter((x) => x.endsWith(".css"))) {
  const css = readFileSync(join(assets, f), "utf8");
  const tag = new RegExp(`<link[^>]*href="[^"]*${f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*>`);
  if (!tag.test(html)) throw new Error(`No <link> for ${f}`);
  html = html.replace(tag, () => `<style>${css}</style>`);
}
const js = readFileSync(join(assets, scripts[0]), "utf8").replace(/<\/script/gi, "<\\/script");
const scriptTag = new RegExp(`<script[^>]*src="[^"]*${scripts[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*></script>`);
if (!scriptTag.test(html)) throw new Error("No <script> tag for the bundle");
html = html.replace(scriptTag, "");
// The module must run after the body exists, so it goes at the end of <body>.
html = html.replace("</body>", () => `<script type="module">${js}</script></body>`);
if (/(src|href)="\.\/assets\//.test(html)) throw new Error("An asset reference is left in the HTML");

const dest = join(root, "dist", "prototype");
mkdirSync(dest, { recursive: true });
writeFileSync(join(dest, "workbench.html"), html);
rmSync(outDir, { recursive: true, force: true });
console.log(`dist/prototype/workbench.html  ${(html.length / 1024 / 1024).toFixed(2)} MB`);
