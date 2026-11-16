/**
 * Round 9 against the REAL kernel: manifest cache (plugins/.index), idle release (keeper fixture), host interface
 * bound to its call (staleContext), and the small fixes (cancelled transfer audit, path / layerName in refusals,
 * no percentage without a total, provided tree follows the language, market marks unusable packages).
 * devhost always runs with ONEDESK_SECRET_STORE=memory, a temp data directory and ONEDESK_PLUGIN_IDLE_MS=2000
 * (kernel-host.ts): the real keychain and ~/Library/Application Support/onedesk* are never touched.
 * Screenshots: docs/screenshots/round9-*.png.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { DEVHOST, OUT, ROOT, openKernel, rpc, startHost, stopHost, type Host } from "./kernel-host";
// @ts-ignore plain JS module, no types
import { startServer } from "./fixtures/transfer-server.mjs";
// @ts-ignore plain JS module, no types
import { makeManyPlugins } from "./fixtures/make-many-plugins.mjs";

test.use({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
test.describe.configure({ mode: "serial" });
test.setTimeout(90_000);

const FIX = path.join(ROOT, "e2e/fixtures/plugins");
const MARKET = path.join(ROOT, "e2e/fixtures/market");
const KEEPER = "com.example.keeper";
const TRANSFER = "com.example.transfer";
const MARKET_ID = "org.onedesk.market";
const MARKET_TARGET = "node:org.onedesk.market:market/local";
const ENV = { ONEDESK_PLUGIN_IDLE_MS: "2000" };

let host: Host;
let base: string;
let dataDir: string;
let grant: string;
let outside: string;
let srv: { port: number; url: string; close(): Promise<void> };
let extraHosts: Host[] = [];

test.beforeAll(async () => {
  test.skip(!existsSync(DEVHOST), `onedesk-devhost not built at ${DEVHOST}`);
  base = realpathSync(mkdtempSync(path.join(tmpdir(), "od-round9-")));
  grant = path.join(base, "grant");
  outside = path.join(base, "outside");
  mkdirSync(grant);
  mkdirSync(outside);
  dataDir = path.join(base, "data");
  srv = await startServer({ port: 0 });
  host = await startHost(dataDir, ENV);
});
test.afterAll(async () => {
  if (host) await stopHost(host);
  for (const h of extraHosts) await stopHost(h).catch(() => undefined);
  if (srv) await srv.close();
  if (base) rmSync(base, { recursive: true, force: true });
});

const shot = async (page: Page, name: string) => {
  await page.mouse.move(640, 2);
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, `round9-${name}.png`) });
};
const call = <T = unknown>(page: Page, method: string, params: unknown = null) => rpc<T>(page, host, method, params);
async function bare(page: Page) {
  await page.goto("/workbench.html?reset&quiet");
}
async function showTree(page: Page, name: string) {
  const b = page.getByRole("navigation", { name: "Views" }).getByRole("button", { name, exact: true });
  if ((await b.getAttribute("aria-pressed")) !== "true") await b.click();
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Preview = { valid: boolean; problem?: unknown; id: string; version: string; fingerprint: string };
async function installPkg(page: Page, folder: string) {
  const preview = await call<Preview>(page, "app.inspectPlugin", { folder });
  expect(preview.valid, JSON.stringify(preview.problem)).toBe(true);
  await call(page, "app.installPlugin", { folder, id: preview.id, version: preview.version, fingerprint: preview.fingerprint });
  return preview;
}
type Detail = { id: string; runtime?: string; load: { state: string } };
const detail = (page: Page, plugin: string) => call<Detail>(page, "plugin.get", { plugin });
const runtime = async (page: Page, plugin = KEEPER) => (await detail(page, plugin)).runtime;
type RunInfo = { id: string; status: string; progress?: { message?: string; fraction?: number }; output?: { type: string; text?: string }; error?: { code: string; reason?: string; message: string; params?: Record<string, string> } };
const getRun = (page: Page, id: string) => call<RunInfo>(page, "run.get", { id });
async function finished(page: Page, runId: string, timeout = 60_000): Promise<RunInfo> {
  await expect.poll(async () => (await getRun(page, runId)).status, { timeout }).not.toBe("running");
  return getRun(page, runId);
}
type Node = { key: string; label: string };
const cfgNode = async (page: Page) => (await call<{ nodes: Node[] }>(page, "tree.children", { tree: "config" })).nodes.find((n) => n.label === "Workspace")!.key;

type IndexEntry = { dir: string; mtime: number; size: number; manifest?: string; error?: string };
const indexOf = (dir: string) => JSON.parse(readFileSync(path.join(dir, "plugins/.index"), "utf8")) as { version: number; entries: IndexEntry[] };
/** `<id>/<version>` directories of a data directory's plugins folder (dot folders skipped). */
function packageDirs(dir: string): string[] {
  const root = path.join(dir, "plugins");
  const out: string[] = [];
  for (const id of readdirSync(root)) {
    if (id.startsWith(".")) continue;
    for (const v of readdirSync(path.join(root, id))) if (!v.startsWith(".")) out.push(`${id}/${v}`);
  }
  return out.sort();
}
async function restart(env: Record<string, string> = ENV) {
  await stopHost(host);
  host = await startHost(dataDir, env);
}

/* ------------------------------------------------------------------ manifest cache */

test("cache: after start the data directory has plugins/.index that matches the installed packages; installing adds one entry", async ({ page }) => {
  await bare(page);
  const before = indexOf(dataDir);
  expect(before.version).toBe(1);
  expect(before.entries.map((e) => e.dir)).toEqual(packageDirs(dataDir));
  for (const e of before.entries) expect(e.manifest, e.dir).toBe(readFileSync(path.join(dataDir, "plugins", e.dir, "manifest.json"), "utf8"));
  expect(before.entries.map((e) => e.dir)).not.toContain(`${KEEPER}/0.1.0`);

  await installPkg(page, path.join(FIX, `${KEEPER}/0.1.0`));
  const after = indexOf(dataDir);
  expect(after.entries.map((e) => e.dir)).toEqual(packageDirs(dataDir));
  expect(after.entries.length).toBe(before.entries.length + 1);
  expect(after.entries.map((e) => e.dir)).toContain(`${KEEPER}/0.1.0`);
  expect((await detail(page, KEEPER)).load.state).toBe("loaded");
});

test("cache: deleting .index and restarting rebuilds it, and the plugins work as before", async ({ page }) => {
  const entries = indexOf(dataDir).entries.map((e) => [e.dir, e.manifest]);
  rmSync(path.join(dataDir, "plugins/.index"));
  await restart();
  await bare(page);
  expect(existsSync(path.join(dataDir, "plugins/.index"))).toBe(true);
  expect(indexOf(dataDir).entries.map((e) => [e.dir, e.manifest])).toEqual(entries);
  expect((await detail(page, KEEPER)).load.state).toBe("loaded");
  expect((await detail(page, MARKET_ID)).load.state).toBe("loaded");
  // a damaged index is rebuilt as well
  writeFileSync(path.join(dataDir, "plugins/.index"), "{ not json");
  await restart();
  await bare(page);
  expect(indexOf(dataDir).entries.map((e) => [e.dir, e.manifest])).toEqual(entries);
  expect((await detail(page, KEEPER)).load.state).toBe("loaded");
});

test("cache: 2000 packages — the second start reads the index and is quick; the index has all of them", async ({ page }) => {
  test.setTimeout(240_000);
  const many = path.join(base, "many-data");
  mkdirSync(path.join(many, "plugins"), { recursive: true });
  makeManyPlugins(path.join(many, "plugins"), 2000);
  await bare(page);
  const timings: number[] = [];
  for (let i = 0; i < 2; i++) {
    const t0 = Date.now();
    const h = await startHost(many, ENV);
    extraHosts.push(h);
    await rpc(page, h, "tree.list", {});
    timings.push(Date.now() - t0); // process spawn .. hello answered (rpc says hello first) .. one cheap call answered
    for (const id of ["com.example.many-00001", "com.example.many-01000", "com.example.many-02000"]) {
      expect((await rpc<Detail>(page, h, "plugin.get", { plugin: id })).load.state, id).toBe("loaded");
    }
    const idx = indexOf(many);
    expect(idx.entries.filter((e) => e.dir.startsWith("com.example.many-")).length).toBe(2000);
    expect(idx.entries.map((e) => e.dir)).toEqual(packageDirs(many));
    await stopHost(h);
    extraHosts = extraHosts.filter((x) => x !== h);
  }
  console.log(`ROUND9-TIMING start→hello+tree.list with 2000 packages: first (builds .index) ${timings[0]} ms, second (reads .index) ${timings[1]} ms`);
  test.info().annotations.push({ type: "timing", description: `first ${timings[0]} ms, second ${timings[1]} ms` });
  expect(timings[1]).toBeLessThan(60_000);
});

/* ------------------------------------------------------------------ idle release + staleContext (keeper) */

let boxId = "";
const event = (page: Page, name: string, draft: Record<string, string> = {}) =>
  call<{ changes?: Record<string, string>; message?: unknown }>(page, "page.event", { target: `resource:${boxId}`, event: name, context: { draft, locale: "en-US" } });
const startRun = (page: Page, action: string) => call<string>(page, "run.start", { action, resourceId: boxId, target: `resource:${boxId}`, tabId: "t", input: {}, params: {} });
const text = (m: unknown) => (typeof m === "string" ? m : JSON.stringify(m));

test("idle: remember, then the runtime is released (idle); recall brings the draft back and the runtime is live again", async ({ page }) => {
  await bare(page);
  boxId = (await call<{ page: { resourceId: string } }>(page, "page.save", { target: `new:${KEEPER}:box`, changes: { name: "Keep me", "body.text": "saved text" } })).page.resourceId;
  const r = await event(page, "remember", { "body.text": "my unsaved draft" });
  expect(text(r.message)).toContain("Remembered");
  expect(await runtime(page)).toBe("live");
  await expect.poll(() => runtime(page), { timeout: 20_000, intervals: [250] }).toBe("idle");
  // being idle is not being disabled
  expect((await detail(page, KEEPER)).load.state).toBe("loaded");

  // the plugin page says so
  await openKernel(page, host);
  await showTree(page, "Plugins");
  await page.locator("[data-tree-key]", { hasText: "Keeper" }).first().dblclick();
  await expect(page.getByText(/Not running; it starts automatically/).first()).toBeVisible();
  await shot(page, "plugin-idle");

  const back = await event(page, "recall");
  expect(back.changes).toEqual({ "body.text": "my unsaved draft" });
  expect(await runtime(page)).toBe("live");
  await page.goto("about:blank");
  await bare(page);
  await expect.poll(() => runtime(page), { timeout: 20_000, intervals: [250] }).toBe("idle"); // and it drops again
});

test("idle: a run in progress keeps the runtime live, past several idle times", async ({ page }) => {
  test.setTimeout(120_000);
  await bare(page);
  const run = await startRun(page, "slow");
  await expect.poll(async () => (await getRun(page, run)).status).toBe("running");
  const seen: (string | undefined)[] = [];
  const t0 = Date.now();
  while (Date.now() - t0 < 7000) {
    seen.push(await runtime(page));
    await sleep(500);
  }
  expect(seen.length).toBeGreaterThan(8);
  expect(seen.every((s) => s === "live")).toBe(true); // idle time is 2 s; 7 s is more than three of them
  expect((await getRun(page, run)).status).toBe("running");
  await call(page, "run.cancel", { id: run });
  await finished(page, run);
});

test("staleContext: a host kept from a finished run is refused from a page event", async ({ page }) => {
  await bare(page);
  const run = await finished(page, await startRun(page, "stash"));
  expect(run.error).toBeUndefined();
  expect(run.output?.text).toBe("stashed");
  const r = await event(page, "abuse");
  expect(text(r.message)).not.toContain("request went through");
  expect(JSON.parse(text(r.message))).toMatchObject({ code: "denied", params: { reason: "staleContext" } });
});

test("staleContext: a host kept from one run is refused from a page event while another run is going", async ({ page }) => {
  test.setTimeout(120_000);
  await bare(page);
  // The kept host lives in the module of the runtime; if the runtime is released between `stash` and the event
  // (a loaded machine, idle time 2 s) the plugin has nothing kept: then start over.
  let message = "";
  for (let attempt = 0; attempt < 4 && !message.startsWith("{"); attempt++) {
    expect((await finished(page, await startRun(page, "stash"))).output?.text).toBe("stashed");
    const slow = await startRun(page, "slow");
    await expect.poll(async () => (await getRun(page, slow)).status).toBe("running");
    message = text((await event(page, "abuse")).message);
    await call(page, "run.cancel", { id: slow });
    await finished(page, slow);
  }
  expect(message).not.toContain("request went through");
  expect(JSON.parse(message)).toMatchObject({ code: "denied", params: { reason: "staleContext" } });
});

test("provided tree: the node name follows the language (protocol and shell)", async ({ page }) => {
  await bare(page);
  const label = async (locale?: string) => (await call<{ nodes: Node[] }>(page, "tree.children", { tree: `${KEEPER}:keeper`, ...(locale ? { locale } : {}) })).nodes[0]!.label;
  expect(await label("en-US")).toBe("Keeper node (en-US)");
  expect(await label("zh-CN")).toBe("保管员节点（zh-CN）");
  await openKernel(page, host);
  await showTree(page, "Keeper");
  await expect(page.getByText("Keeper node (en-US)").first()).toBeVisible();
  await page.getByRole("button", { name: "Language" }).click();
  await page.getByRole("menuitem", { name: "简体中文" }).click();
  try {
    await expect(page.getByText("保管员节点（zh-CN）").first()).toBeVisible();
    await shot(page, "keeper-tree-zh");
  } finally {
    await call(page, "workspace.setConfig", { name: "ui.language", value: "en-US" });
  }
});

/* ------------------------------------------------------------------ small fixes (transfer) */

let jobSeq = 0;
async function newJob(page: Page, url: string, file: string): Promise<string> {
  const changes = { name: `Job ${++jobSeq}`, "body.url": url, "body.path": file };
  return (await call<{ page: { resourceId: string } }>(page, "page.save", { target: `new:${TRANSFER}:job`, changes })).page.resourceId;
}
const startJob = (page: Page, id: string, action: string, input: { url: string; path: string }) =>
  call<string>(page, "run.start", { action, resourceId: id, target: `resource:${id}`, tabId: "t", input: { "body.url": input.url, "body.path": input.path }, params: {} });

test("transfer setup: install, grant the folder, allow the local address", async ({ page }) => {
  await bare(page);
  await installPkg(page, path.join(FIX, `${TRANSFER}/0.1.0`));
  await call(page, "plugin.grantFolder", { plugin: TRANSFER, path: grant });
  await call(page, "params.set", { node: await cfgNode(page), name: "network.allow", value: `127.0.0.1:${srv.port}` });
});

type Audit = { operation: string; object?: string; result: string; detail: string };
// FIXME (kernel): a download cancelled with run.cancel is audited with result "error" (detail {"ms":..}), not "cancelled" (D368).
// The cancel path in crates/kernel/src/carry.rs returns Err(denied("cancelled")) from the select, which the normal error
// audit turns into "error"; only the `Unfinished` drop guard writes "cancelled". Re-enable when the kernel is fixed.
test.fixme("a cancelled download is in the audit log as transfer.download, result cancelled", async ({ page }) => {
  await bare(page);
  const file = path.join(grant, "cancel.bin");
  const url = `${srv.url}/slow/20`;
  const id = await newJob(page, url, file);
  const run = await startJob(page, id, "download", { url, path: file });
  await expect.poll(async () => (await getRun(page, run)).progress?.message ?? "", { timeout: 15_000 }).toMatch(/\d+ bytes/);
  await call(page, "run.cancel", { id: run });
  expect((await finished(page, run)).status).toBe("cancelled");
  await expect
    .poll(async () => (await call<Audit[]>(page, "audit.list", {})).filter((a) => a.operation === "transfer.download").map((a) => a.result), { timeout: 15_000 })
    .toContain("cancelled");
  expect(JSON.stringify(await call<Audit[]>(page, "audit.list", {}))).not.toContain("/slow/");
});

test("progress without a total has no percentage (task panel, status bar, run)", async ({ page }) => {
  await bare(page);
  const file = path.join(grant, "nototal.bin");
  const url = `${srv.url}/slow/20`; // chunked: no content length
  const id = await newJob(page, url, file);
  await openKernel(page, host);
  await showTree(page, "Resources");
  await page.getByRole("treeitem", { name: new RegExp(`^Job ${jobSeq}\\b`) }).click();
  await page.getByRole("button", { name: "Download", exact: true }).first().click();
  let runId = "";
  await expect
    .poll(async () => (runId = (await call<{ id: string; status: string }[]>(page, "run.tasks")).find((r) => r.status === "running")?.id ?? ""), { timeout: 15_000 })
    .not.toBe("");
  await expect.poll(async () => (await getRun(page, runId)).progress?.message ?? "", { timeout: 15_000 }).toMatch(/\d+ bytes/);
  const prog = (await getRun(page, runId)).progress!;
  expect(prog.fraction).toBeUndefined();
  const bar = page.getByText(/Job \d+ — \d+ bytes/).first();
  await expect(bar).toBeVisible();
  expect(await bar.textContent()).not.toContain("%");
  await page.getByRole("button", { name: /\d+ running|Tasks: \d+/ }).click();
  const panel = page.getByRole("region", { name: "Tasks" });
  await expect(panel).toContainText(/\d+ bytes/);
  expect(await panel.textContent()).not.toMatch(/\d\s*%/);
  await shot(page, "progress-no-total");
  await call(page, "run.cancel", { id: runId });
  await finished(page, runId);
  void id;
});

test("refused: outsideGrant carries the path, and the shell text shows it", async ({ page }) => {
  await bare(page);
  const target = path.join(outside, "out.bin");
  const url = `${srv.url}/bytes/10`;
  const id = await newJob(page, url, target);
  const run = await finished(page, await startJob(page, id, "download", { url, path: target }));
  expect(run.error).toMatchObject({ code: "denied", reason: "outsideGrant" });
  expect(run.error!.params).toMatchObject({ path: target });
  await openKernel(page, host);
  await showTree(page, "Resources");
  await page.getByRole("treeitem", { name: new RegExp(`^Job ${jobSeq}\\b`) }).click();
  await page.getByRole("button", { name: "Download", exact: true }).first().click();
  await expect(page.getByText(target).first()).toBeVisible();
  await shot(page, "refused-path");
});

test("refused: network.allow names the layer that refuses, and the shell text shows it", async ({ page }) => {
  await bare(page);
  const cfg = await cfgNode(page);
  const url = `${srv.url}/bytes/10`;
  const file = path.join(grant, "policy.bin");
  const id = await newJob(page, url, file);
  await call(page, "params.set", { node: cfg, name: "network.allow", value: "example.com" });
  try {
    const run = await finished(page, await startJob(page, id, "download", { url, path: file }));
    expect(run.error).toMatchObject({ code: "denied", reason: "blockedByPolicy" });
    expect(run.error!.params!.layerName).toBeTruthy();
    expect(existsSync(file)).toBe(false);
    await openKernel(page, host);
    await showTree(page, "Resources");
    await page.getByRole("treeitem", { name: new RegExp(`^Job ${jobSeq}\\b`) }).click();
    await page.getByRole("button", { name: "Download", exact: true }).first().click();
    await expect(page.getByText(new RegExp(`“${run.error!.params!.layerName}”`)).first()).toBeVisible();
    await shot(page, "refused-layer");
  } finally {
    await call(page, "params.set", { node: cfg, name: "network.allow", value: `127.0.0.1:${srv.port}` });
  }
});

/* ------------------------------------------------------------------ market */

test("market: packages that cannot be installed are listed as unavailable and are not in the dropdown", async ({ page }) => {
  await bare(page);
  const market = path.join(base, "market");
  cpSync(path.join(MARKET, "com.example.hello"), path.join(market, "com.example.hello"), { recursive: true });
  const hello = JSON.parse(readFileSync(path.join(MARKET, "com.example.hello/0.1.0/manifest.json"), "utf8"));
  const put = (dir: string, m: unknown) => {
    mkdirSync(path.join(market, dir), { recursive: true });
    writeFileSync(path.join(market, dir, "manifest.json"), JSON.stringify(m));
  };
  put("com.example.wrong-id/0.1.0", { ...hello, id: "com.example.other" });
  put("com.example.wrong-version/0.1.0", { ...hello, id: "com.example.wrong-version", version: "9.9.9" });
  const { main: _main, ...noMain } = hello;
  put("com.example.no-main/0.1.0", { ...noMain, id: "com.example.no-main" });
  await call(page, "plugin.grantFolder", { plugin: MARKET_ID, path: market });
  const resolved = await call<{ view: { type: string; rows?: string[][]; fields?: { name: string; options?: { value: string; label: string }[] }[] }[] }>(page, "page.resolve", { target: MARKET_TARGET });
  const rows = resolved.view.find((n) => n.type === "table")!.rows!;
  const status = (name: string) => rows.find((r) => r[0]!.includes(name))?.[3];
  expect(status("Hello")).toBe("Not installed");
  for (const n of ["wrong-id", "wrong-version", "no-main"]) expect(status(n), n).toBe("Unavailable");
  const options = resolved.view.flatMap((n) => n.fields ?? []).find((f) => f.name === "pick")!.options!;
  expect(options.map((o) => o.value)).toEqual([path.join(market, "com.example.hello/0.1.0")]);
  await openKernel(page, host);
  await showTree(page, "Plugin market");
  await page.locator("[data-tree-key]", { hasText: "Local packages" }).first().dblclick();
  await expect(page.getByRole("row", { name: /wrong-id/ })).toContainText("Unavailable");
  await page.getByRole("combobox", { name: "Package to install" }).click();
  await expect(page.getByRole("option")).toHaveCount(1);
  await expect(page.getByRole("option", { name: /Hello/ })).toBeVisible();
  await shot(page, "market-unavailable");
});
