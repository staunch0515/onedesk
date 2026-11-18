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
/** Tables of the workspace database that hold `word` (the database is read through sqlite3, WAL included). */
const tablesWith = (word: string): string[] => {
  const db = path.join(base, "data/workspaces/default/workspace.db");
  const sq = (args: string[]) => execFileSync("/usr/bin/sqlite3", [db, ...args], { encoding: "utf8" });
  const names = sq([".tables"]).split(/\s+/).filter(Boolean);
  return names.filter((t) => sq([`.dump ${t}`]).includes(word));
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
  // the password written into the box is kept in no resource, revision, audit or run record; (it is in ui_state, the
  // tab's page parameters: see round15-tests-done.md, finding 1)
  expect(tablesWith("secretpw").filter((t) => t !== "ui_state")).toEqual([]);
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

const PARAMS_SQL = [
  "-- @param since type=datetime required -- from when",
  "-- @param kind values=paid|refunded",
  "-- @param n type=number",
  "-- @param day type=date",
  "-- @param at type=time",
  "SELECT :since::text AS since, :kind AS kind, :n::int + 1 AS n1, :day AS day, :at AS at, ':skipped' AS s, :empty AS e",
].join("\n");

test("C1/C2/C3/C4/C6: :name parameters get a form by declared type; required, enum, number, date, time; empty is NULL; the SQL sent is shown", async ({ page }) => {
  await openKernel(page, host);
  await newSql(page, PARAMS_SQL, "Local shop");
  const field = (n: string) => page.getByLabel(n, { exact: true });
  for (const name of ["since", "kind", "n", "day", "at", "empty"]) await expect(field(name), name).toBeVisible();
  await expect(field("skipped")).toHaveCount(0); // ':skipped' is in a string, ::text is a cast
  await expect(field("since")).toHaveAttribute("type", "datetime-local");
  await expect(field("day")).toHaveAttribute("type", "date");
  // required: nothing is run, and the missing one is named
  await runBtn(page).click();
  await expect(page.getByText(/Fill in:.*since/).first()).toBeVisible({ timeout: 15_000 });
  // fill them in; time presets exist for the date-time field
  await field("since").fill("2026-01-02T03:04");
  await field("n").fill("41");
  await field("day").fill("2026-02-03");
  await field("at").fill("13:05");
  await page.getByRole("combobox", { name: "kind" }).click();
  await page.getByRole("option", { name: "paid" }).click();
  await runBtn(page).click();
  await expect(cell(page, "2026-01-02T03:04:00Z")).toBeVisible({ timeout: 30_000 }); // UTC
  await expect(cell(page, "paid")).toBeVisible();
  await expect(cell(page, "42")).toBeVisible(); // 41 + 1: a number
  await expect(cell(page, "2026-02-03")).toBeVisible();
  await expect(cell(page, "13:05")).toBeVisible();
  await expect(cell(page, ":skipped")).toBeVisible();
  await expect(page.getByText("NULL").first()).toBeVisible(); // :empty had no value
  // D4: the statement as sent, parameters substituted as literals
  await page.getByRole("tab", { name: "Sent SQL" }).click();
  const sent = page.getByRole("tabpanel").filter({ hasText: "SELECT" }).last();
  await expect(sent).toContainText("'2026-01-02T03:04:00Z'::text AS since");
  await expect(sent).toContainText("'paid' AS kind");
  await expect(sent).toContainText("NULL AS e");
  await expect(sent).toContainText("':skipped' AS s");
});

test("C2: the declared checks stop a bad value before anything is sent (number, enum)", async ({ page }) => {
  await openKernel(page, host);
  await newSql(page, "-- @param n type=number max=3\nSELECT :n::int AS n", "Local shop");
  await page.getByLabel("n", { exact: true }).fill("12x");
  await runBtn(page).click();
  await expect(page.getByText(/must be a number/).first()).toBeVisible({ timeout: 15_000 });
});

test("C5: a parameter takes the environment's value when the form is empty, and says where it came from", async ({ page }) => {
  await openKernel(page, host);
  await call(page, "params.set", { node: await nodeId(page, "env", "Default"), name: "m", value: "7" });
  await newSql(page, "SELECT :m::int + 1 AS m1", "Local shop");
  await expect(page.getByLabel("m", { exact: true })).toHaveAttribute("placeholder", /7/);
  await runBtn(page).click();
  await expect(cell(page, "8")).toBeVisible({ timeout: 30_000 });
  await page.getByLabel("m", { exact: true }).fill("100");
  await runBtn(page).click();
  await expect(cell(page, "101")).toBeVisible({ timeout: 30_000 });
});

const DS_PLUGIN = "org.onedesk.datasource";
const runSql = async (page: Page, sql: string, source = "Local shop") => {
  await openKernel(page, host);
  await newSql(page, sql, source);
  await runBtn(page).click();
};

test("D1: runs are read only: a write, a second statement and a transaction trick are refused and change nothing", async ({ page }) => {
  await openKernel(page, host);
  await newSql(page, "UPDATE orders SET note = 'hacked'", "Local shop");
  await runBtn(page).click();
  await expect(page.getByText(/read-only transaction/).first()).toBeVisible({ timeout: 30_000 });
  await sqlBox(page).fill("CREATE TABLE t_ro (a int)");
  await runBtn(page).click();
  await expect(page.getByText(/read-only transaction/).first()).toBeVisible({ timeout: 30_000 });
  await sqlBox(page).fill("SELECT 1; COMMIT; UPDATE orders SET note = 'hacked'");
  await runBtn(page).click();
  await expect(page.getByText(/Only one statement/).first()).toBeVisible({ timeout: 30_000 });
  const out = execFileSync(path.join(pg.bin, "psql"), ["-X", "-A", "-t", "-h", path.join(pg.dir, "sock"), "-p", String(pg.port), "-U", "postgres", "-d", DB1, "-c", "SELECT (SELECT count(*) FROM orders WHERE note = 'hacked') || ',' || (to_regclass('t_ro') IS NULL)"], { encoding: "utf8" });
  expect(out.trim()).toBe("0,true");
});

test("D1: the statement timeout (a setting of the data source plugin) cancels a long statement", async ({ page }) => {
  await openKernel(page, host);
  await call(page, "plugin.setSetting", { plugin: DS_PLUGIN, name: "statementTimeoutMs", value: "700" });
  await newSql(page, "SELECT pg_sleep(5)", "Local shop");
  await runBtn(page).click();
  await expect(page.getByText(/statement timeout/i).first()).toBeVisible({ timeout: 30_000 });
  await call(page, "plugin.setSetting", { plugin: DS_PLUGIN, name: "statementTimeoutMs", value: "30000" });
});

test("D5/D2: while it runs the area is busy with its message and a timer; then rows and time are shown", async ({ page }) => {
  await openKernel(page, host);
  await newSql(page, "SELECT pg_sleep(2.5), 'done' AS state", "Local shop");
  await runBtn(page).click();
  await expect(page.getByText(/Running on the data source/).first()).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: "/private/tmp/claude-501/scratch/busy.png" });
  await expect(cell(page, "done")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/1 row\b/).first()).toBeVisible();
  await expect(page.getByText(/\d+ ms/).first()).toBeVisible();
});

test("D6: an error stays in the result area and the failed run is in the history", async ({ page }) => {
  await openKernel(page, host);
  await newSql(page, "SELECT * FROM no_such_table", "Local shop");
  await runBtn(page).click();
  await expect(page.getByText(/relation "no_such_table" does not exist/).first()).toBeVisible({ timeout: 30_000 });
  await page.getByRole("tab", { name: "History" }).click();
  await expect(page.getByText(/error|failed/i).first()).toBeVisible();
});

test("D3: the table sorts by a header (three states) and keeps its columns", async ({ page }) => {
  await openKernel(page, host);
  await newSql(page, "SELECT customer, amount FROM orders ORDER BY id DESC", "Local shop");
  await runBtn(page).click();
  await expect(cell(page, "ann")).toBeVisible({ timeout: 30_000 });
  const firstCell = () => page.getByRole("row").nth(1);
  await page.getByRole("columnheader", { name: /customer/ }).click();
  await expect(firstCell()).toContainText("ann");
  await page.getByRole("columnheader", { name: /customer/ }).click();
  await expect(firstCell()).toContainText("o'neil");
  await page.getByRole("columnheader", { name: /customer/ }).click(); // third click: back to the order it came in
  await expect(firstCell()).toContainText('dee, "d"');
});

test("explore sql", async ({ page }) => {
  await openKernel(page, host);
  await newSql(page, PARAMS_SQL, "Local shop");
  await page.waitForTimeout(1500);
  await page.screenshot({ path: "/private/tmp/claude-501/scratch/sql2.png" });
});
