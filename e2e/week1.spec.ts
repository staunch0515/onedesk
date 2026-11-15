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
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { DEVHOST, OUT, openKernel, rpc, startHost, stopHost, ui, type Host } from "./kernel-host";


test.use({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
test.describe.configure({ mode: "serial" });
test.setTimeout(120_000);

/* ------------------------------------------------------------ devhost lifecycle */

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
      await expect(ui.tab(page, "docs")).toHaveCount(0); // folders have no page (K1)
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
      // (saving from the UI is the next test)

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

test("files: saving a text file writes it to disk and clears the unsaved mark", async ({ page }) => {
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
