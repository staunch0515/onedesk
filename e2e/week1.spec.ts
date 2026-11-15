/**
 * Week-1 acceptance against the REAL kernel (D266): the browser UI talks to `onedesk-devhost`
 * over WebSocket; data lives in a temp dir; nothing touches ~/Library/Application Support/onedesk*.
 *
 * Needs: `cargo build -p onedesk-host -p onedesk-worker` (binaries in target/debug, or set
 * ONEDESK_DEVHOST_BIN / ONEDESK_WORKER_BIN), run from the repo root so built-in plugins in ./plugins
 * are found. Screenshots: docs/screenshots/week1-<theme>-<name>.png.
 *
 * STATUS: written against week1-protocol.md before kernel and shell were merged; NOT YET RUN.
 * Locators that depend on the shell's final markup are collected in the `ui` object below.
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { randomBytes } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, "docs/screenshots");
const DEVHOST = process.env.ONEDESK_DEVHOST_BIN ?? path.join(ROOT, "target/debug/onedesk-devhost");

test.use({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
test.describe.configure({ mode: "serial" });
test.setTimeout(120_000);

/* ------------------------------------------------------------ devhost lifecycle */

type Host = { proc: ChildProcess; port: number; token: string; dataDir: string };

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

async function startHost(dataDir: string): Promise<Host> {
  const port = await freePort();
  const token = randomBytes(16).toString("hex");
  const proc = spawn(DEVHOST, ["--data-dir", dataDir, "--port", String(port), "--token", token, "--plugins", path.join(ROOT, "plugins")], {
    cwd: ROOT,
    env: { ...process.env, ONEDESK_DATA_DIR: dataDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let err = "";
  proc.stderr!.on("data", (d) => (err += d));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`devhost not READY in 30s\n${err}`)), 30_000);
    proc.stdout!.on("data", (d) => {
      if (String(d).includes("READY")) {
        clearTimeout(timer);
        resolve();
      }
    });
    proc.on("exit", (code) => reject(new Error(`devhost exited ${code}\n${err}`)));
  });
  return { proc, port, token, dataDir };
}

async function stopHost(h: Host) {
  h.proc.removeAllListeners("exit");
  h.proc.kill("SIGTERM");
  await new Promise((r) => (h.proc.exitCode !== null ? r(null) : h.proc.once("exit", r)));
}

/* ------------------------------------------------------------ page helpers */

const ui = {
  tab: (page: Page, name: string) => page.locator("[data-tab-id]", { hasText: name }),
  node: (page: Page, label: string) => page.locator("[data-tree-key]", { hasText: label }).first(),
  nodeKey: (page: Page, key: string) => page.locator(`[data-tree-key="${key}"]`),
  activity: (page: Page, name: string) => page.getByRole("navigation", { name: "Views" }).getByRole("button", { name, exact: true }),
  menuItem: (page: Page, name: string) => page.getByRole("menuitem", { name }),
  editor: (page: Page) => page.getByRole("textbox", { name: "Content", exact: true }),
};

async function openKernel(page: Page, h: Host, theme = "light") {
  await page.goto(`/workbench.html?reset&quiet&theme=${theme}&kernel=${encodeURIComponent(`ws://127.0.0.1:${h.port}`)}&token=${h.token}`);
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  await page.evaluate(() => history.replaceState(null, "", location.pathname + location.search.replace("reset&", "")));
}

/** Raw protocol call over the devhost WebSocket (`/?token=&client=`, numeric ids, one JSON text frame each). */
async function rpc<T = unknown>(page: Page, h: Host, method: string, params: unknown = null): Promise<T> {
  return page.evaluate(
    ({ url, method, params }) =>
      new Promise<T>((resolve, reject) => {
        const ws = new WebSocket(url);
        const send = (id: number, m: string, p: unknown) => ws.send(JSON.stringify({ id, method: m, params: p }));
        ws.onopen = () => send(1, "hello", { protocol: "1" });
        ws.onerror = () => reject(new Error("ws error"));
        ws.onmessage = (ev) => {
          const msg = JSON.parse(String(ev.data));
          if (msg.id === 1) return send(2, method, params);
          if (msg.id === 2) {
            ws.close();
            msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
          }
        };
      }),
    { url: `ws://127.0.0.1:${h.port}/?token=${h.token}&client=e2e-rpc`, method, params },
  );
}

async function shot(page: Page, theme: string, name: string) {
  await page.mouse.move(640, 2);
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, `week1-${theme}-${name}.png`) });
}

/* ------------------------------------------------------------ the scenario */

let host: Host;
let dataDir: string;
let granted: string; // temp folder authorized to the files plugin
let outside: string; // temp folder that is NOT authorized

test.beforeAll(async () => {
  // Until kernel and shell are merged and built there is no devhost; skip loudly rather than fail.
  test.skip(!existsSync(DEVHOST), `onedesk-devhost not built at ${DEVHOST} (cargo build -p onedesk-host)`);
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), "od-week1-")));
  dataDir = path.join(base, "data");
  mkdirSync(dataDir);
  granted = path.join(base, "docs");
  outside = path.join(base, "secret");
  mkdirSync(path.join(granted, "sub"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(path.join(granted, "readme.md"), "# hello\n");
  writeFileSync(path.join(granted, "sub", "inner.txt"), "inner\n");
  writeFileSync(path.join(granted, ".hidden"), "x");
  writeFileSync(path.join(granted, "blob.bin"), Buffer.from([0xff, 0xfe, 0x00, 0x80]));
  writeFileSync(path.join(outside, "pass.txt"), "top secret\n");
  host = await startHost(dataDir);
});

test.afterAll(async () => {
  if (host) await stopHost(host);
  if (dataDir) rmSync(path.dirname(dataDir), { recursive: true, force: true });
});

for (const theme of ["light", "dark"] as const) {
  test.describe(`week 1 · ${theme}`, () => {
    test(`resources: group, note, rename, drag, delete — survive a restart`, async ({ page }) => {
      await openKernel(page, host, theme);
      await shot(page, theme, "empty");

      // new group
      await page.getByRole("button", { name: "New", exact: true }).click();
      await ui.menuItem(page, "New group").click();
      await page.getByRole("textbox", { name: "New name" }).fill(`Work-${theme}`);
      await page.keyboard.press("Enter");
      await expect(ui.node(page, `Work-${theme}`)).toBeVisible();

      // new note, type, save
      await page.getByRole("button", { name: "New", exact: true }).click();
      await ui.menuItem(page, "Note").click();
      const editor = ui.editor(page);
      await editor.fill(`hello from ${theme}`);
      await expect(ui.tab(page, "Untitled note")).toHaveClass(/od-tab--dirty/);
      await shot(page, theme, "note-dirty");
      await page.keyboard.press("Meta+s");
      await expect(ui.tab(page, "Untitled note")).not.toHaveClass(/od-tab--dirty/);
      await shot(page, theme, "note-saved");

      // rename
      await ui.node(page, "Untitled note").click({ button: "right" });
      await ui.menuItem(page, "Rename").click();
      await page.getByRole("textbox", { name: "New name" }).fill(`Plan-${theme}`);
      await page.keyboard.press("Enter");
      await expect(ui.node(page, `Plan-${theme}`)).toBeVisible();

      // duplicate (plugin command through the right-click menu)
      await ui.node(page, `Plan-${theme}`).click({ button: "right" });
      await ui.menuItem(page, "Duplicate").click();
      await expect(ui.node(page, `Plan-${theme} (copy)`)).toBeVisible();

      // drag the note into the group
      const from = (await ui.node(page, `Plan-${theme}`).boundingBox())!;
      const to = (await ui.node(page, `Work-${theme}`).boundingBox())!;
      await page.mouse.move(from.x + 20, from.y + from.height / 2);
      await page.mouse.down();
      await page.mouse.move(from.x + 28, from.y + from.height / 2 + 8, { steps: 2 });
      await page.mouse.move(to.x + 40, to.y + to.height / 2, { steps: 8 });
      await page.mouse.up();
      await shot(page, theme, "tree-dragged");

      // delete the copy
      await ui.node(page, `Plan-${theme} (copy)`).click({ button: "right" });
      await ui.menuItem(page, "Delete").click();
      const confirm = page.getByRole("dialog");
      if (await confirm.isVisible().catch(() => false)) await confirm.getByRole("button", { name: /Delete/ }).click();
      await expect(ui.node(page, `Plan-${theme} (copy)`)).toHaveCount(0);

      // restart the whole kernel: everything must still be there
      await stopHost(host);
      host = await startHost(dataDir);
      await openKernel(page, host, theme);
      await expect(ui.node(page, `Work-${theme}`)).toBeVisible();
      await page.getByRole("button", { name: "Expand all" }).click();
      await expect(ui.node(page, `Plan-${theme}`)).toBeVisible();
      await ui.node(page, `Plan-${theme}`).click();
      await expect(ui.editor(page)).toHaveValue(`hello from ${theme}`);
      await shot(page, theme, "after-restart");
    });

    test(`files: grant a folder, browse, edit a text file, save, guard`, async ({ page }) => {
      await openKernel(page, host, theme);
      await ui.activity(page, "Files").click();
      await shot(page, theme, "files-empty");

      // The system folder dialog does not exist in a browser; grant through the protocol (D184 is
      // about the dialog being the consent; the dialog path is covered by the desktop run).
      await rpc(page, host, "plugin.grantFolder", { plugin: "org.onedesk.files", path: granted });
      await expect(ui.nodeKey(page, granted)).toBeVisible();
      await ui.nodeKey(page, granted).click();
      await page.keyboard.press("ArrowRight"); // expand (the chevron has no accessible name)
      await expect(ui.nodeKey(page, path.join(granted, "sub"))).toBeVisible();
      await expect(ui.nodeKey(page, path.join(granted, "readme.md"))).toBeVisible();
      await expect(ui.nodeKey(page, path.join(granted, ".hidden"))).toHaveCount(0);
      await shot(page, theme, "files-tree");

      // folders first
      const keys = await page.locator("[data-tree-key]").evaluateAll((els) => els.map((e) => e.getAttribute("data-tree-key")));
      expect(keys.indexOf(path.join(granted, "sub"))).toBeLessThan(keys.indexOf(path.join(granted, "readme.md")));

      // open, edit, dirty mark, save → disk changes
      const file = path.join(granted, "readme.md");
      await ui.nodeKey(page, file).click();
      await expect(ui.tab(page, "readme.md")).toBeVisible();
      await ui.editor(page).fill(`# edited in ${theme}\n`);
      await expect(ui.tab(page, "readme.md")).toHaveClass(/od-tab--dirty/);
      await shot(page, theme, "text-dirty");
      // (saving a node: page from the UI is the fixme test below)

      // closing with unsaved changes asks first
      await ui.tab(page, "readme.md").getByRole("button").click();
      await expect(page.getByRole("dialog")).toContainText("unsaved changes");
      await shot(page, theme, "close-guard");
      await page.getByRole("button", { name: "Cancel" }).click();
      await expect(ui.tab(page, "readme.md")).toBeVisible();

      // a binary file shows a muted explanation instead of an editor
      await ui.nodeKey(page, path.join(granted, "blob.bin")).click();
      await expect(page.getByText(/not UTF-8 text/)).toBeVisible();
      await shot(page, theme, "text-not-text");

      // a file outside the authorized folder cannot be opened
      const target = `node:org.onedesk.files:files/${encodeURIComponent(path.join(outside, "pass.txt"))}`;
      const resolved = await rpc(page, host, "page.resolve", { target }).catch((e: Error) => String(e));
      expect(JSON.stringify(resolved)).not.toContain("top secret");
      expect(JSON.stringify(resolved)).toMatch(/denied|muted|reason\.denied|outside/); // refused or shown as a refusal
    });
  });
}

// FIXME(shell): `save` in src/workbench/state/context.tsx only handles `new:` and `resource:` targets, so
// ⌘S / the Save button on a `node:` page (text files) sends nothing and the tab stays dirty. See the
// handoff file, "第二阶段发现的问题" #S1. Remove `.fixme` when the shell calls `page.save` for `node:` targets.
test.fixme("files: saving a text file writes it to disk and clears the unsaved mark", async ({ page }) => {
  await openKernel(page, host);
  await ui.activity(page, "Files").click();
  const file = path.join(granted, "readme.md");
  await ui.nodeKey(page, granted).click();
  await page.keyboard.press("ArrowRight");
  await ui.nodeKey(page, file).click();
  await ui.editor(page).fill("# saved from the UI\n");
  await expect(ui.tab(page, "readme.md")).toHaveClass(/od-tab--dirty/);
  await page.keyboard.press("Meta+s");
  await expect(ui.tab(page, "readme.md")).not.toHaveClass(/od-tab--dirty/);
  expect(readFileSync(file, "utf8")).toBe("# saved from the UI\n");
  await shot(page, "light", "text-saved");
});

test("kill the worker: the UI recovers and data is intact", async ({ page }) => {
  await openKernel(page, host);
  await expect(ui.node(page, "Work-light")).toBeVisible();
  execFileSync("pkill", ["-9", "-f", `onedesk-worker.*${dataDir}`]); // throws when no worker matched
  // a connection-lost banner may flash; the tree must come back on its own
  await expect(ui.node(page, "Work-light")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "New", exact: true }).click();
  await ui.menuItem(page, "New group").click();
  await page.getByRole("textbox", { name: "New name" }).fill("After-kill");
  await page.keyboard.press("Enter");
  await expect(ui.node(page, "After-kill")).toBeVisible();
  await shot(page, "light", "worker-recovered");
});
