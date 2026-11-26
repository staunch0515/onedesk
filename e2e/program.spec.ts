/**
 * D487 §37 (docs/redesign/book.md, K20, K21) against the REAL kernel, the real book and program book plugins and a real
 * MCP client: a “Unit conversion” plugin written as a book — manifest, two code pages, two languages, tests, the build
 * page. The manifest is wrong first (the reason shows), then right; a test fails (expected 100, got 10), the code is
 * fixed and all pass; “Try it out” asks to install (the dialog names the book), the new kind can be created and works;
 * “Build…” writes the signed package, which installing accepts, and the history lists it; an AI runs the tests and
 * proposes a change, which the author sees as a code diff.
 * Screenshots (not checked in): test-results/screenshots/program-*.png.
 */
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { connectMcp, type StdioMcpClient } from "./_mcp/mcp-client";
import { DEVHOST, OUT, ROOT, openKernel, rpc, startHost, stopHost, ui, type Host } from "./kernel-host";

test.use({ viewport: { width: 1440, height: 900 }, locale: "en-US" });
test.describe.configure({ mode: "serial" });
test.setTimeout(240_000);

const MCP_BIN = process.env.ONEDESK_MCP_BIN ?? path.join(ROOT, "target/debug/onedesk-mcp");
const B = "org.onedesk.book";
const P = "org.onedesk.program";

let base: string;
let dataDir: string;
let out: string;
let host: Host | null = null;

test.beforeAll(async () => {
  test.skip(!existsSync(DEVHOST) || !existsSync(MCP_BIN), `onedesk-devhost / onedesk-mcp not built (${DEVHOST}, ${MCP_BIN})`);
  base = realpathSync(mkdtempSync(path.join(tmpdir(), "od-program-")));
  dataDir = path.join(base, "data");
  out = path.join(base, "out");
  mkdirSync(out, { recursive: true });
});
test.afterAll(async () => {
  if (host) await stopHost(host);
  if (base) rmSync(base, { recursive: true, force: true });
});

type Node = { key: string; label: string };
const call = <T = any>(page: Page, method: string, params: unknown = null) => rpc<T>(page, host!, method, params);
const shot = (page: Page, name: string) => page.screenshot({ path: path.join(OUT, `program-${name}.png`) });
const action = (page: Page, name: string) => page.locator(".od-titlebar__actions").getByRole("button", { name, exact: true });
async function up(page: Page) {
  host = await startHost(dataDir);
  await openKernel(page, host);
}
async function down() {
  if (host) await stopHost(host);
  host = null;
}
async function withMcp<T>(fn: (c: StdioMcpClient) => Promise<T>): Promise<T> {
  const c = await connectMcp({ command: MCP_BIN, args: ["--data-dir", dataDir], env: { ONEDESK_DATA_DIR: dataDir, ONEDESK_MCP_IDLE_MS: "300" } });
  try {
    return await fn(c);
  } finally {
    await c.close();
  }
}
async function make(page: Page, kind: string, parent: string | null, changes: Record<string, unknown>): Promise<string> {
  const target = parent ? `new:${kind}?parent=${parent}` : `new:${kind}`;
  return (await call<{ page: { resourceId: string } }>(page, "page.save", { target, changes })).page.resourceId;
}
async function open(page: Page, name: string) {
  await page.getByRole("button", { name: "Expand all" }).first().click();
  await page.getByRole("treeitem", { name, exact: true }).first().click();
  await expect(page.getByRole("heading", { level: 1, name }).first()).toBeVisible({ timeout: 15_000 });
}

const MANIFEST = (apiVersion: string) =>
  JSON.stringify(
    {
      id: "org.example.convert",
      version: "0.1.0",
      apiVersion,
      name: "plugin.name",
      icon: "ruler",
      main: "main.js",
      contributes: {
        kinds: [{ id: "conversion", label: "kind.conversion", icon: "ruler", tree: "resources", page: "conversion", newName: "kind.conversion", defaults: { m: 1 } }],
        menus: { new: ["conversion"] },
        pages: [{ id: "conversion", recompute: true, actions: [{ id: "save", role: "save", label: "action.save", icon: "save", primary: true, shortcut: ["Mod", "S"] }] }],
        locales: { "en-US": "locales/en-US.json", "zh-CN": "locales/zh-CN.json" },
      },
    },
    null,
    2,
  );
const MAIN = `import { convert } from "./lib/convert.js";

export default {
  activate(host) {
    host.pages.handle("conversion", {
      render(ctx) {
        const m = Number((ctx.resource && ctx.resource.body && ctx.resource.body.m) || 0);
        return {
          view: [
            { type: "form", id: "f", layout: "stack", fields: [{ name: "m", label: ctx.t("field.m"), kind: "number", bind: "body.m" }] },
            { type: "text", id: "cm", text: "= " + convert(m, "m", "cm") + " cm" },
          ],
        };
      },
    });
  },
};
`;
const CONVERT = (factor: number) => `export function convert(n, from, to) {\n  if (from === "m" && to === "cm") return n * ${factor};\n  return n;\n}\n`;
const TESTS = `test("one metre is a hundred centimetres", () => {
  const { convert } = load("lib/convert.js");
  expect(convert(1, "m", "cm")).toBe(100);
});
test("the page shows centimetres", async () => {
  const pages = {};
  load("main.js").default.activate({ pages: { handle: (id, h) => (pages[id] = h) } });
  const r = await pages.conversion.render({ host: fakeHost(), t: (k) => k, resource: { body: { m: 2 } } });
  expect(r.view[1].text).toBe("= 200 cm");
});
`;
const texts = (rows: Array<[string, string]>) => rows.map(([key, text]) => ({ key, text }));

const ids = {} as Record<"book" | "man" | "main" | "conv" | "tests" | "build", string>;

test("a plugin written as a book: the check, the tests, trying it out, building it", async ({ page }) => {
  await up(page);
  await call(page, "plugin.grantFolder", { plugin: P, path: out });
  ids.book = await make(page, `${B}:book`, null, { name: "Unit conversion" });
  ids.man = await make(page, `${P}:manifest`, ids.book, { name: "Manifest", "body.text": MANIFEST("9") });
  ids.build = await make(page, `${P}:build`, ids.book, { name: "Build", "body.notes": "First version" });
  ids.main = await make(page, `${P}:code`, ids.book, { name: "The plugin", "body.path": "main.js", "body.explain": "The plugin starts here: one page that shows centimetres.", "body.code": MAIN });
  ids.conv = await make(page, `${P}:code`, ids.book, { name: "Converting", "body.path": "lib/convert.js", "body.explain": "Metres to centimetres.", "body.code": CONVERT(10) });
  await make(page, `${P}:locale`, ids.book, { name: "English", "body.language": "en-US", "body.texts": texts([["plugin.name", "Unit conversion"], ["kind.conversion", "Conversion"], ["field.m", "Metres"], ["action.save", "Save"]]) });
  await make(page, `${P}:locale`, ids.book, { name: "Chinese", "body.language": "zh-CN", "body.texts": texts([["plugin.name", "单位换算"], ["kind.conversion", "换算"], ["field.m", "米"], ["action.save", "保存"]]) });
  ids.tests = await make(page, `${P}:test`, ids.book, { name: "Tests", "body.code": TESTS });
  await page.reload();

  // The manifest page says what is wrong, with the same check installing does; fixed, nothing.
  await open(page, "Manifest");
  await expect(page.getByText(/apiVersion/).last()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/1 problem/)).toBeVisible();
  await shot(page, "manifest-wrong");
  await call(page, "page.save", { target: `resource:${ids.man}`, changes: { "body.text": MANIFEST("2") } });
  await page.reload();
  await expect(page.getByText("No problems: these files make a valid plugin.")).toBeVisible({ timeout: 15_000 });

  // The tests: one fails (100 expected, 10 came); the code fixed, all pass.
  await open(page, "Tests");
  await action(page, "Run tests").click();
  await expect(page.getByRole("row", { name: /one metre is a hundred centimetres Failed \(Tests:3\) 100 10/ })).toBeVisible({ timeout: 30_000 });
  await shot(page, "tests-failed");
  await open(page, "Converting");
  const code = page.getByRole("textbox", { name: "Code", exact: true });
  await code.fill(CONVERT(100));
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(async () => (await call<{ body: Record<string, string> }>(page, "resource.get", { id: ids.conv })).body.code, { timeout: 15_000 }).toBe(CONVERT(100));
  await open(page, "Tests");
  await action(page, "Run tests").click();
  await expect(page.getByRole("row", { name: /one metre is a hundred centimetres Passed/ })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("row", { name: /the page shows centimetres Passed/ })).toBeVisible();
  await shot(page, "tests-passed");

  // Try it out: the install request names the book; confirmed, the new kind is there and works.
  await open(page, "Build");
  await action(page, "Try it out").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("From: the program book “Unit conversion”", { timeout: 30_000 });
  await expect(dialog).toContainText("org.example.convert@0.1.0-dev.1");
  await shot(page, "try");
  await dialog.getByRole("button", { name: "Install", exact: true }).click();
  await expect(page.getByText("Installed org.example.convert 0.1.0-dev.1.").first()).toBeVisible({ timeout: 30_000 });
  // The “New” menu follows the plugins (no reload).
  await page.getByRole("button", { name: "New", exact: true }).first().click();
  await page.getByRole("menuitem", { name: "Conversion", exact: true }).click();
  await expect(page.getByText("= 100 cm")).toBeVisible({ timeout: 15_000 });
  await page.getByLabel("Metres", { exact: true }).fill("3");
  await page.keyboard.press("ControlOrMeta+s");
  await expect(page.getByText("= 300 cm")).toBeVisible({ timeout: 15_000 });
  await shot(page, "tried");
  await page.keyboard.press("Escape");

  // Build: needs an identity; writes the signed package, which installing accepts; the history has it.
  await call(page, "identity.create", { name: "Zhang" });
  await page.reload();
  await open(page, "Build");
  await action(page, "Build…").click();
  const file = path.join(out, "org.example.convert-0.1.0.odplugin");
  await expect(page.getByText(`Wrote ${file}`, { exact: false }).first()).toBeVisible({ timeout: 30_000 });
  const preview = await call<{ valid: boolean; id: string; version: string }>(page, "app.inspectPlugin", { folder: file });
  expect(preview).toMatchObject({ valid: true, id: "org.example.convert", version: "0.1.0" });
  await page.reload();
  await open(page, "Build");
  await expect(page.getByRole("row", { name: /0\.1\.0 .* First version/ })).toBeVisible({ timeout: 15_000 });
  await shot(page, "built");
  // The same version only once.
  await action(page, "Build…").click();
  await expect
    .poll(async () => (await call<Array<{ status: string; error?: { message: string } }>>(page, "run.listFor", { id: ids.build }))[0]?.error?.message ?? "", { timeout: 30_000 })
    .toMatch(/Version 0\.1\.0 is built already/);

  await call(page, "resource.setAiVisible", { id: ids.book, visible: true, withChildren: true });
  await call(page, "workspace.setConfig", { name: "mcp.enabled", value: "true" });
  await call(page, "workspace.setConfig", { name: "mcp.allow_proposals", value: "true" });
  await down();
});

test("an AI reads the code, runs the tests and proposes a change; the author sees the code diff", async ({ page }) => {
  await withMcp(async (c) => {
    const tools = (await c.listTools()).map((t: { name: string }) => t.name);
    expect(tools).toContain("org_onedesk_program__program_test");
    const run = JSON.parse((await c.callTool("org_onedesk_program__program_test", { book: ids.book })).json.output.text);
    expect(run).toMatchObject({ loaded: true, passed: 2, failed: 0 });
    const read = (await c.callTool("read", { id: ids.conv })).json;
    const r = await c.callTool("propose", {
      title: "Kilometres too",
      items: [{ op: "update", id: ids.conv, rev: read.rev, changes: { "body.code": CONVERT(100).replace("  return n;", '  if (from === "km" && to === "m") return n * 1000;\n  return n;') } }],
    });
    expect(r.isError).toBe(false);
  });
  await up(page);
  await page.getByRole("navigation", { name: "Views" }).getByRole("button", { name: /^Proposals to review/ }).click();
  await ui.node(page, "Kilometres too").click();
  await expect(page.getByRole("heading", { name: /Kilometres too/ }).first()).toBeVisible({ timeout: 15_000 });
  // The code compared line by line: the new line is marked added.
  await expect(page.getByRole("row", { name: /added if \(from === "km" && to === "m"\) return n \* 1000;/ })).toBeVisible();
  await shot(page, "proposal");
  const kids = (await call<{ nodes: Node[] }>(page, "tree.children", { tree: "resources", parent: ids.book })).nodes.map((n) => n.label);
  expect(kids).toEqual(expect.arrayContaining(["Manifest", "Build", "The plugin", "Converting", "English", "Chinese", "Tests"]));
});
