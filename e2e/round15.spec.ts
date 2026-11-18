import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
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
  expect(res.body).toMatchObject({ sql: "SELECT id, customer, amount, note FROM orders ORDER BY id", source: ids.shop! });
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
});
test("C2: the declared checks stop a bad value before anything is sent (the form already refuses to type it; the run checks too)", async ({ page }) => {
  await openKernel(page, host);
  const sql = "-- @param n type=number\n-- @param k values=a|b\n-- @param c max=3\nSELECT :n AS n, :k AS k, :c AS c";
  const rid = await create(page, SQLK, { name: "Checked", "body.sql": sql, "body.source": ids.shop! });
  for (const [params, why] of [
    [{ n: "12x" }, /must be a number/],
    [{ n: "1; DROP TABLE orders" }, /must be a number/],
    [{ k: "z" }, /allowed values/],
    [{ c: "abcd" }, /longer than 3/],
  ] as const) {
    const r = await runSaved(page, rid, sql, ids.shop!, params);
    expect(r.status).toBe("error");
    expect(JSON.stringify(r.error)).toMatch(why);
  }
  const ok = await runSaved(page, rid, sql, ids.shop!, { n: "5", k: "a", c: "abc" });
  expect(ok.status).toBe("success");
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
test("D1: a write that looks like a read (a data-changing WITH, a function) is stopped by the read-only transaction itself and changes nothing", async ({ page }) => {
  await openKernel(page, host);
  await newSql(page, "WITH gone AS (DELETE FROM orders RETURNING id) SELECT * FROM gone", "Local shop");
  await runBtn(page).click();
  await page.waitForTimeout(3000);
  await page.screenshot({ path: "/private/tmp/claude-501/scratch/d1.png" });
  await expect(page.getByText(/read-only transaction/).first()).toBeVisible({ timeout: 30_000 });
  await sqlBox(page).fill("SELECT set_config('default_transaction_read_only', 'off', false), pg_catalog.setval('pg_class_oid_index'::regclass, 1) IS NULL");
  await runBtn(page).click();
  await page.waitForTimeout(1500);
  const count = execFileSync(path.join(pg.bin, "psql"), ["-X", "-A", "-t", "-h", path.join(pg.dir, "sock"), "-p", String(pg.port), "-U", "postgres", "-d", DB1, "-c", "SELECT count(*) FROM orders"], { encoding: "utf8" });
  expect(count.trim()).toBe("4");
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
  await expect(page.getByText(/\b1 rows?\b/).first()).toBeVisible();
  await expect(page.getByText(/\d+(\.\d+)? (ms|s)\b/).first()).toBeVisible();
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

test("D1: nothing outside a plain read-only SELECT gets through: psql commands, E'' tricks, COPY … TO PROGRAM", async ({ page }) => {
  await openKernel(page, host);
  const marker = path.join(base, "pwned");
  await newSql(page, "SELECT 1", "Local shop");
  const tries: [string, RegExp][] = [
    [`SELECT 1\n\\! touch ${marker}`, /backslash/],
    ["SELECT 1\n\\gexec", /backslash/],
    ["SELECT 'x' \\g", /backslash/],
    ["SELECT 1; COMMIT; DELETE FROM orders", /Only one statement/],
    ["SELECT E'\\''; COMMIT; DELETE FROM orders; --'", /Only one statement/],
    [`COPY (SELECT 1) TO PROGRAM 'touch ${marker}'`, /Only SELECT, WITH/],
    ["DELETE FROM orders", /Only SELECT, WITH/],
  ];
  for (const [sql, why] of tries) {
    await sqlBox(page).fill(sql);
    await runBtn(page).click();
    await expect(page.getByText(why).first(), sql).toBeVisible({ timeout: 30_000 });
  }
  expect(existsSync(marker), "no local command ran").toBe(false);
  const count = execFileSync(path.join(pg.bin, "psql"), ["-X", "-A", "-t", "-h", path.join(pg.dir, "sock"), "-p", String(pg.port), "-U", "postgres", "-d", DB1, "-c", "SELECT count(*) FROM orders"], { encoding: "utf8" });
  expect(count.trim()).toBe("4");
  // defence in depth: the session itself is read-only (PGOPTIONS), so a write that got past the plugin would still fail
  const direct = (sql: string) => execFileSync(path.join(pg.bin, "psql"), ["-X", "-q", "-h", path.join(pg.dir, "sock"), "-p", String(pg.port), "-U", PG_USER, "-d", DB1, "-c", sql], { encoding: "utf8", stdio: "pipe", env: { PGOPTIONS: "-c default_transaction_read_only=on" } });
  expect(() => direct("DELETE FROM orders")).toThrow(/read-only transaction/);
});

type RunInfo = { id: string; status: string; summary?: { rows?: number; message?: string }; error?: { code: string; message?: string }; output?: { type: string; rows: unknown[][]; total: number; truncated?: boolean; paged?: boolean; columns: { label: string }[] } };
/** Runs a saved statement through the protocol (as the shell's Run button does) and waits for the end. */
const runSaved = async (page: Page, resourceId: string, sql: string, source: string, params: Record<string, string> = {}, envId?: string): Promise<RunInfo> => {
  const id = await call<string>(page, "run.start", { action: "run", resourceId, target: `resource:${resourceId}`, tabId: "e2e-tab", input: { "body.sql": sql, "body.source": source }, params, envId, locale: "en-US" });
  for (let i = 0; i < 150; i++) {
    const r = await call<RunInfo>(page, "run.get", { id });
    if (r.status !== "running") return r;
    await new Promise((res) => setTimeout(res, 200));
  }
  throw new Error("run did not end");
};

test("D8/D7: a result of 25,000 rows does not go through the plugin's memory: all rows are counted, 10,000 kept in the run, pages and the export read every row; the export starts with a BOM", async ({ page }) => {
  await openKernel(page, host);
  const sql = "SELECT g AS n, md5(g::text) AS h, 'multi\nline' || g AS m FROM generate_series(1, 25000) g ORDER BY g";
  const rid = await create(page, SQLK, { name: "Big", "body.sql": sql, "body.source": ids.shop! });
  const run = await runSaved(page, rid, sql, ids.shop!);
  expect(run.status).toBe("success");
  const got = await call<RunInfo>(page, "run.get", { id: run.id });
  expect(got.output).toMatchObject({ type: "table", total: 25000, paged: true });
  expect(got.output!.columns.map((c) => c.label)).toEqual(["n", "h", "m"]);
  // run.rows pages through what the run kept; the export holds everything
  const page1 = await call<{ rows: string[][]; total: number }>(page, "run.rows", { id: run.id, offset: 0, limit: 1000 });
  expect(page1.total).toBe(25000);
  expect(page1.rows[0]![0]).toBe("1");
  const file = path.join(base, "big.csv");
  await call(page, "run.export", { run: run.id, path: file, format: "csv" });
  const bytes = readFileSync(file);
  expect([bytes[0], bytes[1], bytes[2]], "UTF-8 BOM").toEqual([0xef, 0xbb, 0xbf]);
  const text = bytes.toString("utf8").slice(1);
  expect(text.startsWith("n,h,m")).toBe(true);
  expect(text).toContain(`25000,${createHash("md5").update("25000").digest("hex")},"multi`);
  expect(text.split(/\r?\n/).filter((l) => /^\d+,[0-9a-f]{32},/.test(l)).length, "every one of the 25,000 rows is in the export").toBe(25000);
});

test("D4: the Sent SQL tab of a run renders from the run (checked through the protocol)", async ({ page }) => {
  await openKernel(page, host);
  const sql = "SELECT :a AS a";
  const rid = await create(page, SQLK, { name: "Sent", "body.sql": sql, "body.source": ids.shop! });
  const run = await runSaved(page, rid, sql, ids.shop!, { a: "x'y" });
  expect(run.status).toBe("success");
  const view = await call<{ nodes?: { text?: string }[] } | { text?: string }[]>(page, "run.render", { id: run.id, tabId: "sent", locale: "en-US" });
  expect(JSON.stringify(view)).toContain("SELECT 'x''y' AS a");
});

test("D4: the Sent SQL tab shows the statement as sent, parameters substituted as literals", async ({ page }) => {
  await openKernel(page, host);
  await newSql(page, PARAMS_SQL, "Local shop");
  const field = (n: string) => page.getByLabel(n, { exact: true });
  await field("since").fill("2026-01-02T03:04");
  await page.getByRole("combobox", { name: "kind" }).click();
  await page.getByRole("option", { name: "paid" }).click();
  await page.getByRole("button", { name: "Save & run" }).click();
  await expect(cell(page, "2026-01-02T03:04:00Z")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("tab", { name: "Sent SQL" }).click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: "/private/tmp/claude-501/scratch/sent.png" });
  const sent = page.locator("body"); // only the Sent SQL tab holds the substituted text
  await expect(sent).toContainText("'2026-01-02T03:04:00Z'::text AS since");
  await expect(sent).toContainText("'paid' AS kind");
  await expect(sent).toContainText("NULL AS e");
  await expect(sent).toContainText("':skipped' AS s");
});

test("F5: the data source of a statement: its own, else the environment's, else the workspace default; none is an error", async ({ page }) => {
  await openKernel(page, host);
  const sql = "SELECT current_database() AS db";
  const rid = await create(page, SQLK, { name: "Which db", "body.sql": sql, "body.source": "" });
  const envId = await nodeId(page, "env", "Default");
  const cfg = await nodeId(page, "config", "Workspace");
  const db = async (source = "") => {
    const r = await runSaved(page, rid, sql, source, {}, envId);
    if (r.status !== "success") return `error: ${JSON.stringify(r.error)}`;
    return (await call<{ rows: string[][] }>(page, "run.rows", { id: r.id, offset: 0, limit: 10 })).rows[0]![0];
  };
  expect(await db()).toMatch(/error.*No data source/s);
  await call(page, "params.set", { node: cfg, name: "datasource.default", value: ids.other, type: "ref" });
  expect(await db()).toBe(DB2); // the workspace default
  await call(page, "params.set", { node: envId, name: "datasource", value: ids.shop!, type: "ref" });
  expect(await db()).toBe(DB1); // the environment beats the default
  expect(await db(ids.other)).toBe(DB2); // the statement's own beats both
  await call(page, "params.unset", { node: envId, name: "datasource" });
  expect(await db()).toBe(DB2);
  await call(page, "params.unset", { node: cfg, name: "datasource.default" });
  expect(await db()).toMatch(/error.*No data source/s);
});

test("B6: Copy SQL; the data source field is a reference list of the data sources (ref)", async ({ page }) => {
  await openKernel(page, host);
  await newSql(page, "SELECT 1", "");
  await page.getByRole("button", { name: "Copy SQL" }).click();
  await expect(page.getByText("SQL copied.").first()).toBeVisible();
  await page.getByRole("combobox", { name: "Data source" }).click();
  const names = await page.getByRole("option").allInnerTexts();
  for (const n of ["Local shop", "Wrong password", "Staging", "Other db"]) expect(names.join("|")).toContain(n);
  expect(names.join("|")).not.toContain("Orders by id"); // only data sources
});

test("D8 (screen): a 25,000-row result is announced in full; scrolling to the end loads the last rows", async ({ page }) => {
  await openKernel(page, host);
  await openByName(page, "Big");
  await runBtn(page).click();
  await expect(page.getByText(/25[,.]?000/).first()).toBeVisible({ timeout: 60_000 });
  await expect(cell(page, "1")).toBeVisible();
  const grid = page.getByRole("grid").or(page.getByRole("table")).first();
  await grid.hover();
  // every page of rows is read when the end of what is loaded comes into view
  for (let i = 0; i < 150 && !(await cell(page, "25000").isVisible()); i++) {
    await page.mouse.wheel(0, 100_000);
    await page.waitForTimeout(150);
  }
  await page.screenshot({ path: "/private/tmp/claude-501/scratch/big.png" });
  await expect(cell(page, "25000")).toBeVisible({ timeout: 30_000 });
});
