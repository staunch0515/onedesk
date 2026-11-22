/**
 * Round 4 against the REAL kernel: installing plugin packages, versions and upgrades, secrets, and the HTTP
 * request plugin against a local test server. devhost always runs with ONEDESK_SECRET_STORE=memory (see
 * kernel-host.ts): the real keychain is never touched.
 * Screenshots: docs/screenshots/round4-*.png.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, cpSync, statSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { DEVHOST, OUT, ROOT, openKernel, rpc, startHost, stopHost, type Host } from "./kernel-host";

test.use({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
test.describe.configure({ mode: "serial" });
test.setTimeout(120_000);

const FIXTURES = path.join(ROOT, "e2e/fixtures/plugins");
const SAMPLE = "org.onedesk.sample:query";
const HTTP = "org.onedesk.http:request";

let host: Host;
let base: string;
let dataDir: string;

type Seen = { url: string; headers: http.IncomingHttpHeaders };
const seen: Seen[] = [];
const servers: http.Server[] = [];
let portA = 0; // the main test server
let portB = 0; // a second server the first one redirects to

const listen = (handler: http.RequestListener) =>
  new Promise<{ server: http.Server; port: number }>((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as AddressInfo).port }));
    servers.push(server);
  });

test.beforeAll(async () => {
  test.skip(!existsSync(DEVHOST), `onedesk-devhost not built at ${DEVHOST}`);
  base = realpathSync(mkdtempSync(path.join(tmpdir(), "od-round4-")));
  dataDir = path.join(base, "data");
  const b = await listen((req, res) => {
    seen.push({ url: `B${req.url}`, headers: req.headers });
    res.writeHead(200, { "content-type": "text/plain" }).end("landed on B");
  });
  portB = b.port;
  const a = await listen((req, res) => {
    seen.push({ url: `A${req.url}`, headers: req.headers });
    if (req.url?.startsWith("/redirect")) return void res.writeHead(302, { location: `http://127.0.0.1:${portB}/landing` }).end();
    if (req.url?.startsWith("/missing")) return void res.writeHead(404, { "content-type": "text/plain", "x-test": "yes" }).end("no such thing");
    res.writeHead(200, { "content-type": "text/plain", "x-test": "yes" }).end("hello from server A");
  });
  portA = a.port;
  host = await startHost(dataDir);
});
test.afterAll(async () => {
  if (host) await stopHost(host);
  for (const s of servers) s.close();
  if (base) rmSync(base, { recursive: true, force: true });
});

const shot = async (page: Page, name: string) => {
  await page.mouse.move(640, 2);
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, `round4-${name}.png`) });
};
const call = <T = unknown>(page: Page, method: string, params: unknown = null) => rpc<T>(page, host, method, params);
const sideTab = (page: Page, name: string) => page.getByRole("navigation", { name: "Views" }).getByRole("button", { name, exact: true });
const showTree = async (page: Page, name: string) => {
  const b = sideTab(page, name);
  if ((await b.getAttribute("aria-pressed")) !== "true") await b.click();
};
const treeItem = (page: Page, name: string | RegExp) => page.getByRole("treeitem", { name, exact: typeof name === "string" });
const pluginNode = (name: string) => new RegExp(`^${name} \\d`);

type VersionRow = { version: string; active: boolean; pinned: boolean; resourceCount?: number; confirmed?: boolean };
const versions = async (page: Page, plugin: string) => (await call<{ versions: VersionRow[]; enabled: boolean }>(page, "plugin.get", { plugin })).versions;
const activeVersion = async (page: Page, plugin: string) => (await versions(page, plugin)).find((v) => v.active)?.version;

async function newSample(page: Page, name: string, text: string) {
  const r = await call<{ page: { resourceId: string } }>(page, "page.save", { target: `new:${SAMPLE}`, changes: { name, "body.text": text } });
  return r.page.resourceId;
}
const bodyOf = async (page: Page, id: string) => (await call<{ body: Record<string, unknown>; state: string; pluginVersion?: string }>(page, "resource.get", { id }));

/** Opens the install dialog from the plugin tree toolbar and looks inside a folder. */
async function lookInside(page: Page, folder: string) {
  await showTree(page, "Plugins");
  await page.getByRole("button", { name: "Install a plugin…" }).click();
  await page.getByRole("textbox", { name: "Folder path" }).fill(folder);
  await page.getByRole("button", { name: "Look inside" }).click();
}

test("install sample 0.2.0: the dialog lists permissions and marks the new one; confirming switches and upgrades", async ({ page }) => {
  const rid = await newSample(page, "Migrate me", "select 1");
  expect((await bodyOf(page, rid)).body.note).toBeUndefined();
  await openKernel(page, host);
  await lookInside(page, path.join(FIXTURES, "org.onedesk.sample/0.2.0"));
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("0.2.0");
  await expect(dialog).toContainText("example.com");
  await expect(dialog.getByText("New", { exact: true })).toBeVisible(); // the added permission is marked
  await shot(page, "install-dialog");
  await dialog.getByRole("button", { name: "Install", exact: true }).click();
  await expect(dialog).toHaveCount(0);

  await expect.poll(() => activeVersion(page, "org.onedesk.sample")).toBe("0.2.0");
  const r = await bodyOf(page, rid);
  expect(r.body.note).toBe("migrated from 0.1.0");
  expect(r.pluginVersion).toBe("0.2.0");
  await showTree(page, "Resources");
  await treeItem(page, "Migrate me").click();
  await expect(page.getByText("Note: migrated from 0.1.0")).toBeVisible();
  await shot(page, "upgraded-resource");
});

const openPlugin = async (page: Page, name: string) => {
  await showTree(page, "Plugins");
  await treeItem(page, pluginNode(name)).click();
};
const versionRow = (page: Page, version: string) => page.getByRole("table", { name: "Versions" }).getByRole("row").filter({ hasText: version });

test("version table: two versions, switch back to 0.1.0, undo the upgrade, and a restart does not upgrade again", async ({ page }) => {
  const rid = (await call<{ nodes: { key: string; label: string }[] }>(page, "tree.children", { tree: "resources" })).nodes.find((n) => n.label === "Migrate me")!.key;
  await openKernel(page, host);
  await openPlugin(page, "Sample");
  await expect(versionRow(page, "0.2.0")).toBeVisible();
  await expect(versionRow(page, "0.1.0")).toBeVisible();
  await shot(page, "versions");

  await versionRow(page, "0.1.0").getByRole("button", { name: "Activate" }).click();
  await expect.poll(() => activeVersion(page, "org.onedesk.sample")).toBe("0.1.0");
  expect((await bodyOf(page, rid)).pluginVersion).toBe("0.2.0"); // upgraded resources stay with the version that handles them
  await shot(page, "switched-back");

  await page.getByRole("button", { name: "Undo upgrade" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Undo upgrade" }).click();
  await expect.poll(async () => (await bodyOf(page, rid)).pluginVersion).toBe("0.1.0");
  expect((await bodyOf(page, rid)).body.note).toBeUndefined();
  await expect(page.getByRole("button", { name: "Undo upgrade" })).toHaveCount(0);
  await shot(page, "upgrade-undone");

  await stopHost(host);
  host = await startHost(dataDir);
  await openKernel(page, host);
  await new Promise((r) => setTimeout(r, 2000)); // the worker may switch versions in the background at start
  expect(await activeVersion(page, "org.onedesk.sample")).toBe("0.1.0");
  expect((await bodyOf(page, rid)).pluginVersion).toBe("0.1.0");
});

test("a broken package is refused with its reason; 0.3.0 installs but its upgrade fails and changes nothing", async ({ page }) => {
  const rid = (await call<{ nodes: { key: string; label: string }[] }>(page, "tree.children", { tree: "resources" })).nodes.find((n) => n.label === "Migrate me")!.key;
  await openKernel(page, host);
  await lookInside(page, path.join(FIXTURES, "broken"));
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("The package was refused");
  await expect(dialog.getByRole("button", { name: "Install", exact: true })).toBeDisabled();
  await shot(page, "install-refused");
  await page.keyboard.press("Escape");

  const before = { history: (await call<unknown[]>(page, "resource.history", { id: rid })).length, version: (await bodyOf(page, rid)).pluginVersion, active: await activeVersion(page, "org.onedesk.sample") };
  await lookInside(page, path.join(FIXTURES, "org.onedesk.sample/0.3.0"));
  await page.getByRole("dialog").getByRole("button", { name: "Install", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect.poll(async () => (await versions(page, "org.onedesk.sample")).map((v) => v.version).sort()).toEqual(["0.1.0", "0.2.0", "0.3.0"]);
  // the automatic switch to 0.3.0 failed (its migrate throws): nothing moved
  expect(await activeVersion(page, "org.onedesk.sample")).toBe(before.active);
  // and an explicit switch fails the same way
  await openPlugin(page, "Sample");
  await versionRow(page, "0.3.0").getByRole("button", { name: "Activate" }).click();
  await expect(page.getByText(/did not take over|No change was made|nothing was changed/i).first()).toBeVisible({ timeout: 10_000 });
  await shot(page, "upgrade-failed");
  expect(await activeVersion(page, "org.onedesk.sample")).toBe(before.active);
  expect((await bodyOf(page, rid)).pluginVersion).toBe(before.version);
  expect((await call<unknown[]>(page, "resource.history", { id: rid })).length).toBe(before.history);
  await call(page, "app.removePlugin", { plugin: "org.onedesk.sample", version: "0.3.0" });
});

test("removing a version that resources use asks first; they show as plugin missing; installing it again restores them", async ({ page }) => {
  const rid = (await call<{ nodes: { key: string; label: string }[] }>(page, "tree.children", { tree: "resources" })).nodes.find((n) => n.label === "Migrate me")!.key;
  await openKernel(page, host);
  await openPlugin(page, "Sample");
  const bound = (await bodyOf(page, rid)).pluginVersion!;
  await versionRow(page, bound).getByRole("button", { name: "Remove" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(/\d+ resource\(s\) still use it/);
  await shot(page, "remove-bound-version");
  await dialog.getByRole("button", { name: "Remove" }).click();
  await expect.poll(async () => (await bodyOf(page, rid)).state).toBe("missing-plugin");
  await showTree(page, "Resources");
  await expect(page.locator("[data-tree-key]", { hasText: "Migrate me" }).first()).toHaveAttribute("data-state", "missing-plugin");
  await page.locator("[data-tree-key]", { hasText: "Migrate me" }).first().click();
  await expect(page.getByText(/not installed/i).first()).toBeVisible();
  await shot(page, "plugin-missing");

  // install the removed version again from the built-in package folder
  await lookInside(page, path.join(ROOT, "plugins/org.onedesk.sample"));
  await page.getByRole("dialog").getByRole("button", { name: "Install", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect.poll(async () => (await bodyOf(page, rid)).state).toBe("ok");
});

test("a package copied into the plugin folder by hand is listed as not confirmed and cannot be used", async ({ page }) => {
  const dest = path.join(dataDir, "plugins/org.onedesk.sample/0.5.0");
  cpSync(path.join(FIXTURES, "org.onedesk.sample/0.2.0"), dest, { recursive: true });
  const mf = JSON.parse(readFileSync(path.join(dest, "manifest.json"), "utf8"));
  mf.version = "0.5.0";
  mf.requires.network = { hosts: ["example.com", "extra.example.org"] }; // one more permission than anything confirmed, so it needs a decision
  (await import("node:fs")).writeFileSync(path.join(dest, "manifest.json"), JSON.stringify(mf, null, 2));
  await openKernel(page, host);
  await call(page, "plugin.rescan", { builtin: [] });
  const v = (await versions(page, "org.onedesk.sample")).find((x) => x.version === "0.5.0")!;
  expect(v.confirmed).toBe(false);
  await expect(call(page, "plugin.activateVersion", { plugin: "org.onedesk.sample", version: "0.5.0" })).rejects.toThrow();
  expect(await activeVersion(page, "org.onedesk.sample")).not.toBe("0.5.0");
  await openPlugin(page, "Sample");
  await expect(versionRow(page, "0.5.0")).toContainText("Not confirmed");
  await shot(page, "unconfirmed-version");
  await call(page, "app.removePlugin", { plugin: "org.onedesk.sample", version: "0.5.0" });
});

const TOKEN1 = "tok-first-value-8f3a1c";
const TOKEN2 = "tok-second-value-5d7e9b";

async function openSecrets(page: Page) {
  await page.keyboard.press("ControlOrMeta+Shift+p");
  await page.getByPlaceholder("Type a command").fill("Secrets");
  await page.getByRole("option", { name: /Secrets/ }).first().click();
  await expect(page.getByRole("heading", { name: "Secrets" }).first()).toBeVisible();
}

test("secrets page: add, change and delete; the value is never shown", async ({ page }) => {
  await openKernel(page, host);
  await openSecrets(page);
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("api-token");
  await page.getByLabel("Value").fill(TOKEN1);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("api-token", { exact: true }).first()).toBeVisible();
  expect(await page.content()).not.toContain(TOKEN1);
  expect(await page.locator("input").evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value))).not.toContain(TOKEN1); // the box was cleared
  await shot(page, "secrets");

  await page.getByRole("textbox", { name: "Name", exact: true }).fill("temp-secret");
  await page.getByLabel("Value").fill("temp-value-123");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("temp-secret", { exact: true }).first()).toBeVisible();

  // change the value of api-token (the dialog does not show the old one)
  await page.getByRole("row").filter({ hasText: "api-token" }).getByRole("button", { name: "Change value" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("New value for");
  expect(await dialog.innerHTML()).not.toContain(TOKEN1);
  await dialog.getByLabel("Value").fill(TOKEN2);
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  expect(await page.content()).not.toContain(TOKEN2);

  // delete the temporary one (with a confirmation)
  await page.getByRole("row").filter({ hasText: "temp-secret" }).getByRole("button", { name: "Delete" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
  await expect(page.getByText("temp-secret", { exact: true })).toHaveCount(0);
  const names = (await call<{ name: string }[]>(page, "secrets.list")).map((x) => x.name);
  expect(names).toContain("api-token");
  expect(names).not.toContain("temp-secret");
  expect(JSON.stringify(await call(page, "secrets.list"))).not.toContain(TOKEN2);
});

/** Every file under the data directory (database, WAL, backups…) that contains `needle`. */
function filesContaining(needle: string): string[] {
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.size < 200 * 1024 * 1024 && readFileSync(p).includes(needle)) hits.push(p);
    }
  };
  walk(dataDir);
  return hits;
}

const urlA = (p = "/ok") => `http://127.0.0.1:${portA}${p}`;
async function newRequest(page: Page, name: string, url: string, headers = "") {
  const r = await call<{ page: { resourceId: string } }>(page, "page.save", {
    target: `new:${HTTP}`,
    changes: { name, "body.method": "GET", "body.url": url, "body.headers": headers, "body.body": "" },
  });
  return r.page.resourceId;
}
async function openRequest(page: Page, name: string) {
  await showTree(page, "Resources");
  await treeItem(page, name).click();
  await expect(page.getByRole("textbox", { name: "Address", exact: true })).toBeVisible();
}
const send = (page: Page) => page.getByRole("button", { name: "Send", exact: true });
const statusBar = (page: Page) => page.getByRole("status");

test("HTTP request: status, time and body; the secret reaches the server but nowhere else", async ({ page }) => {
  seen.length = 0;
  const rid = await newRequest(page, "Ping", urlA("/ok"), "X-Plain: yes\nAuthorization: Bearer {{secret:api-token}}");
  await openKernel(page, host);
  await openRequest(page, "Ping");
  await send(page).click();
  await expect(page.getByRole("region", { name: "Result area" })).toContainText("hello from server A", { timeout: 15_000 });
  await expect(statusBar(page).getByText(/#\d+ · 200 OK · \d+ ms · \d+ bytes/)).toBeVisible();
  await shot(page, "http-response");

  // the server saw the real value, and the plain header
  const got = seen.filter((x) => x.url === "A/ok").at(-1)!;
  expect(got.headers.authorization).toBe(`Bearer ${TOKEN2}`);
  expect(got.headers["x-plain"]).toBe("yes");

  // the response headers tab
  await page.getByRole("tab", { name: "Response headers" }).click();
  await expect(page.getByRole("table").filter({ hasText: "x-test" })).toBeVisible();
  await shot(page, "http-response-headers");

  // nowhere else: the page, the run in the kernel, the database files
  expect(await page.content()).not.toContain(TOKEN2);
  const runs = await call<{ id: string }[]>(page, "run.tasks");
  for (const r of runs) expect(JSON.stringify(await call(page, "run.get", { id: r.id }))).not.toContain(TOKEN2);
  expect(JSON.stringify(await call(page, "resource.get", { id: rid }))).not.toContain(TOKEN2);
  expect(JSON.stringify(await call(page, "audit.list", {}))).not.toContain(TOKEN2);
  expect(filesContaining(TOKEN2)).toEqual([]);
  expect(filesContaining(TOKEN1)).toEqual([]);
});

test("HTTP request: a non-2xx answer is a successful run with the status in the summary", async ({ page }) => {
  await newRequest(page, "Missing", urlA("/missing"));
  await openKernel(page, host);
  await openRequest(page, "Missing");
  await send(page).click();
  await expect(page.getByRole("region", { name: "Result area" })).toContainText("no such thing", { timeout: 15_000 });
  await expect(statusBar(page).getByText(/ 404 Not Found · /)).toBeVisible();
});

test("HTTP request: another host than the saved address is refused and the server sees nothing", async ({ page }) => {
  await newRequest(page, "Elsewhere", urlA("/ok"));
  await openKernel(page, host);
  await openRequest(page, "Elsewhere");
  seen.length = 0;
  // an unsaved change of the address to a host nobody authorized: "localhost" is not "127.0.0.1"
  await page.getByRole("textbox", { name: "Address", exact: true }).fill(`http://localhost:${portA}/ok`);
  await send(page).click();
  await expect(page.getByRole("region", { name: "Result area" })).toContainText(/denied/i, { timeout: 15_000 });
  await shot(page, "http-denied");
  expect(seen).toEqual([]);
});

test("HTTP request: a redirect to another port is refused (D317); the second server sees nothing", async ({ page }) => {
  // The saved address grants 127.0.0.1:<portA> only. Server A redirects to server B on another port:
  // every hop is checked again, so the run is denied and B never sees the request (nor the secret).
  // (D316 — dropping secret headers on a redirect to an *allowed* other host — is covered by kernel tests:
  // with fromResources a resource grants exactly one host:port, so the UI cannot reach that case.)
  seen.length = 0;
  await newRequest(page, "Redirected", urlA("/redirect"), "X-Plain: yes\nAuthorization: Bearer {{secret:api-token}}");
  await openKernel(page, host);
  await openRequest(page, "Redirected");
  await send(page).click();
  await expect(page.getByRole("region", { name: "Result area" })).toContainText(/denied/i, { timeout: 15_000 });
  expect(seen.find((x) => x.url === "A/redirect")!.headers.authorization).toBe(`Bearer ${TOKEN2}`);
  expect(seen.find((x) => x.url.startsWith("B/"))).toBeUndefined();
  const denied = (await call<{ operation: string; result: string; detail: string }[]>(page, "audit.list", {})).find((x) => x.operation === "network.request" && x.result === "denied")!;
  expect(denied.detail).toContain("hostNotAllowed");
});

test("HTTP request: the same host on another port is refused (D317), and a secret name written only in the draft is refused (D318)", async ({ page }) => {
  await newRequest(page, "Strict", urlA("/ok"), "Authorization: Bearer {{secret:api-token}}");
  await openKernel(page, host);
  await call(page, "secrets.set", { name: "draft-only", value: "draft-only-value-91c2" });
  try {
    await openRequest(page, "Strict");
    seen.length = 0;
    // unsaved: same host, the other server's port
    await page.getByRole("textbox", { name: "Address", exact: true }).fill(`http://127.0.0.1:${portB}/landing`);
    await send(page).click();
    await expect(page.getByRole("region", { name: "Result area" })).toContainText(/denied/i, { timeout: 15_000 });
    expect(seen).toEqual([]);
    let last = (await call<{ operation: string; result: string; detail: string }[]>(page, "audit.list", {})).find((x) => x.operation === "network.request")!;
    expect(last.detail).toContain("hostNotAllowed");
    // unsaved: back to the granted address, but a secret name the saved resource never mentioned
    await page.getByRole("textbox", { name: "Address", exact: true }).fill(urlA("/ok"));
    await page.getByRole("textbox", { name: "Headers", exact: true }).fill("Authorization: Bearer {{secret:draft-only}}");
    await send(page).click();
    await expect.poll(async () => (await call<{ operation: string; result: string; detail: string }[]>(page, "audit.list", {})).find((x) => x.operation === "network.request")!.detail, { timeout: 15_000 }).toContain("secretNotAllowed");
    expect(seen).toEqual([]);
  } finally {
    await call(page, "secrets.delete", { name: "draft-only" });
  }
});

test("network.allow in the workspace configuration narrows the allowed hosts; the environment page marks what the upper layer forbids", async ({ page }) => {
  await newRequest(page, "Narrowed", urlA("/ok"));
  await openKernel(page, host);
  const cfg = (await call<{ nodes: { key: string; label: string }[] }>(page, "tree.children", { tree: "config" })).nodes.find((n) => n.label === "Workspace")!.key;
  const env = (await call<{ nodes: { key: string; label: string }[] }>(page, "tree.children", { tree: "env" })).nodes.find((n) => n.label === "Default")!.key;
  await call(page, "params.set", { node: cfg, name: "network.allow", value: "example.com" });
  await call(page, "params.set", { node: env, name: "network.allow", value: "127.0.0.1" });
  try {
    await openRequest(page, "Narrowed");
    seen.length = 0;
    await send(page).click();
    await expect(page.getByRole("region", { name: "Result area" })).toContainText(/denied/i, { timeout: 15_000 });
    expect(seen).toEqual([]);

    await showTree(page, "Environments");
    await treeItem(page, "Default").click();
    await expect(page.getByText("Not in effect").first()).toBeVisible(); // restricted by the upper layer
    await shot(page, "env-restricted");
  } finally {
    await call(page, "params.unset", { node: env, name: "network.allow" });
    await call(page, "params.unset", { node: cfg, name: "network.allow" });
  }
  // and it works again once the restriction is gone
  await openRequest(page, "Narrowed");
  await send(page).click();
  await expect(page.getByRole("region", { name: "Result area" })).toContainText("hello from server A", { timeout: 15_000 });
});

test("a secret typed into an unsaved new request page and sent straight away never reaches the database files", async ({ page }) => {
  const LEAK = "leak-check-value-4b2c7d9e";
  await openKernel(page, host);
  await page.getByRole("button", { name: "New", exact: true }).first().click();
  await page.getByRole("menuitem", { name: "HTTP request" }).click();
  await page.getByRole("textbox", { name: "Address", exact: true }).fill(urlA("/ok"));
  await page.getByLabel("Token (secret)").fill(LEAK);
  await send(page).click();
  await expect(statusBar(page).getByText(/#\d+/).first()).toBeVisible({ timeout: 15_000 });
  await shot(page, "http-unsaved-secret");
  // (the password box still holds what was typed: that is the user's own draft, not a leak)
  for (const r of await call<{ id: string }[]>(page, "run.tasks")) expect(JSON.stringify(await call(page, "run.get", { id: r.id }))).not.toContain(LEAK);
  // let the kernel finish writing, then look at the files themselves
  await new Promise((r) => setTimeout(r, 1000));
  expect(filesContaining(LEAK)).toEqual([]);
});
