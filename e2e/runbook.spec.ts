/**
 * D487 §25 (docs/redesign/book.md) against the REAL kernel and the real runbook, script, HTTP and book plugins: a
 * release procedure — check the version (a script), a health check (an HTTP request to a local test server, expected
 * status 200), a confirmation, the release (skipped outside production), check the version again (expected 2.3.2).
 * Run from the flow contents: it stops to be confirmed, continues, stops on the failing check, continues once fixed;
 * the run log has every step and exports as a report.
 * Screenshots (not checked in): test-results/screenshots/runbook-*.png.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { DEVHOST, OUT, openKernel, rpc, startHost, stopHost, type Host } from "./kernel-host";

test.use({ viewport: { width: 1440, height: 900 }, locale: "en-US" });
test.describe.configure({ mode: "serial" });
test.setTimeout(180_000);

let host: Host;
let base: string;
let server: Server;
let port = 0;

test.beforeAll(async () => {
  test.skip(!existsSync(DEVHOST), `onedesk-devhost not built at ${DEVHOST}`);
  base = realpathSync(mkdtempSync(path.join(tmpdir(), "od-runbook-")));
  writeFileSync(path.join(base, "version.txt"), "2.3.1\n");
  host = await startHost(path.join(base, "data"));
  server = createServer((req, res) => {
    res.writeHead(req.url === "/health" ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: req.url === "/health" }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  port = (server.address() as { port: number }).port;
});
test.afterAll(async () => {
  if (server) server.close();
  if (host) await stopHost(host);
  if (base) rmSync(base, { recursive: true, force: true });
});

const R = "org.onedesk.runbook";
type Node = { key: string; label: string };
const call = <T = unknown>(page: Page, method: string, params: unknown = null) => rpc<T>(page, host, method, params);
const shot = (page: Page, name: string) => page.screenshot({ path: path.join(OUT, `runbook-${name}.png`) });
const action = (page: Page, name: string) => page.locator(".od-titlebar__actions").getByRole("button", { name, exact: true });
const kids = async (page: Page, parent: string) => (await call<{ nodes: Node[] }>(page, "tree.children", { tree: "resources", parent })).nodes;

async function make(page: Page, kind: string, parent: string | null, changes: Record<string, unknown>): Promise<string> {
  const target = parent ? `new:${kind}?parent=${parent}` : `new:${kind}`;
  const r = await call<{ page: { resourceId: string } }>(page, "page.save", { target, changes });
  return r.page.resourceId;
}

test("a release procedure run from its flow contents: confirm, continue, a failed check, fixed, done; the log exported", async ({ page }) => {
  await openKernel(page, host);
  const cfg = (await call<{ nodes: Node[] }>(page, "tree.children", { tree: "config" })).nodes.find((n) => n.label === "Workspace")!.key;
  await call(page, "params.set", { node: cfg, name: "network.allow", value: `127.0.0.1:${port}` });
  const env = (await call<{ nodes: Node[] }>(page, "tree.children", { tree: "env" })).nodes.find((n) => n.label === "Default")!.key;
  for (const [name, value] of [["host", `127.0.0.1:${port}`], ["stage", "test"], ["Operator", "Zhang"]]) await call(page, "params.set", { node: env, name, value });
  const out = path.join(base, "reports");
  mkdirSync(out, { recursive: true });
  await call(page, "plugin.grantFolder", { plugin: R, path: out });

  const version = await make(page, "org.onedesk.script:script", null, { name: "Read version", "body.script": `cat ${path.join(base, "version.txt")}` });
  const deploy = await make(page, "org.onedesk.script:script", null, { name: "Deploy script", "body.script": "echo deployed" });
  const health = await make(page, "org.onedesk.http:request", null, { name: "Health", "body.method": "GET", "body.url": `http://127.0.0.1:${port}/health` });

  const book = await make(page, "org.onedesk.book:book", null, { name: "Release manual" });
  await expect.poll(async () => (await kids(page, book)).length).toBe(2);
  const toc = (await kids(page, book)).find((n) => n.label === "Contents")!.key;
  await call(page, "resource.delete", { id: toc });
  await make(page, `${R}:flow`, book, { name: "Procedure" });
  await make(page, `${R}:step`, book, { name: "Version before", "body.text": "Read the version in production.", "body.target": version });
  await make(page, `${R}:step`, book, { name: "Health check", "body.target": health, "body.expect": "@Health check.status = 200\n@Health check.json.ok = true" });
  await make(page, `${R}:step`, book, { name: "Go ahead", "body.text": "Look at the version and the health check.", "body.confirm": "Check the above, then continue" });
  await make(page, `${R}:step`, book, { name: "Release", "body.target": deploy, "body.when": "{{stage}} = production" });
  await make(page, `${R}:step`, book, { name: "Version after", "body.target": version, "body.expect": "@Version after.output = 2.3.2" });

  await page.reload();
  await page.getByRole("button", { name: "Expand all" }).first().click();
  await page.getByRole("treeitem", { name: "Procedure", exact: true }).click();
  const nav = page.getByRole("navigation", { name: "Contents" });
  await expect(nav.getByRole("button", { name: /· Chapter 1 Version before/ })).toBeVisible({ timeout: 15_000 });
  await action(page, "Run").click();
  await expect(nav.getByRole("button", { name: /⏸ Chapter 3 Go ahead/ })).toBeVisible({ timeout: 30_000 });
  await expect(nav.getByRole("button", { name: /✓ Chapter 2 Health check/ })).toBeVisible();
  await shot(page, "waiting");
  // Continue: confirmed; the release is skipped (not production); the version check fails (still 2.3.1).
  await action(page, "Continue").click();
  await expect(nav.getByRole("button", { name: /✗ Chapter 5 Version after/ })).toBeVisible({ timeout: 30_000 });
  await expect(nav.getByRole("button", { name: /⏭ Chapter 4 Release/ })).toBeVisible();
  // Fixed by hand; continue runs the failed step again.
  writeFileSync(path.join(base, "version.txt"), "2.3.2\n");
  await action(page, "Continue").click();
  await expect(nav.getByRole("button", { name: /✓ Chapter 5 Version after/ })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/Run 1 · Zhang · complete/)).toBeVisible();
  await shot(page, "done");

  // The run log: every step; exported as a report.
  await page.getByRole("button", { name: "Procedure logs" }).first().click();
  await page.getByRole("button", { name: "Expand all" }).first().click();
  await page.getByRole("treeitem", { name: "Release manual · run 1", exact: true }).click();
  await expect(page.getByRole("row", { name: /Health check/ })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("row", { name: /Go ahead/ })).toContainText("confirmed");
  await page.getByRole("row", { name: /Health check/ }).click();
  await expect(page.getByText("✓ @Health check.status = 200")).toBeVisible({ timeout: 15_000 });
  await shot(page, "log");
  await action(page, "Export report").click();
  await expect.poll(() => readdirSync(out).length, { timeout: 30_000 }).toBe(1);
  const md = readFileSync(path.join(out, readdirSync(out)[0]!), "utf8");
  expect(md).toContain("## ✓ Health check");
  expect(md).toContain("## ⏭ Release");
  expect(md).toContain("Confirmed by Zhang");
});
