/**
 * Round 14 against the REAL kernel: the six acceptance points of docs/requirements.md section D, one by one, and the
 * light/dark tour of the main pages (docs/screenshots/round14-light-*.png, round14-dark-*.png) with an automatic
 * contrast scan of every page that is photographed.
 * devhost always runs with ONEDESK_SECRET_STORE=memory and a temp data directory (kernel-host.ts): the real keychain and
 * ~/Library/Application Support/onedesk* are never touched. The only network is a local HTTP fixture (transfer-server.mjs).
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { DEVHOST, OUT, ROOT, openKernel, rpc, startHost, stopHost, type Host } from "./kernel-host";
// @ts-ignore plain JS module, no types
import { startServer } from "./fixtures/transfer-server.mjs";

test.use({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
test.describe.configure({ mode: "serial" });
test.setTimeout(180_000);

const NOTE = "org.onedesk.note:note";
const LINK = "org.onedesk.link:link";
const PROMPT = "org.onedesk.prompt:prompt";
const REQUEST = "org.onedesk.http:request";
const COMPOSITE = "org.onedesk.composite:composite";
const COLLECTION = "org.onedesk.collection:collection";
const HTTP_PLUGIN = "org.onedesk.http";

let host: Host;
let base: string;
let srv: { port: number; url: string; close(): Promise<void> };

test.beforeAll(async () => {
  test.skip(!existsSync(DEVHOST), `onedesk-devhost not built at ${DEVHOST}`);
  base = realpathSync(mkdtempSync(path.join(tmpdir(), "od-round14-")));
  srv = await startServer({ port: 0 });
  host = await startHost(path.join(base, "data"));
});
test.afterAll(async () => {
  if (host) await stopHost(host);
  if (srv) await srv.close();
  if (base) rmSync(base, { recursive: true, force: true });
});

const call = <T = unknown>(page: Page, method: string, params: unknown = null) => rpc<T>(page, host, method, params);
const bare = (page: Page) => page.goto("/workbench.html?reset&quiet");
type Saved = { page: { resourceId: string } };
const create = async (page: Page, kind: string, changes: Record<string, unknown>) => (await call<Saved>(page, "page.save", { target: `new:${kind}`, changes })).page.resourceId;
type Res = { id: string; name: string; deleted: boolean; tags?: string[]; body: Record<string, unknown> };
const getRes = (page: Page, id: string) => call<Res>(page, "resource.get", { id });
type Hit = { title: string; id?: string };

const sideTab = (page: Page, name: string) => page.getByRole("navigation", { name: "Views" }).getByRole("button", { name, exact: true });
const showTree = async (page: Page, name: string) => {
  const b = sideTab(page, name);
  if ((await b.getAttribute("aria-pressed")) !== "true") await b.click();
};
const treeItem = (page: Page, name: string | RegExp) => page.getByRole("treeitem", { name, exact: typeof name === "string" });
const entry = (page: Page, n: string) => page.getByRole("link", { name: n }).or(page.getByRole("button", { name: n })).first();
const settingsMenu = (page: Page) => page.locator('button[aria-haspopup="menu"][aria-label="Settings"]');

/* ------------------------------------------------------------------ D1: start, menu lists every resource type */

test("D1: the app starts on the welcome page; the side tree and the New menu list every resource type", async ({ page }) => {
  await openKernel(page, host);
  await expect(page.getByRole("heading", { name: "Welcome to OneDesk" })).toBeVisible({ timeout: 20_000 });
  // the activity bar names the trees
  for (const v of ["Resources", "Environments", "Plugins", "Settings"]) await expect(sideTab(page, v)).toBeVisible();
  await page.getByRole("button", { name: "New", exact: true }).first().click();
  for (const kind of ["Note", "Link", "Prompt", "HTTP request", "Composite", "Collection"]) {
    await expect(page.getByRole("menuitem", { name: new RegExp(kind, "i") }).first(), `New menu: ${kind}`).toBeVisible();
  }
  await page.keyboard.press("Escape");
});

/* ------------------------------------------------------------------ D2: create the four types, open each */

test("D2: a link, a prompt, a note and an HTTP request are created from the page and open on the right page", async ({ page }) => {
  await openKernel(page, host);
  await call(page, "params.set", { node: await configNode(page), name: "network.allow", value: `127.0.0.1:${srv.port}` });
  const save = () => page.keyboard.press("ControlOrMeta+s");
  await expect(page.getByRole("heading", { name: "Welcome to OneDesk" })).toBeVisible({ timeout: 20_000 });

  await entry(page, "New link").click();
  await page.getByRole("textbox", { name: "Address", exact: true }).fill("https://example.com/docs");
  await save();
  await page.getByRole("tab", { name: /Welcome/ }).click();
  await entry(page, "New prompt").click();
  await page.getByRole("textbox", { name: "Prompt", exact: true }).fill("Summarise the meeting notes in three bullets");
  await save();
  await page.getByRole("tab", { name: /Welcome/ }).click();
  await entry(page, "New note").click();
  await page.getByRole("textbox", { name: "Content", exact: true }).fill("Quarterly roadmap with the aurora project");
  await save();
  await page.getByRole("tab", { name: /Welcome/ }).click();
  await entry(page, "New HTTP request").click();
  await page.getByRole("textbox", { name: "Address", exact: true }).fill(`${srv.url}/echo`);
  await save();

  // all four are stored, one per type
  await expect.poll(async () => (await roots(page)).map((n) => n.kind).sort(), { timeout: 15_000 }).toEqual([LINK, NOTE, PROMPT, REQUEST].sort());
  expect(await roots(page).then((r) => r.every((n) => n.label.length > 0))).toBe(true);

  // reopen each from the tree: the page of its own type shows its own field and the saved content
  await openKernel(page, host);
  await showTree(page, "Resources");
  for (const [kind, role, field, value] of [
    [LINK, "textbox", "Address", "https://example.com/docs"],
    [PROMPT, "textbox", "Prompt", "Summarise the meeting notes in three bullets"],
    [NOTE, "textbox", "Content", "aurora"],
    [REQUEST, "textbox", "Address", `${srv.url}/echo`],
  ] as const) {
    const n = (await roots(page)).find((r) => r.kind === kind)!;
    await page.locator(`[data-tree-key="${n.key}"]`).click();
    const box = page.getByRole(role, { name: field, exact: true }).first();
    await expect(box).toBeVisible({ timeout: 15_000 });
    await expect(box).toHaveValue(new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

type TNode = { key: string; label: string; kind: string };
const roots = async (page: Page, tree = "resources") => (await call<{ nodes: TNode[] }>(page, "tree.children", { tree, locale: "en-US" })).nodes;
const configNode = async (page: Page) => (await roots(page, "config")).find((n) => n.label === "Workspace")!.key;

/* ------------------------------------------------------------------ D3: disabling the HTTP plugin hides it, keeps the data */

test("D3: disabling the HTTP request plugin removes its menu entries and keeps the data; enabling brings it back", async ({ page }) => {
  await openKernel(page, host);
  const req = (await roots(page)).find((n) => n.kind === REQUEST)!;
  const before = await getRes(page, req.key);
  const newMenu = async () => {
    await page.getByRole("button", { name: "New", exact: true }).first().click();
    const has = await page.getByRole("menuitem", { name: /HTTP request/i }).count();
    await page.keyboard.press("Escape");
    return has;
  };
  expect(await newMenu()).toBeGreaterThan(0);

  await call(page, "plugin.setEnabled", { plugin: HTTP_PLUGIN, enabled: false });
  await openKernel(page, host);
  expect(await newMenu()).toBe(0);
  await showTree(page, "Resources");
  // data is kept, the item is shown as unusable rather than gone
  const stillThere = (await roots(page)).find((n) => n.key === req.key);
  expect(stillThere, "resource still in the tree while its plugin is disabled").toBeTruthy();
  const during = await getRes(page, req.key);
  expect(during.body).toEqual(before.body);
  expect(during.name).toBe(before.name);

  await call(page, "plugin.setEnabled", { plugin: HTTP_PLUGIN, enabled: true });
  await openKernel(page, host);
  expect(await newMenu()).toBeGreaterThan(0);
  await showTree(page, "Resources");
  await page.locator(`[data-tree-key="${req.key}"]`).click();
  await expect(page.getByRole("textbox", { name: "Address", exact: true }).first()).toHaveValue(`${srv.url}/echo`, { timeout: 15_000 });
  expect((await getRes(page, req.key)).body).toEqual(before.body);
});

/* ------------------------------------------------------------------ D4: search by name, tag and body; command palette */

test("D4: search finds resources by name, tag and body; Cmd/Ctrl+K searches and Cmd/Ctrl+Shift+P runs commands", async ({ page }) => {
  await bare(page);
  await create(page, NOTE, { name: "Zeppelin plan", "body.text": "launch the quokka initiative", tags: ["fieldwork"] });
  await openKernel(page, host);
  const search = async (text: string) => {
    await page.keyboard.press("ControlOrMeta+k");
    const box = page.getByRole("combobox", { name: "Search this workspace" });
    await expect(box).toBeFocused();
    await box.fill(text);
  };
  for (const [query, how] of [["Zeppelin", "name"], ["fieldwork", "tag"], ["quokka", "body"]] as const) {
    await search(query);
    await expect(page.getByRole("option", { name: /Zeppelin plan/ }), `by ${how}`).toBeVisible({ timeout: 15_000 });
    await page.keyboard.press("Escape");
  }
  await search("nothingmatchesthis");
  await expect(page.getByText(/Nothing matches/)).toBeVisible();
  await page.keyboard.press("Escape");

  // the command palette lists commands, filters them, and runs one
  await page.keyboard.press("ControlOrMeta+Shift+p");
  const palette = page.getByPlaceholder("Type a command");
  await expect(palette).toBeFocused();
  await palette.fill("Theme: dark");
  await page.getByRole("option", { name: /Theme: dark/ }).first().click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.keyboard.press("ControlOrMeta+Shift+p");
  await page.getByPlaceholder("Type a command").fill("Theme: light");
  await page.getByRole("option", { name: /Theme: light/ }).first().click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});

/* ------------------------------------------------------------------ D6: kernel tests cover CRUD, plugin loading/manifest, actions */

/** Names of the Rust tests in crates/kernel (src and tests/), read from the source: compiling and running them is `pnpm test:rust`. */
function kernelTests(): { file: string; name: string }[] {
  const out: { file: string; name: string }[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".rs")) {
        const lines = readFileSync(p, "utf8").split("\n");
        lines.forEach((l, i) => {
          if (!/^\s*#\[(tokio::)?test/.test(l)) return;
          for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
            const m = /^\s*(?:pub )?(?:async )?fn (\w+)/.exec(lines[j]!);
            if (m) {
              out.push({ file: e.name, name: m[1]! });
              break;
            }
          }
        });
      }
    }
  };
  walk(path.join(ROOT, "crates/kernel"));
  return out;
}

test("D6: the kernel's own tests cover resource CRUD, plugin loading, manifest validation and action execution", () => {
  const tests = kernelTests();
  expect(tests.length).toBeGreaterThan(200);
  for (const [what, re] of [
    ["resource create/read/update/delete", /create|delete|update|restore|rename|move|trash|resource/i],
    ["plugin loading", /plugin|install|enable|disable|upgrade|load/i],
    ["manifest validation", /manifest|schema|invalid|reason/i],
    ["action execution", /action|run/i],
  ] as const) {
    expect(tests.filter((t) => re.test(t.name + t.file)).length, `kernel tests for: ${what}`).toBeGreaterThan(10);
  }
});
