import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { DEVHOST, openKernel, rpc, startHost, stopHost, type Host } from "./kernel-host";
import { DB1, DB2, PG_PASSWORD, PG_USER, pgBinOrNull, startPg, type Pg } from "./pg-fixture";

test.use({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
test.describe.configure({ mode: "serial" });
test.setTimeout(60_000);

let host: Host;
let base: string;
let pg: Pg;

test.beforeAll(async () => {
  if (process.env.ONEDESK_E2E_REQUIRE_DEVHOST === "1") expect(existsSync(DEVHOST), `onedesk-devhost not built at ${DEVHOST}`).toBe(true);
  else test.skip(!existsSync(DEVHOST), `onedesk-devhost not built at ${DEVHOST}`);
  expect(pgBinOrNull, "no PostgreSQL (initdb) on this machine").not.toBeNull();
  base = realpathSync(mkdtempSync(path.join(tmpdir(), "od-round15-")));
  pg = await startPg(path.join(base, "pg"));
  host = await startHost(path.join(base, "data"));
});
test.afterAll(async () => {
  if (host) await stopHost(host);
  if (pg) pg.stop();
  if (base) rmSync(base, { recursive: true, force: true });
});

const call = <T = unknown>(page: Page, method: string, params: unknown = null) => rpc<T>(page, host, method, params);

const DS = "org.onedesk.datasource:source";
const SQLK = "org.onedesk.sql:query";
type Saved = { page: { resourceId: string } };
type Res = { id: string; name: string; deleted: boolean; body: Record<string, any> };
const create = async (page: Page, kind: string, changes: Record<string, unknown>) => (await call<Saved>(page, "page.save", { target: `new:${kind}`, changes })).page.resourceId;
const getRes = (page: Page, id: string) => call<Res>(page, "resource.get", { id });
const direct = (name: string, over: Record<string, unknown> = {}) => ({ name, "body.mode": "direct", "body.host": "127.0.0.1", "body.port": String(pg.port), "body.database": DB1, "body.user": PG_USER, ...over });
const tb = (page: Page, n: string) => page.getByRole("textbox", { name: n, exact: true });
const resultArea = (page: Page) => page.getByRole("region", { name: /Result/i }).or(page.locator("main")).first();
const ids: Record<string, string> = {};

type Node = { key: string; label: string; kind?: string };
const nodes = async (page: Page, tree: string, parent?: string) => (await call<{ nodes: Node[] }>(page, "tree.children", { tree, parent })).nodes;
const nodeId = async (page: Page, tree: string, label: string) => (await nodes(page, tree)).find((n) => n.label === label)!.key;
const treeItem = (page: Page, name: string) => page.getByRole("treeitem", { name, exact: true });
const showResources = async (page: Page) => {
  const b = page.getByRole("navigation", { name: "Views" }).getByRole("button", { name: "Resources", exact: true });
  if ((await b.getAttribute("aria-pressed")) !== "true") await b.click();
};
const openByName = async (page: Page, name: string) => {
  await showResources(page);
  await treeItem(page, name).dblclick();
};
const grepData = (word: string): string => {
  try {
    return execFileSync("/usr/bin/grep", ["-rl", "--binary-files=text", word, path.join(base, "data")], { encoding: "utf8" });
  } catch {
    return "";
  }
};

test("F1/F2/F4: a direct data source is made in the page; the password goes to the keychain only; Test connection works", async ({ page }) => {
  await openKernel(page, host);
  await page.getByRole("button", { name: "New", exact: true }).first().click();
  await page.getByRole("menuitem", { name: "Data source", exact: true }).click();
  await tb(page, "Host").fill("127.0.0.1");
  await tb(page, "Port").fill(String(pg.port));
  await tb(page, "Database").fill(DB1);
  await tb(page, "User").fill(PG_USER);
  await page.getByLabel("Password", { exact: true }).fill(PG_PASSWORD);
  await page.getByRole("button", { name: "Save & test" }).click();
  await expect(page.getByText(/Connected\. PostgreSQL 15/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByLabel("Password", { exact: true })).toHaveAttribute("placeholder", /Saved/);
  await tb(page, "Name").fill("Local shop");
  await tb(page, "Name").press("Enter");
  await expect(treeItem(page, "Local shop")).toBeVisible();
  const id = await nodeId(page, "resources", "Local shop");
  ids.shop = id;
  const res = await getRes(page, id);
  expect(res.body.database).toBe(DB1);
  expect(res.body.password).toEqual({ secret: expect.any(String) });
  // F2: the value is in the keychain (here: the in-memory store) and nowhere the user could find it
  expect(JSON.stringify(res)).not.toContain(PG_PASSWORD);
  expect(JSON.stringify(await call(page, "secrets.list"))).not.toContain(PG_PASSWORD);
  expect(grepData(PG_PASSWORD), "the password is not in any file of the data directory").toBe("");
});

test("F1: a wrong password is an error in the result area and the failed run is in the history", async ({ page }) => {
  await openKernel(page, host);
  ids.bad = await create(page, DS, direct("Wrong password", { "body.password": "not-the-password" }));
  await openByName(page, "Wrong password");
  await page.getByRole("button", { name: "Test connection", exact: true }).click();
  await expect(page.getByText(/password authentication failed/i).first()).toBeVisible({ timeout: 30_000 });
  await page.getByRole("tab", { name: "History" }).click();
  await expect(page.getByText(/error|failed/i).first()).toBeVisible();
});

test("F3: through ssh: the program that runs is the system's ssh; its failure is shown (no server is contacted)", async ({ page }) => {
  await openKernel(page, host);
  await create(page, DS, { name: "Staging", "body.mode": "ssh", "body.sshHost": "e2e-no-such-host.invalid", "body.container": "postgres", "body.database": DB1, "body.user": "postgres" });
  await openByName(page, "Staging");
  await expect(tb(page, "ssh host")).toHaveValue("e2e-no-such-host.invalid");
  await expect(page.getByLabel("Password", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Test connection", exact: true }).click();
  await expect(page.getByText(/Could not resolve hostname|nodename nor servname/i).first()).toBeVisible({ timeout: 30_000 });
});

test("F6: a connection string fills the form (the password in it is not taken)", async ({ page }) => {
  await openKernel(page, host);
  await page.getByRole("button", { name: "New", exact: true }).first().click();
  await page.getByRole("menuitem", { name: "Data source", exact: true }).click();
  await tb(page, "Connection string").fill(`postgres://app:secretpw@127.0.0.1:${pg.port}/${DB2}`);
  await page.getByRole("button", { name: "Import connection string" }).click();
  await expect(tb(page, "Database")).toHaveValue(DB2);
  await expect(tb(page, "Port")).toHaveValue(String(pg.port));
  await expect(tb(page, "User")).toHaveValue("app");
  await expect(page.getByText(/without the password/).first()).toBeVisible();
  await expect(page.getByLabel("Password", { exact: true })).toHaveAttribute("placeholder", /Not set/);
  await page.getByLabel("Password", { exact: true }).fill(PG_PASSWORD);
  await page.getByRole("button", { name: "Save & test" }).click();
  await expect(page.getByText(/Connected\. PostgreSQL 15/)).toBeVisible({ timeout: 30_000 });
  await tb(page, "Name").fill("Other db");
  await tb(page, "Name").press("Enter");
  await expect(treeItem(page, "Other db")).toBeVisible();
  ids.other = await nodeId(page, "resources", "Other db");
  expect(grepData("secretpw")).toBe("");
});

const sqlBox = (page: Page) => page.getByRole("textbox", { name: "SQL", exact: true });
const pickSource = async (page: Page, name: string) => {
  await page.getByRole("combobox", { name: "Data source" }).click();
  await page.getByRole("option", { name }).click();
};

const runBtn = (page: Page) => page.getByRole("button", { name: "Run", exact: true });
const statusLine = (page: Page) => page.locator("footer, [role=status]").first();
const newSql = async (page: Page, sql: string, source = "") => {
  await page.getByRole("button", { name: "New", exact: true }).first().click();
  await page.getByRole("menuitem", { name: "SQL", exact: true }).click();
  await sqlBox(page).fill(sql);
  if (source) await pickSource(page, source);
};
const cell = (page: Page, text: string | RegExp) => page.getByRole("gridcell", { name: text }).or(page.getByRole("cell", { name: text })).first();

test("B1/B3/B4/B5/B7: a new SQL is an unsaved tab; Save & run creates it with its data source; ⌘Enter runs again", async ({ page }) => {
  await openKernel(page, host);
  const before = (await nodes(page, "resources")).length;
  await newSql(page, "SELECT id, customer, amount, note FROM orders ORDER BY id", "Local shop");
  // B3: nothing exists yet
  expect((await nodes(page, "resources")).length).toBe(before);
  await page.getByRole("button", { name: "Save & run" }).click();
  await expect(cell(page, "ann")).toBeVisible({ timeout: 30_000 });
  await expect(cell(page, "o'neil")).toBeVisible();
  await expect(cell(page, 'dee, "d"')).toBeVisible();
  await expect(page.getByText("4 rows").first()).toBeVisible();
  const made = (await nodes(page, "resources")).find((n) => n.label === "Untitled SQL")!;
  const res = await getRes(page, made.key);
  expect(res.body).toMatchObject({ sql: "SELECT id, customer, amount, note FROM orders ORDER BY id", source: ids.shop });
  ids.orders = made.key;
  await tb(page, "Name").fill("Orders by id");
  await tb(page, "Name").press("Enter");
  await expect(treeItem(page, "Orders by id")).toBeVisible();
  // B7: ⌘Enter in the editor runs it again (a second run)
  const badge = page.getByText(/^#\d+$/).first();
  const first = await badge.innerText();
  await sqlBox(page).click();
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(badge).not.toHaveText(first, { timeout: 30_000 });
});

test("explore sql", async ({ page }) => {
  await openKernel(page, host);
  await newSql(page, "-- @param since type=datetime required -- from when\n-- @param kind values=paid|refunded\n-- @param n type=number\n-- @param day type=date\nSELECT :since::text AS since, :kind AS kind, :n::int + 1 AS n1, :day AS day, ':skipped' AS s, :empty AS e", "Local shop");
  await page.waitForTimeout(1500);
  await page.screenshot({ path: "/private/tmp/claude-501/scratch/sql2.png" });
});
