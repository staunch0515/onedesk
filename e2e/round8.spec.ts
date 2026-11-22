/**
 * Round 8 against the REAL kernel: transfer (download / upload / capture through a local HTTP server), exported
 * trees and pages (board + board-extra), the market's page parameter. devhost always runs with
 * ONEDESK_SECRET_STORE=memory and a temp data directory (kernel-host.ts): the real keychain and
 * ~/Library/Application Support/onedesk* are never touched. The transfer server listens on 127.0.0.1 only.
 * Protocol tests use a bare page (no shell); UI tests open the shell. Screenshots: docs/screenshots/round8-*.png.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { DEVHOST, OUT, ROOT, openKernel, rpc, startHost, stopHost, type Host } from "./kernel-host";
// @ts-ignore plain JS module, no types
import { patternByte, startServer } from "./fixtures/transfer-server.mjs";

test.use({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
test.describe.configure({ mode: "serial" });
test.setTimeout(90_000);

const FIX = path.join(ROOT, "e2e/fixtures/plugins");
const MARKET = path.join(ROOT, "e2e/fixtures/market");
const TRANSFER = "com.example.transfer";
const BOARD = "com.example.board";
const EXTRA = "com.example.board-extra";
const MARKET_ID = "org.onedesk.market";
const MARKET_TARGET = "node:org.onedesk.market:market/local";
const MB = 1024 * 1024;

let host: Host;
let base: string;
let grant: string;
let outside: string;
let srv: { port: number; url: string; received: { name: string; bytes: number }[]; close(): Promise<void> };

test.beforeAll(async () => {
  test.skip(!existsSync(DEVHOST), `onedesk-devhost not built at ${DEVHOST}`);
  base = realpathSync(mkdtempSync(path.join(tmpdir(), "od-round8-")));
  grant = path.join(base, "grant");
  outside = path.join(base, "outside");
  mkdirSync(grant);
  mkdirSync(outside);
  srv = await startServer({ port: 0 });
  host = await startHost(path.join(base, "data"));
});
test.afterAll(async () => {
  if (host) await stopHost(host);
  if (srv) await srv.close();
  if (base) rmSync(base, { recursive: true, force: true });
});

const shot = async (page: Page, name: string) => {
  await page.mouse.move(640, 2);
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, `round8-${name}.png`) });
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
async function bare(page: Page) {
  await page.goto("/workbench.html?reset&quiet"); // the demo shell, not connected to the kernel
}
async function showTree(page: Page, name: string) {
  const b = page.getByRole("navigation", { name: "Views" }).getByRole("button", { name, exact: true });
  if ((await b.getAttribute("aria-pressed")) !== "true") await b.click();
}

type Preview = { valid: boolean; problem?: unknown; id: string; version: string; fingerprint: string; permissions: { id: string; detail: string }[]; addedPermissions: string[] };
async function installPkg(page: Page, folder: string) {
  const preview = await call<Preview>(page, "app.inspectPlugin", { folder });
  expect(preview.valid, JSON.stringify(preview.problem)).toBe(true);
  await call(page, "app.installPlugin", { folder, id: preview.id, version: preview.version, fingerprint: preview.fingerprint });
  return preview;
}
type Dep = { id: string; range: string; satisfied: boolean };
type Detail = { id: string; enabled: boolean; load: { state: string; message?: string }; depends?: Dep[]; unmetExports?: string[]; permissions: { id: string; detail: string }[] };
const detail = (page: Page, plugin: string) => call<Detail>(page, "plugin.get", { plugin });
type RunInfo = {
  id: string;
  status: string;
  progress?: { message?: string };
  output?: { type: string; text?: string };
  error?: { code: string; reason?: string; message: string; params?: Record<string, string> };
};
const getRun = (page: Page, id: string) => call<RunInfo>(page, "run.get", { id });
async function finished(page: Page, runId: string, timeout = 60_000): Promise<RunInfo> {
  await expect.poll(async () => (await getRun(page, runId)).status, { timeout }).not.toBe("running");
  return getRun(page, runId);
}
type Node = { key: string; label: string };
const cfgNode = async (page: Page) => (await call<{ nodes: Node[] }>(page, "tree.children", { tree: "config" })).nodes.find((n) => n.label === "Workspace")!.key;

/* ------------------------------------------------------------------ transfer */

const pattern = (n: number) => {
  const b = Buffer.allocUnsafe(n);
  for (let i = 0; i < n; i++) b[i] = patternByte(i);
  return b;
};
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const shaFile = (p: string) => sha(readFileSync(p));
const left = (dir: string) => readdirSync(dir);

let jobSeq = 0;
/** A transfer job resource whose saved address is `url` (the saved address is what authorizes the host). */
async function newJob(page: Page, url: string, file: string): Promise<string> {
  const changes = { name: `Job ${++jobSeq}`, "body.url": url, "body.path": file };
  return (await call<{ page: { resourceId: string } }>(page, "page.save", { target: `new:${TRANSFER}:job`, changes })).page.resourceId;
}
async function startJob(page: Page, id: string, action: string, input: { url: string; path: string }): Promise<string> {
  return call<string>(page, "run.start", { action, resourceId: id, target: `resource:${id}`, tabId: "t", input: { "body.url": input.url, "body.path": input.path }, params: {} });
}
async function transfer(page: Page, action: "download" | "upload" | "capture", url: string, file: string, savedUrl = url): Promise<RunInfo> {
  const id = await newJob(page, savedUrl, file);
  return finished(page, await startJob(page, id, action, { url, path: file }));
}

test("setup: install transfer, grant the folder, allow the local address for this workspace", async ({ page }) => {
  await bare(page);
  const preview = await installPkg(page, path.join(FIX, "com.example.transfer/0.1.0"));
  expect(preview.permissions.map((p) => p.id)).toEqual(expect.arrayContaining(["files", "network", "programs"]));
  await call(page, "plugin.grantFolder", { plugin: TRANSFER, path: grant });
  // D308: the loopback address needs to be named by network.allow
  await call(page, "params.set", { node: await cfgNode(page), name: "network.allow", value: `127.0.0.1:${srv.port}` });
});

test("download: a small file arrives byte for byte; the answer says status and bytes", async ({ page }) => {
  await bare(page);
  const file = path.join(grant, "small.bin");
  const run = await transfer(page, "download", `${srv.url}/bytes/100000`, file);
  expect(run.error).toBeUndefined();
  expect(run.status).toBe("success");
  expect(run.output).toMatchObject({ type: "text", text: "status 200, 100000 bytes" });
  expect(readFileSync(file).equals(pattern(100000))).toBe(true);
  expect(left(grant)).toEqual(["small.bin"]);
});

test("download: a file far bigger than the sandbox memory arrives byte for byte (content never passes through the plugin)", async ({ page }) => {
  test.setTimeout(180_000);
  await bare(page);
  const size = 40 * MB;
  const file = path.join(grant, "big.bin");
  const run = await transfer(page, "download", `${srv.url}/bytes/${size}`, file);
  expect(run.error).toBeUndefined();
  expect(run.output!.text).toBe(`status 200, ${size} bytes`);
  expect(statSync(file).size).toBe(size);
  expect(shaFile(file)).toBe(sha(pattern(size)));
  // chunked (no content length) works too
  const file2 = path.join(grant, "big2.bin");
  const run2 = await transfer(page, "download", `${srv.url}/nolength/${5 * MB}`, file2);
  expect(run2.output!.text).toBe(`status 200, ${5 * MB} bytes`);
  expect(shaFile(file2)).toBe(sha(pattern(5 * MB)));
  expect(left(grant).filter((n) => n.includes(".part-"))).toEqual([]);
});

test("download: an answer that is not 2xx reports the status and writes no file", async ({ page }) => {
  await bare(page);
  const file = path.join(grant, "missing.bin");
  const run = await transfer(page, "download", `${srv.url}/status/404`, file);
  expect(run.status).toBe("success");
  expect(run.output!.text).toBe("status 404, 0 bytes");
  expect(existsSync(file)).toBe(false);
  expect(left(grant).filter((n) => n.includes(".part-"))).toEqual([]);
});

test("upload: the server receives exactly the bytes of the file", async ({ page }) => {
  await bare(page);
  const data = pattern(3 * MB + 17);
  const file = path.join(grant, "up.bin");
  writeFileSync(file, data);
  const before = srv.received.length;
  const run = await transfer(page, "upload", `${srv.url}/sink/up.bin`, file);
  expect(run.error).toBeUndefined();
  expect(run.output!.text).toBe("status 200");
  expect(srv.received.slice(before)).toEqual([expect.objectContaining({ name: "up.bin", bytes: data.length })]);
});

test("capture: the program's output is saved to <path>.copy, byte for byte", async ({ page }) => {
  await bare(page);
  const data = pattern(2 * MB + 5);
  const file = path.join(grant, "in.bin");
  writeFileSync(file, data);
  const run = await transfer(page, "capture", `${srv.url}/bytes/1`, file);
  expect(run.error).toBeUndefined();
  expect(run.output!.text).toBe(`${data.length} bytes`);
  expect(readFileSync(`${file}.copy`).equals(data)).toBe(true);
  expect(left(grant).filter((n) => n.includes(".part-"))).toEqual([]);
});

test("the transfer is audited by host / program, without the address path", async ({ page }) => {
  await bare(page);
  const audit = await call<{ actor: string; operation: string; object?: string; result: string; detail: string }[]>(page, "audit.list", {});
  const ops = audit.filter((a) => a.operation.startsWith("transfer."));
  expect(ops.map((a) => a.operation)).toEqual(expect.arrayContaining(["transfer.download", "transfer.upload", "transfer.capture"]));
  expect(JSON.stringify(ops)).not.toContain("/bytes/");
  expect(audit.some((a) => a.operation === "network.request" || a.operation === "process.run")).toBe(false);
});

test("a slow download shows progress in the task panel; cancelling leaves no file and no .part- file behind", async ({ page }) => {
  await bare(page);
  const file = path.join(grant, "slow.bin");
  const url = `${srv.url}/slow/20`;
  const id = await newJob(page, url, file);
  await openKernel(page, host);
  // started from the shell (the panel lists what this window started)
  await showTree(page, "Resources");
  await page.getByRole("treeitem", { name: new RegExp(`^Job ${jobSeq}\\b`) }).click();
  await page.getByRole("button", { name: "Download", exact: true }).first().click();
  const runId = await expect
    .poll(async () => (await call<{ id: string; status: string }[]>(page, "run.tasks")).find((r) => r.status === "running")?.id ?? "", { timeout: 15_000 })
    .not.toBe("")
    .then(async () => (await call<{ id: string; status: string }[]>(page, "run.tasks")).find((r) => r.status === "running")!.id);
  void id;
  await expect.poll(async () => (await getRun(page, runId)).progress?.message ?? "", { timeout: 15_000 }).toMatch(/\d+ bytes/);
  expect((await getRun(page, runId)).status).toBe("running");
  // while a run is going the status bar says "N running" (and shows the progress text); it opens the same panel
  await expect(page.getByText(/Job \d+ — \d+ bytes/).first()).toBeVisible();
  await page.getByRole("button", { name: /\d+ running|Tasks: \d+/ }).click();
  await expect(page.getByRole("region", { name: "Tasks" })).toContainText(/\d+ bytes/);
  await shot(page, "transfer-progress");
  expect(left(grant).some((n) => n.includes(".part-"))).toBe(true); // the temporary file exists while it runs
  await call(page, "run.cancel", { id: runId });
  expect((await finished(page, runId)).status).toBe("cancelled");
  await expect.poll(() => left(grant).filter((n) => n.startsWith("slow") || n.includes(".part-")), { timeout: 10_000 }).toEqual([]);
});

test("refused: an address that is not authorized, a path outside the folder, a target that exists", async ({ page }) => {
  await bare(page);
  // 1. the address in the run is not the one the resource was saved with: localhost is not authorized
  const f1 = path.join(grant, "a.bin");
  const r1 = await transfer(page, "download", `http://localhost:${srv.port}/bytes/10`, f1, `${srv.url}/bytes/10`);
  expect(r1.status).toBe("error");
  expect(r1.error).toMatchObject({ code: "denied", reason: "hostNotAllowed" });
  expect(existsSync(f1)).toBe(false);
  // 2. a path outside the granted folder
  const f2 = path.join(outside, "b.bin");
  const r2 = await transfer(page, "download", `${srv.url}/bytes/10`, f2);
  expect(r2.status).toBe("error");
  expect(r2.error).toMatchObject({ code: "denied", reason: "outsideGrant" });
  expect(existsSync(f2)).toBe(false);
  // 3. the target exists: refused, the file is untouched
  const f3 = path.join(grant, "exists.bin");
  writeFileSync(f3, "keep me");
  const r3 = await transfer(page, "download", `${srv.url}/bytes/10`, f3);
  expect(r3.status).toBe("error");
  expect(r3.error).toMatchObject({ code: "conflict", reason: "exists" });
  expect(readFileSync(f3, "utf8")).toBe("keep me");
  expect(left(grant).filter((n) => n.includes(".part-"))).toEqual([]);
});

test("refused: the error of a refused address names the host", async ({ page }) => {
  await bare(page);
  const r = await transfer(page, "download", `http://localhost:${srv.port}/bytes/10`, path.join(grant, "h.bin"), `${srv.url}/bytes/10`);
  expect(r.error!.params).toMatchObject({ host: expect.stringContaining("localhost") });
});

test("refused: a program that network/process policy does not allow is named in the error, also in the shell", async ({ page }) => {
  await bare(page);
  const cfg = await cfgNode(page);
  const src = path.join(grant, "policy.txt");
  writeFileSync(src, "x");
  const id = await newJob(page, `${srv.url}/bytes/1`, src);
  await call(page, "params.set", { node: cfg, name: "process.allow", value: "echo" });
  try {
    const r = await finished(page, await startJob(page, id, "capture", { url: `${srv.url}/bytes/1`, path: src }));
    expect(r.status).toBe("error");
    expect(r.error).toMatchObject({ code: "denied", reason: "blockedByPolicy" });
    expect(r.error!.params).toMatchObject({ program: "cat" });
    expect(existsSync(`${src}.copy`)).toBe(false);
    // in the shell: the same refusal, with the name in the text
    await openKernel(page, host);
    await showTree(page, "Resources");
    await page.getByRole("treeitem", { name: new RegExp(`^Job ${jobSeq}\\b`) }).click();
    await page.getByRole("button", { name: "Capture program output" }).click();
    await expect(page.getByText(/“cat”/).first()).toBeVisible();
    await shot(page, "transfer-refused");
  } finally {
    await call(page, "params.unset", { node: cfg, name: "process.allow" });
  }
});

/* ------------------------------------------------------------------ exported trees and pages */

const BOARD_TREE = `${BOARD}:board`;
const MEMO = `${EXTRA}:memo`;
const STRAY = `${EXTRA}:stray`;
let boardPreview: Preview;
let memoId = "";

test("board-extra: the install dialog lists the permission `pages` with the board's page; board itself has none", async ({ page }) => {
  await bare(page);
  const board = await installPkg(page, path.join(FIX, "com.example.board/0.1.0"));
  expect(board.permissions.map((p) => p.id)).not.toContain("pages");
  boardPreview = await call<Preview>(page, "app.inspectPlugin", { folder: path.join(FIX, "com.example.board-extra/0.1.0") });
  expect(boardPreview.valid).toBe(true);
  expect(boardPreview.permissions.find((p) => p.id === "pages")?.detail).toContain(`${BOARD}:card`);
  await call(page, "app.installPlugin", { folder: path.join(FIX, "com.example.board-extra/0.1.0"), id: boardPreview.id, version: boardPreview.version, fingerprint: boardPreview.fingerprint });
  expect((await detail(page, EXTRA)).permissions.find((p) => p.id === "pages")?.detail).toContain(`${BOARD}:card`);
  expect((await detail(page, EXTRA)).load.state).toBe("loaded");
});

test("the board tree's “new” menu has the memo, not the stray note; the plugin page says the tree is not exported", async ({ page }) => {
  await bare(page);
  const trees = await call<{ id: string; menu: { id: string }[]; toolbar: { id: string }[] }[]>(page, "tree.list", {});
  const tree = trees.find((t) => t.id === BOARD_TREE)!;
  expect(tree.menu.map((m) => m.id)).toContain(`new:${MEMO}`);
  expect(tree.menu.map((m) => m.id)).toContain(`new:${BOARD}:card`);
  expect(JSON.stringify(trees.map((t) => t.menu))).not.toContain(STRAY);
  expect((await detail(page, EXTRA)).unmetExports).toEqual([`${BOARD}:hidden`]);
  const e = await refused(page, "page.save", { target: `new:${STRAY}`, changes: { name: "Nope", "body.text": "x" } });
  expect(e).toMatchObject({ code: "denied", params: { reason: "notExported", export: `${BOARD}:hidden` } });
});

test("a memo is created in the board's tree, opens with the board's page, is edited, upper-cased and saved; it is still there after reopening", async ({ page }) => {
  await bare(page);
  const saved = await call<{ page: { resourceId: string } }>(page, "page.save", { target: `new:${MEMO}`, changes: { name: "First memo", "body.text": "hello board" } });
  memoId = saved.page.resourceId;
  const kids = (await call<{ nodes: Node[] }>(page, "tree.children", { tree: BOARD_TREE })).nodes;
  expect(kids.map((n) => n.key)).toContain(memoId);
  expect((await call<{ nodes: Node[] }>(page, "tree.children", { tree: "resources" })).nodes.map((n) => n.key)).not.toContain(memoId);
  // the page is the board's: its form and its actions
  const resolved = await call<{ found: boolean; state: string; view: { fields?: { bind: string }[] }[]; actions: { id: string; role: string; action?: string }[]; resultTabs: { type: string }[] }>(page, "page.resolve", { target: `resource:${memoId}` });
  expect(resolved.found).toBe(true);
  expect(resolved.view.flatMap((n) => n.fields ?? []).map((f) => f.bind)).toEqual(["body.text"]);
  const roles = resolved.actions.map((a) => [a.id, a.role]);
  expect(roles).toEqual(expect.arrayContaining([["save", "save"], ["upper", "event"]]));
  expect(resolved.actions.some((a) => (a.action ?? a.id).includes("shout"))).toBe(true);
  expect(resolved.resultTabs.map((t) => t.type)).not.toContain("view");
  // the event runs the board's code; its answer is a change of the unsaved text
  const ev = await call<{ changes?: Record<string, string>; message?: unknown }>(page, "page.event", { target: `resource:${memoId}`, event: "upper", context: { draft: { "body.text": "make this loud" }, locale: "en-US" } });
  expect(ev.changes).toEqual({ "body.text": "MAKE THIS LOUD" });
  // saving is the framework's job, validated against the memo's fields
  await call(page, "page.save", { target: `resource:${memoId}`, changes: { "body.text": ev.changes!["body.text"] } });
  const after = await call<{ values: Record<string, string> }>(page, "page.resolve", { target: `resource:${memoId}` });
  expect(after.values["body.text"]).toBe("MAKE THIS LOUD");
  expect((await call<{ body: { text: string } }>(page, "resource.get", { id: memoId })).body.text).toBe("MAKE THIS LOUD");
});

test("the memo's own action `shout` runs and gives a result", async ({ page }) => {
  await bare(page);
  const runId = await call<string>(page, "run.start", { action: "shout", resourceId: memoId, target: `resource:${memoId}`, tabId: "t", input: {}, params: {} });
  const run = await finished(page, runId, 20_000);
  expect(run.error).toBeUndefined();
  expect(run.output).toMatchObject({ type: "text", text: "MAKE THIS LOUD!" });
});

test("UI: create a memo from the board tree, edit it with the board's page, upper-case, save, reopen", async ({ page }) => {
  await openKernel(page, host);
  await showTree(page, "Board");
  await expect(page.locator("[data-tree-key]", { hasText: "First memo" }).first()).toBeVisible();
  await page.locator("[data-tree-key]", { hasText: "First memo" }).first().dblclick();
  const editor = page.getByRole("textbox", { name: "Text", exact: true });
  await expect(editor).toHaveValue("MAKE THIS LOUD");
  await expect(page.getByRole("button", { name: "Shout" })).toBeVisible();
  await editor.fill("quiet again");
  await page.getByRole("button", { name: "Make upper case" }).click();
  await expect(editor).toHaveValue("QUIET AGAIN");
  await page.keyboard.press("Meta+s");
  await expect(page.getByText("Unsaved", { exact: true })).toHaveCount(0);
  await shot(page, "board-memo");
  await page.goto("about:blank");
  await openKernel(page, host);
  await showTree(page, "Board");
  await page.locator("[data-tree-key]", { hasText: "First memo" }).first().dblclick();
  await expect(page.getByRole("textbox", { name: "Text", exact: true })).toHaveValue("QUIET AGAIN");
});

test("UI: the plugin page of board-extra says which type cannot be used and why", async ({ page }) => {
  await openKernel(page, host);
  await showTree(page, "Plugins");
  await page.locator("[data-tree-key]", { hasText: "Board extras" }).first().dblclick();
  await expect(page.getByText(`${BOARD}:hidden`).first()).toBeVisible();
  await expect(page.getByText(`${BOARD}:card`).first()).toBeVisible(); // the pages permission
  await shot(page, "plugin-unmet-exports");
});

test("disabling the board is refused while board-extra is on; with board-extra off and then on, its dependency is shown unmet", async ({ page }) => {
  await bare(page);
  const e = await refused(page, "plugin.setEnabled", { plugin: BOARD, enabled: false });
  expect(e).toMatchObject({ code: "conflict", params: { reason: "dependents", plugins: EXTRA } });
  await call(page, "plugin.setEnabled", { plugin: EXTRA, enabled: false });
  await call(page, "plugin.setEnabled", { plugin: BOARD, enabled: false });
  await call(page, "plugin.setEnabled", { plugin: EXTRA, enabled: true });
  const d = await detail(page, EXTRA);
  expect(d.load).toMatchObject({ state: "disabled", message: "dependsUnmet" });
  expect(d.depends![0]).toMatchObject({ id: BOARD, satisfied: false });
  await call(page, "plugin.setEnabled", { plugin: BOARD, enabled: true });
  expect((await detail(page, EXTRA)).load.state).toBe("loaded");
  expect((await call<{ values: Record<string, string> }>(page, "page.resolve", { target: `resource:${memoId}` })).values["body.text"]).toBe("QUIET AGAIN");
});

/* ------------------------------------------------------------------ the market: the pick is a page parameter */

test("market: choosing a package shows no “Unsaved”, installing clears the choice", async ({ page }) => {
  test.setTimeout(120_000);
  await bare(page);
  await call(page, "plugin.grantFolder", { plugin: MARKET_ID, path: MARKET });
  await openKernel(page, host);
  await showTree(page, "Plugin market");
  await page.locator("[data-tree-key]", { hasText: "Local packages" }).first().dblclick();
  await page.getByRole("combobox", { name: "Package to install" }).click();
  await page.getByRole("option", { name: /Hello/ }).click();
  await expect(page.getByRole("combobox", { name: "Package to install" })).toContainText("Hello");
  await expect(page.getByText("Unsaved", { exact: true })).toHaveCount(0);
  await shot(page, "market-picked");
  await page.getByRole("button", { name: "Install", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Plugin market");
  await dialog.getByRole("button", { name: "Install", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("row", { name: /Hello/ })).toContainText("Installed 0.1.0");
  await expect(page.getByRole("combobox", { name: "Package to install" })).not.toContainText("Hello");
  await expect(page.getByText("Unsaved", { exact: true })).toHaveCount(0);
  // the event itself gets the parameter in the page context (protocol level)
  const e = await refused(page, "page.event", { target: MARKET_TARGET, event: "install", context: { params: { pick: path.join(base, "elsewhere") }, locale: "en-US" } });
  expect(e.code).toBe("denied");
});
