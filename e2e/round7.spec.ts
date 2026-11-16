/**
 * Round 7 against the REAL kernel: the local plugin market (requestInstall), dependencies and exports
 * (note-tools depends on the note plugin). devhost always runs with ONEDESK_SECRET_STORE=memory and a temp data
 * directory (kernel-host.ts): the real keychain and ~/Library/Application Support/onedesk* are never touched.
 * Protocol tests use a bare page (no shell), because an open shell would answer install requests itself;
 * UI tests open the shell. Assertions use error codes/reasons and protocol results; UI checks use English
 * labels (locale en-US). Screenshots: docs/screenshots/round7-*.png.
 */
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { DEVHOST, OUT, ROOT, openKernel, rpc, startHost, stopHost, type Host } from "./kernel-host";

test.use({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
test.describe.configure({ mode: "serial" });
test.setTimeout(60_000);

const MARKET = path.join(ROOT, "e2e/fixtures/market");
const FIX = path.join(ROOT, "e2e/fixtures/plugins");
const TOOLS_DIR = path.join(FIX, "com.example.note-tools/0.1.0");
const NO_INSTALL_DIR = path.join(FIX, "com.example.no-install/0.1.0");
const HELLO = "com.example.hello";
const HELLO_DIR = path.join(MARKET, "com.example.hello/0.1.0");
const TOOLS = "com.example.note-tools";
const NOTE_ID = "org.onedesk.note";
const NOTE = "org.onedesk.note:note";
const MARKET_ID = "org.onedesk.market";
const MARKET_TARGET = "node:org.onedesk.market:market/local";

let host: Host;
let base: string;

test.beforeAll(async () => {
  test.skip(!existsSync(DEVHOST), `onedesk-devhost not built at ${DEVHOST}`);
  base = realpathSync(mkdtempSync(path.join(tmpdir(), "od-round7-")));
  host = await startHost(path.join(base, "data"));
});
test.afterAll(async () => {
  if (host) await stopHost(host);
  if (base) rmSync(base, { recursive: true, force: true });
});

const shot = async (page: Page, name: string) => {
  await page.mouse.move(640, 2);
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, `round7-${name}.png`) });
};
const call = <T = unknown>(page: Page, method: string, params: unknown = null) => rpc<T>(page, host, method, params);
type Err = { code: string; params?: Record<string, string>; detail?: string };
async function refused(page: Page, method: string, params: unknown = null): Promise<Err> {
  try {
    await call(page, method, params);
  } catch (e) {
    const m = (e as Error).message;
    return JSON.parse(m.slice(m.indexOf("{"), m.lastIndexOf("}") + 1)) as Err;
  }
  throw new Error(`${method} was not refused`);
}
/** A bare page: raw protocol calls without a shell that could answer install requests. */
async function bare(page: Page) {
  await page.goto("/workbench.html?reset&quiet"); // the demo shell, not connected to the kernel
}

type Preview = { valid: boolean; problem?: unknown; id: string; version: string; fingerprint: string; permissions: { id: string; detail: string }[]; addedPermissions: string[] };
async function installPkg(page: Page, folder: string) {
  const preview = await call<Preview>(page, "app.inspectPlugin", { folder });
  await call(page, "app.installPlugin", { folder, id: preview.id, version: preview.version, fingerprint: preview.fingerprint });
  return preview;
}
type Dep = { id: string; range: string; satisfied: boolean; activeVersion?: string };
type Detail = { id: string; enabled: boolean; versions: { version: string; active: boolean }[]; load: { state: string; message?: string }; depends?: Dep[]; dependents?: string[]; permissions: { id: string; detail: string; granted: boolean }[] };
const detail = (page: Page, plugin: string) => call<Detail>(page, "plugin.get", { plugin });
const installed = async (page: Page, plugin: string) => {
  try {
    return (await detail(page, plugin)).versions.some((v) => v.active);
  } catch {
    return false;
  }
};
type InstallRequest = { id: string; plugin: string; folder: string };
const requests = (page: Page) => call<InstallRequest[]>(page, "plugin.installRequests", {});
async function untilRequest(page: Page): Promise<InstallRequest> {
  await expect.poll(async () => (await requests(page)).length, { timeout: 15_000 }).toBeGreaterThan(0);
  return (await requests(page))[0]!;
}
/** Starts the market's install event; resolves when the request has been answered. */
const marketInstall = (page: Page, folder: string) =>
  call<{ message?: unknown; changes?: Record<string, unknown> }>(page, "page.event", { target: MARKET_TARGET, event: "install", context: { draft: { pick: folder }, locale: "en-US" } });

const setEnabled = (page: Page, plugin: string, enabled: boolean) => call(page, "plugin.setEnabled", { plugin, enabled });
type Node = { key: string; label: string };
const newNote = async (page: Page, name: string, text: string) =>
  (await call<{ page: { resourceId: string } }>(page, "page.save", { target: `new:${NOTE}`, changes: { name, "body.text": text } })).page.resourceId;
type Res = { id: string; body: { text?: string } };
const getRes = (page: Page, id: string) => call<Res>(page, "resource.get", { id });
type RunInfo = { id: string; status: string; actor: string; output?: { type: string; text?: string }; error?: { code: string; reason?: string; message: string } };
async function runAction(page: Page, action: string, id: string): Promise<RunInfo> {
  const runId = await call<string>(page, "run.start", { action, resourceId: id, target: `resource:${id}`, tabId: "t", input: {}, params: {} });
  await expect.poll(async () => (await call<RunInfo>(page, "run.get", { id: runId })).status, { timeout: 20_000 }).not.toBe("running");
  return call<RunInfo>(page, "run.get", { id: runId });
}
const pageActions = async (page: Page, id: string) => (await call<{ actions: { id: string; action?: string }[]; state: string }>(page, "page.resolve", { target: `resource:${id}` })).actions.map((a) => a.action ?? a.id);

const sideTab = (page: Page, name: string) => page.getByRole("navigation", { name: "Views" }).getByRole("button", { name, exact: true });
async function openMarketPage(page: Page) {
  await openKernel(page, host);
  await sideTab(page, "Plugin market").click();
  await page.locator("[data-tree-key]", { hasText: "Local packages" }).first().dblclick();
}

/* ------------------------------------------------------------------ the market page */

test("market page without an authorized folder explains how to start", async ({ page }) => {
  await openMarketPage(page);
  await expect(page.getByText("No folder authorized yet.")).toBeVisible();
  await expect(page.getByText("Use “Add folder” in the toolbar")).toBeVisible();
  await shot(page, "market-empty");
});

test("after authorizing the fixture folder the packages show three states: not installed, unavailable with a reason, installed", async ({ page }) => {
  await bare(page);
  await call(page, "plugin.grantFolder", { plugin: MARKET_ID, path: MARKET });
  await openMarketPage(page);
  const row = (name: string) => page.getByRole("row", { name: new RegExp(name) });
  await expect(row("com.example.unreadable|unreadable")).toContainText("Unavailable");
  await expect(row("unreadable")).toContainText("not valid JSON");
  await expect(row("Hello")).toContainText("Not installed");
  await expect(row("Note")).toContainText("Installed 0.1.0");
  await shot(page, "market-list");
});

test("a plugin that did not declare plugins.install is refused with notRequested", async ({ page }) => {
  await bare(page);
  await installPkg(page, NO_INSTALL_DIR);
  const thing = (await call<{ page: { resourceId: string } }>(page, "page.save", { target: "new:com.example.no-install:thing", changes: { name: "T", "body.text": HELLO_DIR } })).page.resourceId;
  const runId = await call<string>(page, "run.start", { action: "try", resourceId: thing, target: `resource:${thing}`, tabId: "t", input: { "body.text": HELLO_DIR }, params: {} });
  await expect.poll(async () => (await call<RunInfo>(page, "run.get", { id: runId })).status, { timeout: 20_000 }).not.toBe("running");
  const run = await call<RunInfo>(page, "run.get", { id: runId });
  expect(run.status).toBe("error");
  expect(run.error).toMatchObject({ code: "denied", reason: "notRequested" });
  expect(await requests(page)).toEqual([]);
});

test("a folder outside what the market can read is refused (outsideGrant) and nothing is registered", async ({ page }) => {
  await bare(page);
  const outside = path.join(base, "elsewhere");
  mkdirSync(outside, { recursive: true });
  const err = await refused(page, "page.event", { target: MARKET_TARGET, event: "install", context: { draft: { pick: outside } } });
  expect(err).toMatchObject({ code: "denied" });
  expect(JSON.stringify(err)).toContain("outsideGrant");
  expect(await requests(page)).toEqual([]);
});

test("a second request while one waits is turned away (pendingRequest); answering ends the first", async ({ page }) => {
  await bare(page);
  const first = marketInstall(page, HELLO_DIR);
  const req = await untilRequest(page);
  expect(req).toMatchObject({ plugin: MARKET_ID });
  const second = await marketInstall(page, HELLO_DIR); // the market catches the conflict and answers with a message
  expect(second.message).toBeTruthy();
  expect((await requests(page)).length).toBe(1);
  await call(page, "plugin.answerInstallRequest", { id: req.id, outcome: "declined" });
  expect((await first).message).toBeTruthy();
  expect(await requests(page)).toEqual([]);
  expect(await installed(page, HELLO)).toBe(false);
});

/* ------------------------------------------------------------------ install through the dialog */

async function pickAndInstall(page: Page, label: RegExp) {
  await page.getByRole("combobox", { name: "Package to install" }).click();
  await page.getByRole("option", { name: label }).click();
  await page.getByRole("button", { name: "Install", exact: true }).click();
}

test("install from the market: the framework's dialog names the market; cancel installs nothing and ends the request", async ({ page }) => {
  await openMarketPage(page);
  await pickAndInstall(page, /Hello/);
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Plugin market");
  await shot(page, "market-install-dialog");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(async () => (await requests(page)).length).toBe(0);
  expect(await installed(page, HELLO)).toBe(false);
});

test("install from the market: confirming installs it, the list says Installed, the plugin shows in the tree", async ({ page }) => {
  await openMarketPage(page);
  await pickAndInstall(page, /Hello/);
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Plugin market");
  await dialog.getByRole("button", { name: "Install", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => installed(page, HELLO)).toBe(true);
  await expect.poll(async () => (await requests(page)).length).toBe(0);
  await expect(page.getByRole("row", { name: /Hello/ })).toContainText("Installed 0.1.0");
  await sideTab(page, "Plugins").click();
  await expect(page.locator("[data-tree-key]", { hasText: "Hello" }).first()).toBeVisible();
  await shot(page, "market-installed");
});

/* ------------------------------------------------------------------ dependencies and exports */

let noteId = "";

test("note-tools: the dialog lists reading notes as a permission; the plugin page shows what it depends on", async ({ page }) => {
  await bare(page);
  const preview = await call<Preview>(page, "app.inspectPlugin", { folder: TOOLS_DIR });
  expect(preview.valid).toBe(true);
  expect(preview.permissions.find((p) => p.id === "resources")?.detail).toContain(NOTE);
  await call(page, "app.installPlugin", { folder: TOOLS_DIR, id: preview.id, version: preview.version, fingerprint: preview.fingerprint });
  const d = await detail(page, TOOLS);
  expect(d.depends).toEqual([{ id: NOTE_ID, range: ">=0.1.0", satisfied: true, activeVersion: "0.1.0" }]);
  expect((await detail(page, NOTE_ID)).dependents).toEqual([TOOLS]);
  noteId = await newNote(page, "Counted", "hello brave world\nsecond line");
});

test("note-tools: the note page gets “Count words”, the run is by note-tools and correct; the other action is refused (foreignKind) and the note is unchanged", async ({ page }) => {
  await bare(page);
  expect(await pageActions(page, noteId)).toContain(`${TOOLS}:count`);
  const ok = await runAction(page, `${TOOLS}:count`, noteId);
  expect(ok.status).toBe("success");
  expect(ok.actor).toBe("user"); // who started the run; the plugin is the operator of what the run does (audit below)
  expect(ok.output).toMatchObject({ type: "text", text: "5 words, 2 lines" });
  const bad = await runAction(page, `${TOOLS}:stamp`, noteId);
  expect(bad.status).toBe("error");
  expect(bad.error).toMatchObject({ code: "denied", reason: "foreignKind" });
  expect((await getRes(page, noteId)).body.text).toBe("hello brave world\nsecond line");
  // the refused write is audited with the dependent as operator
  const audit = await call<{ actor: string; operation: string; result: string }[]>(page, "audit.list", {});
  expect(audit.some((r) => r.actor.startsWith(`plugin:${TOOLS}@`) && r.operation === "resources.update" && r.result === "denied")).toBe(true);
});

test("the plugin pages show the dependency in both directions", async ({ page }) => {
  await openKernel(page, host);
  await sideTab(page, "Plugins").click();
  await page.locator("[data-tree-key]", { hasText: "Note tools" }).first().dblclick();
  await expect(page.getByText(NOTE_ID).first()).toBeVisible();
  await shot(page, "plugin-depends");
});

test("disabling or removing the note plugin is refused while note-tools is on, and the refusal lists it", async ({ page }) => {
  await bare(page);
  const e = await refused(page, "plugin.setEnabled", { plugin: NOTE_ID, enabled: false });
  expect(e).toMatchObject({ code: "conflict", params: { reason: "dependents", plugins: TOOLS } });
  expect((await detail(page, NOTE_ID)).enabled).toBe(true);
  const r = await refused(page, "plugin.checkRemove", { plugin: NOTE_ID, version: "0.1.0" });
  expect(r).toMatchObject({ code: "conflict", params: { reason: "dependents", plugins: TOOLS } });
});

test.fixme("removing the note version through the app is refused (waits for the shell to forward plugin.checkRemove)", async ({ page }) => {
  await bare(page);
  const e = await refused(page, "app.removePlugin", { plugin: NOTE_ID, version: "0.1.0" });
  expect(e).toMatchObject({ code: "conflict", params: { reason: "dependents", plugins: TOOLS } });
});

test("with note-tools off the note plugin can be disabled; enabling note-tools then shows dependency unmet and no “Count words”; the note coming back restores it", async ({ page }) => {
  await bare(page);
  await setEnabled(page, TOOLS, false);
  await setEnabled(page, NOTE_ID, false);
  await setEnabled(page, TOOLS, true);
  const d = await detail(page, TOOLS);
  expect(d.load).toMatchObject({ state: "disabled", message: "dependsUnmet" });
  expect(d.depends![0]).toMatchObject({ id: NOTE_ID, satisfied: false });
  expect(await pageActions(page, noteId)).not.toContain(`${TOOLS}:count`);
  // the run is not started: it ends at once in an error (the action no longer exists / the plugin is off)
  const dead = await runAction(page, `${TOOLS}:count`, noteId).catch(() => null);
  if (dead) expect(dead.status).not.toBe("success");

  await setEnabled(page, NOTE_ID, true);
  expect((await detail(page, TOOLS)).load.state).toBe("loaded");
  expect(await pageActions(page, noteId)).toContain(`${TOOLS}:count`);
  expect((await runAction(page, `${TOOLS}:count`, noteId)).status).toBe("success");
});

test("under the read-only policy the dependent's action is refused (readonly) like any run", async ({ page }) => {
  await bare(page);
  const cfg = (await call<{ nodes: Node[] }>(page, "tree.children", { tree: "config" })).nodes.find((n) => n.label === "Workspace")!.key;
  await call(page, "params.set", { node: cfg, name: "protection.readonly", value: "true" });
  try {
    const e = await refused(page, "run.start", { action: `${TOOLS}:count`, resourceId: noteId, target: `resource:${noteId}`, tabId: "t", input: {}, params: {} });
    expect(e).toMatchObject({ code: "denied", params: { reason: "readonly" } });
  } finally {
    await call(page, "params.unset", { node: cfg, name: "protection.readonly" });
  }
  expect((await runAction(page, `${TOOLS}:count`, noteId)).status).toBe("success");
});
