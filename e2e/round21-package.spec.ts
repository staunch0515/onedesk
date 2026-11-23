/**
 * Round 21 against the REAL kernel: plugin package files `<id>-<version>.odplugin` (D456, D461).
 * The package is made with the same writer as `pnpm plugin:pack`. devhost runs with ONEDESK_SECRET_STORE=memory and a
 * temp data directory (kernel-host.ts). Screenshots: test-results/screenshots/round21-*.png.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { DEVHOST, OUT, ROOT, openKernel, rpc, startHost, stopHost, type Host } from "./kernel-host";
// @ts-ignore plain JS module, no types
import { packageEntries, zip } from "../scripts/plugin-tool.mjs";

test.use({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
test.describe.configure({ mode: "serial" });
test.setTimeout(60_000);

const HELLO = "com.example.hello";
const HELLO_DIR = path.join(ROOT, "e2e/fixtures/market/com.example.hello/0.1.0");
const MARKET_ID = "org.onedesk.market";

let host: Host;
let base: string;
let pkgs: string;
let file: string;

/** Packs `dir` the way `pnpm plugin:pack` does and writes it as `name` into `into`. */
function pack(dir: string, into: string, name: string): string {
  const entries = (packageEntries(dir) as [string, string][]).map(([n, f]) => [n, readFileSync(f)]);
  const out = path.join(into, name);
  writeFileSync(out, zip(entries));
  return out;
}

test.beforeAll(async () => {
  test.skip(!existsSync(DEVHOST), `onedesk-devhost not built at ${DEVHOST}`);
  base = realpathSync(mkdtempSync(path.join(tmpdir(), "od-round21-")));
  pkgs = path.join(base, "packages");
  mkdirSync(pkgs);
  file = pack(HELLO_DIR, pkgs, `${HELLO}-0.1.0.odplugin`);
  host = await startHost(path.join(base, "data"));
});
test.afterAll(async () => {
  if (host) await stopHost(host);
  if (base) rmSync(base, { recursive: true, force: true });
});

const call = <T = unknown>(page: Page, method: string, params: unknown = null) => rpc<T>(page, host, method, params);
const shot = async (page: Page, name: string) => {
  await page.mouse.move(640, 2);
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, `round21-${name}.png`) });
};
const bare = (page: Page) => page.goto("/workbench.html?reset&quiet");
type Preview = { valid: boolean; problem?: { code: string; params?: Record<string, string> }; id: string; version: string; fingerprint: string };
const installed = async (page: Page, plugin: string) => {
  try {
    return (await call<{ versions: { active: boolean }[] }>(page, "plugin.get", { plugin })).versions.some((v) => v.active);
  } catch {
    return false;
  }
};
async function refusedReason(page: Page, method: string, params: unknown): Promise<string | undefined> {
  try {
    await call(page, method, params);
  } catch (e) {
    const m = (e as Error).message;
    return (JSON.parse(m.slice(m.indexOf("{"), m.lastIndexOf("}") + 1)) as { params?: Record<string, string> }).params?.reason;
  }
  throw new Error(`${method} was not refused`);
}
const sideTab = (page: Page, name: string) => page.getByRole("navigation", { name: "Views" }).getByRole("button", { name, exact: true });

test("the market lists a package file from an authorized folder and installs it after the confirmation dialog", async ({ page }) => {
  await bare(page);
  await call(page, "plugin.grantFolder", { plugin: MARKET_ID, path: pkgs });
  await openKernel(page, host);
  await sideTab(page, "Plugin market").click();
  await page.locator("[data-tree-key]", { hasText: "Local packages" }).first().dblclick();
  const row = page.getByRole("row", { name: new RegExp(HELLO) });
  await expect(row).toContainText("Not installed");
  await expect(row).toContainText(`${HELLO}-0.1.0.odplugin`);
  await page.getByRole("combobox", { name: "Package to install" }).click();
  await page.getByRole("option", { name: new RegExp(HELLO) }).click();
  await page.getByRole("button", { name: "Install", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Plugin market");
  await expect(dialog).toContainText("Hello"); // the name from inside the package, not the file name
  await shot(page, "market-package-dialog");
  await dialog.getByRole("button", { name: "Install", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => installed(page, HELLO)).toBe(true);
  await expect(row).toContainText("Installed 0.1.0");
  // the unpacked copy used for the checks is gone; the package file itself is untouched
  expect(existsSync(file)).toBe(true);
});

test("app.inspectPlugin / app.installPlugin take a package file; nothing is left in plugins/.tmp", async ({ page }) => {
  await bare(page);
  await call(page, "app.removePlugin", { plugin: HELLO, version: "0.1.0" });
  expect(await installed(page, HELLO)).toBe(false);
  const preview = await call<Preview>(page, "app.inspectPlugin", { folder: file });
  expect(preview).toMatchObject({ valid: true, id: HELLO, version: "0.1.0" });
  await call(page, "app.installPlugin", { folder: file, id: preview.id, version: preview.version, fingerprint: preview.fingerprint });
  expect(await installed(page, HELLO)).toBe(true);
  const tmp = path.join(host.dataDir, "plugins", ".tmp");
  const leftovers = existsSync(tmp) ? (await import("node:fs")).readdirSync(tmp).filter((n) => n.startsWith("unpacked-")) : [];
  expect(leftovers).toEqual([]);
});

test("a package file whose name does not match what is inside, or that is not a zip, is refused", async ({ page }) => {
  await bare(page);
  const wrong = pack(HELLO_DIR, pkgs, `${HELLO}-9.9.9.odplugin`);
  expect(await refusedReason(page, "app.inspectPlugin", { folder: wrong })).toBe("nameMismatch");
  const junk = path.join(pkgs, "junk-1.0.0.odplugin");
  writeFileSync(junk, "this is not a zip file at all, only some text");
  expect(await refusedReason(page, "app.inspectPlugin", { folder: junk })).toBe("notPackage");
});
