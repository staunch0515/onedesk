/**
 * Round 13 against the REAL kernel: several workspaces (create copies settings but no data, switch, rename, delete into
 * trash, in-use / pending refusals) and several connections (two clients on different workspaces do not affect each other,
 * a workspace's worker stops with its last connection, `app.workspacesChanged` reaches the others).
 * devhost always runs with ONEDESK_SECRET_STORE=memory and a temp data directory (kernel-host.ts): the real keychain and
 * ~/Library/Application Support/onedesk* are never touched. First-version database upgrade was dropped (D403).
 * Protocol parts use Node's WebSocket directly (one persistent connection per `client`); UI parts use the page.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { DEVHOST, OUT, openKernel, startHost, stopHost, type Host } from "./kernel-host";

test.use({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
test.describe.configure({ mode: "serial" });
test.setTimeout(120_000);

const NOTE = "org.onedesk.note:note";
const JA = "org.onedesk.lang.ja-jp";

let host: Host;
let base: string;

test.beforeAll(async () => {
  test.skip(!existsSync(DEVHOST), `onedesk-devhost not built at ${DEVHOST}`);
  base = realpathSync(mkdtempSync(path.join(tmpdir(), "od-round13-")));
  host = await startHost(path.join(base, "data"));
});
test.afterAll(async () => {
  for (const c of open) c.close();
  if (host) await stopHost(host);
  if (base) rmSync(base, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ protocol connections */

type Entry = { id: string; name: string; folder: string; lastOpened?: number; current: boolean };
type Msg = { id?: number; result?: unknown; error?: { code: string; params?: Record<string, unknown> }; topic?: string };
class RpcError extends Error {
  constructor(
    public code: string,
    public params: Record<string, unknown> = {},
  ) {
    super(`${code} ${JSON.stringify(params)}`);
  }
}
const open: Conn[] = [];

class Conn {
  private ws!: WebSocket;
  private next = 1;
  private waiting = new Map<number, { ok: (v: unknown) => void; fail: (e: Error) => void }>();
  events: Msg[] = [];

  static async connect(client: string, workspace?: string): Promise<Conn> {
    const c = new Conn();
    const q = `token=${host.token}&client=${client}${workspace ? `&workspace=${workspace}` : ""}`;
    c.ws = new WebSocket(`ws://127.0.0.1:${host.port}/?${q}`);
    await new Promise<void>((resolve, reject) => {
      c.ws.onopen = () => resolve();
      c.ws.onerror = () => reject(new Error("ws error"));
    });
    c.ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data)) as Msg;
      if (m.id === undefined) return void c.events.push(m);
      const w = c.waiting.get(m.id);
      c.waiting.delete(m.id);
      if (!w) return;
      if (m.error) w.fail(new RpcError(m.error.code, m.error.params));
      else w.ok(m.result);
    };
    open.push(c);
    await c.call("hello", { protocol: "1" });
    return c;
  }
  call<T = unknown>(method: string, params: unknown = null): Promise<T> {
    const id = this.next++;
    return new Promise<T>((ok, fail) => {
      this.waiting.set(id, { ok: ok as (v: unknown) => void, fail });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async refused(method: string, params: unknown = null): Promise<RpcError> {
    try {
      await this.call(method, params);
    } catch (e) {
      if (e instanceof RpcError) return e;
      throw e;
    }
    throw new Error(`${method} was not refused`);
  }
  changed() {
    return this.events.filter((e) => e.topic === "app.workspacesChanged").length;
  }
  close() {
    this.ws.close();
  }
  async closeAndWait() {
    this.ws.close();
    await new Promise((r) => setTimeout(r, 300));
  }
}

const list = async (c: Conn) => (await c.call<{ items: Entry[] }>("app.workspaces")).items;
const byName = async (c: Conn, name: string) => (await list(c)).find((w) => w.name === name);
const info = (c: Conn) => c.call<{ id: string; name: string }>("workspace.info");
type Node = { key: string; label: string };
const nodes = async (c: Conn, tree: string) => (await c.call<{ nodes: Node[] }>("tree.children", { tree, locale: "en-US" })).nodes;
const until = async (fn: () => boolean | Promise<boolean>, what: string, ms = 10_000) => {
  const t0 = Date.now();
  while (!(await fn())) {
    if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
};
/** Worker processes of THIS devhost (their command line carries this test's temp data directory). */
const workers = () => {
  try {
    const out = execFileSync("ps", ["-axo", "args"], { encoding: "utf8" });
    return out.split("\n").filter((l) => l.includes("onedesk-worker") && l.includes(host.dataDir)).length;
  } catch {
    return -1;
  }
};

let main: Conn; // the default workspace's connection
let mainWs: Entry;
let second: Entry;

test("a fresh data directory has one workspace, in use by the connection", async () => {
  main = await Connection();
  const items = await list(main);
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ current: true });
  mainWs = items[0]!;
  expect((await info(main)).id).toBe(mainWs.id);
});
async function Connection() {
  return Conn.connect("e2e-main");
}

test("create: copies config and plugin enablement, not data; does not switch; names are checked", async () => {
  // Set the source up: a note (data), a renamed config root, a disabled plugin.
  const saved = await main.call<{ page: { resourceId: string } }>("page.save", { target: `new:${NOTE}`, changes: { name: "Only in main", "body.text": "secret data" } });
  expect(saved.page.resourceId).toBeTruthy();
  const root = (await nodes(main, "config"))[0]!;
  await main.call("tree.rename", { tree: "config", key: root.key, name: "Shared settings" });
  await main.call("plugin.setEnabled", { plugin: JA, enabled: false });

  const before = main.changed();
  second = await main.call<Entry>("app.createWorkspace", { name: "Second space" });
  expect(second).toMatchObject({ name: "Second space", current: false });
  expect(second.id).not.toBe(mainWs.id);
  expect(second.folder).toBeTruthy();
  expect((await info(main)).id).toBe(mainWs.id); // not switched
  await until(() => main.changed() > before, "workspacesChanged after create");

  // Invalid names.
  for (const bad of ["", "   ", "x".repeat(101)]) expect((await main.refused("app.createWorkspace", { name: bad })).code, JSON.stringify(bad)).toBe("invalidParams");
  expect((await list(main)).map((w) => w.name).sort()).toEqual([mainWs.name, "Second space"].sort());
  // Folder names are made unique.
  const twin = await main.call<Entry>("app.createWorkspace", { name: "Second space" });
  expect(twin.folder).not.toBe(second.folder);
  expect(await list(main).then((l) => l.length)).toBe(3);
  await main.call("app.deleteWorkspace", { id: twin.id });

  // The new workspace has the settings but none of the data.
  const b = await Conn.connect("e2e-b-copy", second.id);
  expect((await info(b)).id).toBe(second.id);
  expect((await info(b)).name).toBe("Second space");
  expect((await nodes(b, "config")).map((n) => n.label)).toContain("Shared settings");
  expect((await b.call<{ enabled: boolean }>("plugin.get", { plugin: JA })).enabled).toBe(false);
  expect((await nodes(b, "resources")).map((n) => n.label)).not.toContain("Only in main");
  expect((await nodes(main, "resources")).map((n) => n.label)).toContain("Only in main");
  await b.closeAndWait();
});

test("two connections on different workspaces do not affect each other", async () => {
  const a = await Conn.connect("e2e-a", mainWs.id);
  const b = await Conn.connect("e2e-b", second.id);
  expect((await info(a)).id).toBe(mainWs.id);
  expect((await info(b)).id).toBe(second.id);
  expect((await list(a)).find((w) => w.current)!.id).toBe(mainWs.id);
  expect((await list(b)).find((w) => w.current)!.id).toBe(second.id);

  await b.call("page.save", { target: `new:${NOTE}`, changes: { name: "Only in second", "body.text": "other" } });
  expect((await nodes(b, "resources")).map((n) => n.label)).toContain("Only in second");
  expect((await nodes(a, "resources")).map((n) => n.label)).not.toContain("Only in second");
  expect((await nodes(a, "resources")).map((n) => n.label)).toContain("Only in main");
  // Workspace-scoped events stay in their workspace: `a` saw nothing about b's save.
  expect(a.events.filter((e) => e.topic !== "app.workspacesChanged")).toEqual(expect.not.arrayContaining([expect.objectContaining({ topic: "tree.changed", payload: expect.objectContaining({ tree: "resources", key: "Only in second" }) })]));
  // Two workers are running.
  await until(() => workers() === 2 || workers() === -1, "two workers");
  b.close();
  a.close();
});

test("the worker of a workspace stops with its last connection", async () => {
  test.skip(workers() === -1, "ps not available");
  await until(() => workers() <= 1, "second worker gone after its connections closed");
  expect(workers()).toBe(1); // main (still bound by e2e-main)
  const b = await Conn.connect("e2e-b2", second.id);
  await until(() => workers() === 2, "second worker started again");
  const b2 = await Conn.connect("e2e-b3", second.id);
  b.close();
  await new Promise((r) => setTimeout(r, 1500));
  expect(workers()).toBe(2); // another connection still uses it
  b2.close();
  await until(() => workers() === 1, "stopped after the last connection");
});

test("switch: the connection moves to the other workspace and sees different content; the default follows", async () => {
  const c = await Conn.connect("e2e-switch"); // unbound: the default workspace
  const first = await info(c);
  const moved = await c.call<Entry>("app.switchWorkspace", { id: second.id });
  expect(moved).toMatchObject({ id: second.id, current: true });
  expect((await info(c)).id).toBe(second.id);
  expect((await nodes(c, "resources")).map((n) => n.label)).toEqual(expect.arrayContaining(["Only in second"]));
  expect((await nodes(c, "resources")).map((n) => n.label)).not.toContain("Only in main");
  const entries = await list(c);
  expect(entries.find((w) => w.id === second.id)!.lastOpened).toBeGreaterThan(0);
  expect(entries[0]!.id).toBe(second.id); // most recently opened first
  expect((await c.refused("app.switchWorkspace", { id: "nope" })).code).toBe("notFound");
  await c.call("app.switchWorkspace", { id: first.id });
  expect((await info(c)).id).toBe(first.id);
  expect((await nodes(c, "resources")).map((n) => n.label)).toContain("Only in main");
  await c.closeAndWait();
});

test("D406: a connection without workspace= is not carried along when another connection switches", async () => {
  const a = await Conn.connect("e2e-d406-a"); // unbound: bound to the default at its first appearance
  const home = (await info(a)).id;
  const b = await Conn.connect("e2e-d406-b");
  expect((await info(b)).id).toBe(home);
  await b.call("app.switchWorkspace", { id: second.id });
  expect((await info(b)).id).toBe(second.id);
  expect((await info(a)).id).toBe(home); // a stays
  expect((await list(a)).find((w) => w.current)!.id).toBe(home);
  // The default only decides where NEW connections bind; it does not count as "in use" for deleting.
  const c = await Conn.connect("e2e-d406-c");
  expect((await info(c)).id).toBe(second.id);
  c.close();
  b.close();
  a.close();
  await new Promise((r) => setTimeout(r, 500));
});

test("rename: new name in the list, event to the other connections, bad names refused", async () => {
  const watcher = await Conn.connect("e2e-watch", mainWs.id);
  const n = watcher.changed();
  expect(await main.call("app.renameWorkspace", { id: second.id, name: "  Renamed space  " })).toBeNull();
  expect((await byName(main, "Renamed space"))!.id).toBe(second.id);
  expect(await byName(main, "Second space")).toBeUndefined();
  await until(() => watcher.changed() > n, "workspacesChanged reaches the other connection");
  for (const bad of ["", "y".repeat(101)]) expect((await main.refused("app.renameWorkspace", { id: second.id, name: bad })).code).toBe("invalidParams");
  expect((await main.refused("app.renameWorkspace", { id: "nope", name: "x" })).code).toBe("notFound");
  second = { ...second, name: "Renamed space" };
  watcher.close();
});

test("delete: refused while used by any connection; then moved to trash and gone from the list", async () => {
  const user = await Conn.connect("e2e-user", second.id);
  const inUse = await main.refused("app.deleteWorkspace", { id: second.id });
  expect(inUse.code).toBe("conflict");
  expect(inUse.params.reason).toBe("inUse");
  // The workspace of the asking connection itself.
  const own = await main.refused("app.deleteWorkspace", { id: mainWs.id });
  expect(own).toMatchObject({ code: "conflict" });
  expect(own.params.reason).toBe("inUse");
  await user.closeAndWait();
  await until(async () => {
    try {
      const before = main.changed();
      await main.call("app.deleteWorkspace", { id: second.id });
      await until(() => main.changed() > before, "workspacesChanged after delete");
      return true;
    } catch (e) {
      if (e instanceof RpcError && e.code === "conflict") return false; // the worker is still shutting down
      throw e;
    }
  }, "delete after the last connection left");
  expect((await list(main)).map((w) => w.id)).toEqual([mainWs.id]);
  const trash = path.join(host.dataDir, "trash", "workspaces");
  const moved = readdirSync(trash);
  expect(moved).toHaveLength(2); // the twin made above and this one
  expect(moved.some((d) => d.startsWith(second.folder))).toBe(true);
  expect(existsSync(path.join(host.dataDir, "workspaces", second.folder))).toBe(false);
  expect((await main.refused("app.deleteWorkspace", { id: second.id })).code).toBe("notFound");
});

test("a workspace folder without workspace.json is listed as pending: it can be opened but not renamed or deleted", async () => {
  const dir = path.join(host.dataDir, "workspaces", "handmade");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "workspace.db"), "");
  const entry = (await list(main)).find((w) => w.folder === "handmade");
  expect(entry?.id).toMatch(/^pending:/);
  expect((await main.refused("app.renameWorkspace", { id: entry!.id, name: "x" })).params.reason).toBe("idPending");
  expect((await main.refused("app.deleteWorkspace", { id: entry!.id })).params.reason).toBe("idPending");
  rmSync(dir, { recursive: true, force: true });
});

test("workspace.settingsSnapshot is for the main process only", async () => {
  const e = await main.refused("workspace.settingsSnapshot");
  expect(e.code).toBe("denied");
  expect(e.params.reason).toBe("mainProcessOnly");
});

/* ------------------------------------------------------------------ the interface */

const shot = async (page: Page, name: string) => {
  await page.mouse.move(640, 2);
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, `round13-${name}.png`) });
};
// The menu trigger is a button named after the workspace in use.
const menu = (page: Page, current: string) => page.getByRole("button", { name: current, exact: true });

test("UI: the workspace menu creates, renames, switches and deletes; a second page on another workspace is unaffected", async ({ page, context }) => {
  const h: Host = host;
  await openKernel(page, h);
  await expect(page.getByText(mainWs.name).first()).toBeVisible();

  // Create through the dialog (menu → New workspace…).
  await menu(page, mainWs.name).click();
  await page.getByRole("menuitem", { name: "New workspace…" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("textbox", { name: "Name" }).fill("UI space");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(dialog).toBeHidden();
  await until(async () => !!(await byName(main, "UI space")), "UI space listed");

  // Switch: the page reloads onto the other workspace.
  await menu(page, mainWs.name).click();
  await page.getByRole("menuitem", { name: "UI space" }).click();
  await expect(page.getByText("UI space").first()).toBeVisible();
  await shot(page, "switched");

  // A second page pinned to the default workspace shows the original name; the first stays on "UI space".
  const other = await context.newPage();
  await other.goto(`/workbench.html?quiet&theme=light&kernel=${encodeURIComponent(`ws://127.0.0.1:${h.port}`)}&token=${h.token}&workspace=${mainWs.id}`);
  await expect(other.getByText(mainWs.name).first()).toBeVisible();
  await expect(page.getByText("UI space").first()).toBeVisible();
  await other.close();

  // Rename and delete through the manage dialog; the open workspace cannot be deleted from there.
  await menu(page, "UI space").click();
  await page.getByRole("menuitem", { name: "Manage workspaces…" }).click();
  const manage = page.getByRole("dialog");
  await expect(manage.getByRole("button", { name: /^Delete UI space/ })).toBeDisabled();
  await shot(page, "manage");
  await page.keyboard.press("Escape");

  // Back on the default workspace, delete "UI space" with the confirmation.
  await menu(page, "UI space").click();
  await page.getByRole("menuitem", { name: mainWs.name }).click();
  await expect(page.getByText(mainWs.name).first()).toBeVisible();
  await menu(page, mainWs.name).click();
  await page.getByRole("menuitem", { name: "Manage workspaces…" }).click();
  await page.getByRole("button", { name: "Rename UI space" }).click();
  const rename = page.getByRole("dialog").last();
  await rename.getByRole("textbox", { name: "Name" }).fill("UI space 2");
  await rename.getByRole("button", { name: "Rename", exact: true }).click();
  await expect(page.getByText("UI space 2").first()).toBeVisible();
  await page.getByRole("button", { name: "Delete UI space 2" }).click();
  const confirm = page.getByRole("dialog").last();
  await expect(confirm).toContainText("trash");
  await confirm.getByRole("button", { name: "Delete", exact: true }).click();
  await until(async () => !(await byName(main, "UI space 2")), "deleted through the UI");
});

test("UI: \"Open in a new window\" in a browser opens a new tab bound to that workspace", async ({ page, context }) => {
  await openKernel(page, host);
  await menu(page, mainWs.name).click();
  await page.getByRole("menuitem", { name: "Manage workspaces…" }).click();
  const manage = page.getByRole("dialog");
  const popup = context.waitForEvent("page");
  await manage.getByRole("button", { name: /^Open .* in a new window/ }).first().click();
  const tab = await popup;
  await tab.waitForLoadState();
  expect(new URL(tab.url()).searchParams.get("workspace")).toBeTruthy();
  await tab.close();
});
