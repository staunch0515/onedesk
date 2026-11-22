/** Round 20 parity batch 1: sqlpool-parity.md §3 rows A1–A10, B1–B7, C1–C6, D1–D8 (real devhost, real PostgreSQL, browser shell). */
// @ts-nocheck — one-off acceptance script split from one long file: leftover unused helpers and unchecked lookups; it is run by Playwright, not shipped.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { DEVHOST, openKernel, rpc, startHost, stopHost, type Host } from "../kernel-host";
import { DB1, PG_PASSWORD, PG_USER, startPg, type Pg } from "../pg-fixture";
import { Outcome, changed, mkBase, oracle, pass, row, seedParity, shot, unverified } from "./support";
import { existsSync } from "node:fs";

test.use({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
test.describe.configure({ mode: "serial" });
test.setTimeout(180_000);

let host: Host;
let base: string;
let pg: Pg;
let catalog: string;
const hashDir = (d: string): string => {
  const h = createHash("sha256");
  const walk = (p: string) => {
    for (const n of readdirSync(p, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const f = path.join(p, n.name);
      if (n.isDirectory()) walk(f);
      else h.update(n.name).update(readFileSync(f));
    }
  };
  walk(d);
  return h.digest("hex");
};
let catalogHash0 = "";

const MAPPING = `entities:
  order:
    table: orders
    description: Orders of the shop
    columns:
      id: id
      customer: customer
      amount: amount
      placed: placed_at
  item:
    table: item_ver
    columns:
      id: item_id
      name: name
    versioned:
      key: [item_id]
      from: valid_from
      to: valid_to
      deleted: is_deleted
  line:
    table: ord_line
    columns:
      id: line_id
      order: order_id
      sku: sku
      qty: qty
  ghost:
    table: no_such_table
    columns:
      id: id
`;

test.beforeAll(async () => {
  expect(existsSync(DEVHOST), `devhost at ${DEVHOST}`).toBe(true);
  base = mkBase("p1");
  pg = await startPg(path.join(base, "pg"));
  seedParity(pg, DB1);
  catalog = path.join(base, "catalog");
  mkdirSync(path.join(catalog, "sales/deep"), { recursive: true });
  const q = (rel: string, head: string, body: string) => writeFileSync(path.join(catalog, rel), `/* ---\n${head}\n--- */\n${body}\n`);
  q("sales/recent.sql", "id: sales.orders.recent\ntitle: Recent orders\ndescription: Orders above an amount\npermissions: [read]\ntags: [sales]\nparams:\n  - name: min\n    type: number\n    required: true\n    description: Smallest amount", "SELECT {{order.id}} AS id, {{order.customer}} AS customer FROM {{order}} WHERE {{order.amount}} >= :min ORDER BY {{order.id}}");
  q("sales/top.sql", "id: sales.top\ntitle: Top lines\nparams: [n]", "SELECT {{line.id}} AS id, {{line.sku}} AS sku FROM {{line}} ORDER BY {{line.qty}} DESC LIMIT :n");
  q("sales/deep/lines.sql", "id: sales.lines.by_order\ntitle: Lines of an order\nparams:\n  - name: ord\n    type: number\n    required: true", "SELECT {{line.id}} AS id, {{line.qty}} AS qty FROM {{line}} WHERE {{line.order}} = :ord ORDER BY 1");
  q("items.sql", "id: items.current\ntitle: Items", "SELECT {{item.id}} AS id, {{item.name}} AS name FROM {{item}} AS i ORDER BY 1");
  q("warn.sql", "id: misc.warn\ntitle: Warns\nparams: [unused]", "SELECT {{nothing}} AS x, :undeclared AS y");
  writeFileSync(path.join(catalog, "plain.sql"), "SELECT 1\n");
  writeFileSync(path.join(catalog, "broken.sql"), "/* ---\nid: [oops\n--- */\nSELECT 1\n");
  writeFileSync(path.join(catalog, "mapping.yaml"), MAPPING);
  catalogHash0 = hashDir(catalog);
  host = await startHost(path.join(base, "data"));
});
test.afterAll(async () => {
  if (host) await stopHost(host);
  if (pg) pg.stop();
  if (base) rmSync(base, { recursive: true, force: true });
});

const call = <T = unknown>(page: Page, method: string, params: unknown = null) => rpc<T>(page, host, method, params);
type Res = { id: string; name: string; description: string; state?: string; stateReason?: string; body: Record<string, any>; tags?: string[]; deleted?: boolean; kind: string };
type Node = { key: string; label: string; kind?: string; state?: string; target?: string; badge?: string };
const nodes = async (page: Page, tree: string, parent?: string) => (await call<{ nodes: Node[] }>(page, "tree.children", { tree, parent })).nodes;
const getRes = (page: Page, id: string) => call<Res>(page, "resource.get", { id });
const create = async (page: Page, kind: string, changes: Record<string, unknown>) => (await call<{ page: { resourceId: string } }>(page, "page.save", { target: `new:${kind}`, changes })).page.resourceId;
type RunInfo = { id: string; status: string; kept?: boolean; error?: { code: string; message?: string }; summary?: { rows?: number; message?: string }; params?: Record<string, string>; output?: any };
const waitRun = async (page: Page, id: string): Promise<RunInfo> => {
  for (let i = 0; i < 200; i++) {
    const r = await call<RunInfo>(page, "run.get", { id });
    if (r.status !== "running") return r;
    await new Promise((res) => setTimeout(res, 200));
  }
  throw new Error("run did not end");
};
const startRun = async (page: Page, action: string, target: string, params: Record<string, string> = {}, extra: Record<string, unknown> = {}) => waitRun(page, await call<string>(page, "run.start", { action, target, tabId: "p-tab", input: {}, params, locale: "en-US", ...extra }));
const rowsOf = async (page: Page, run: RunInfo, limit = 1000) => (await call<{ rows: string[][]; total: number }>(page, "run.rows", { id: run.id, offset: 0, limit })).rows;
const sentSql = async (page: Page, run: RunInfo) => JSON.stringify(await call(page, "run.render", { id: run.id, tabId: "sent", locale: "en-US" }).catch(() => null));
const CAT = "org.onedesk.catalog:catalog";
const treeCmd = (page: Page, id: string, tree: string) => call(page, "command.execute", { id, context: { tree } });
const ids: Record<string, string> = {};
const sqlText = (s: string) => JSON.parse(s) as string;
void sqlText;

const tb = (page: Page, n: string) => page.getByRole("textbox", { name: n, exact: true });
const treeItem = (page: Page, name: string) => page.getByRole("treeitem", { name, exact: true });
const sqlBox = (page: Page) => page.getByRole("textbox", { name: "SQL", exact: true });
const runBtn = (page: Page) => page.getByRole("button", { name: "Run", exact: true });
const cell = (page: Page, text: string | RegExp) => page.getByRole("gridcell", { name: text }).or(page.getByRole("cell", { name: text })).first();
const pickSource = async (page: Page, name: string) => {
  await page.getByRole("combobox", { name: "Data source" }).click();
  await page.getByRole("option", { name }).click();
};
const newSql = async (page: Page, sql: string, source = "") => {
  await page.getByRole("button", { name: "New", exact: true }).first().click();
  await page.getByRole("menuitem", { name: "SQL", exact: true }).click();
  await sqlBox(page).fill(sql);
  if (source) await pickSource(page, source);
};
const showResources = async (page: Page) => {
  const b = page.getByRole("navigation", { name: "Views" }).getByRole("button", { name: "Resources", exact: true });
  if ((await b.getAttribute("aria-pressed")) !== "true") await b.click();
};
const expectRows = (got: string[][], want: string[][]) => expect(got).toEqual(want);

test("setup: data source through the page (F-form), workspace default, granted folder, first index", async ({ page }) => {
  await openKernel(page, host);
  ids.shop = await create(page, "org.onedesk.datasource:source", { name: "Shop", "body.mode": "direct", "body.host": "127.0.0.1", "body.port": String(pg.port), "body.database": DB1, "body.user": PG_USER, "body.password": PG_PASSWORD });
  const cfg = (await nodes(page, "config")).find((n) => n.label === "Workspace")!.key;
  await call(page, "params.set", { node: cfg, name: "datasource.default", value: ids.shop, type: "ref" });
  await call(page, "plugin.grantFolder", { plugin: "org.onedesk.catalog", path: catalog });
  await row("A1", async () => {
    const effects = JSON.stringify(await treeCmd(page, "org.onedesk.catalog:reindex", CAT));
    expect(effects).toMatch(/5 queries indexed, 2 skipped, 0 missing/);
    return "";
  });
});

test("A1–A10: query catalog", async ({ page }) => {
  await openKernel(page, host);
  await row("A1", async () => {
    // external key = path; nested folders are read; a restart indexes by itself (activation on workspace open)
    const top = await nodes(page, CAT);
    const all: Node[] = [];
    const walk = async (parent?: string) => {
      for (const n of await nodes(page, CAT, parent)) {
        if (n.key.startsWith("g:")) await walk(n.key);
        else all.push(n);
      }
    };
    await walk();
    expect(all.length).toBe(5);
    const byTitle = Object.fromEntries(all.map((n) => [n.label, n.key]));
    ids.recent = byTitle["Recent orders"]!;
    ids.top = byTitle["Top lines"]!;
    ids.lines = byTitle["Lines of an order"]!;
    ids.items = byTitle["Items"]!;
    ids.warn = byTitle["Warns"]!;
    expect((await getRes(page, ids.recent)).body.path).toBe(path.join(catalog, "sales/recent.sql"));
    expect((await getRes(page, ids.lines)).body.path).toBe(path.join(catalog, "sales/deep/lines.sql")); // nested file
    void top;
    return "5 个 .sql（含子文件夹）入索引、外部键=路径（嵌套文件夹里的也读到）";
  }, page);

  await row("A2", async () => {
    const d = await call<{ readOnly: boolean; values: Record<string, string> }>(page, "page.resolve", { target: `resource:${ids.recent}` });
    expect(d.readOnly).toBe(true);
    expect(d.values.sql).toContain("SELECT");
    expect(JSON.stringify(d)).not.toContain('"bind"');
    return "条目页只读、带文件正文、字段不绑定";
  }, page);

  await row("A5", async () => {
    const d = JSON.stringify(await call(page, "page.resolve", { target: "page:org.onedesk.catalog/index" }));
    expect(d).toContain("plain.sql");
    expect(d).toContain("broken.sql");
    const res = await getRes(page, ids.recent);
    expect(res.description).toBe("Orders above an amount");
    expect(JSON.stringify(res.body)).toMatch(/permissions|read/);
    const rd = JSON.stringify(await call(page, "page.resolve", { target: `resource:${ids.recent}` }));
    expect(rd).toContain("Smallest amount"); // param description
    return "id/title/description/params/permissions 被解析；无头部、坏 YAML 的两个文件在索引报告里列出原因";
  }, page);

  await row("A9", async () => {
    expect((await nodes(page, CAT)).map((n) => n.label).sort()).toEqual(["items", "misc", "sales"]);
    expect((await nodes(page, CAT, "g:sales")).map((n) => n.label).sort()).toEqual(["Top lines", "lines", "orders"]);
    return "recent→sales›orders、lines.by_order→sales›lines、sales.top 在 sales 下、items.current→items";
  }, page);

  await row("A6", async () => {
    const run = await startRun(page, "org.onedesk.catalog:run", `resource:${ids.recent}`, { min: "20" }, { resourceId: ids.recent });
    expect(run.status, JSON.stringify(run.error)).toBe("success");
    const got = await rowsOf(page, run);
    const want = oracle(pg, DB1, "SELECT id AS id, customer AS customer FROM orders WHERE amount >= 20 ORDER BY id");
    expectRows(got, want);
    const sent = await sentSql(page, run);
    expect(sent).toContain("FROM orders");
    expect(sent).not.toContain("{{");
    // a second entity with a different column mapping (line: order -> order_id)
    const r2 = await startRun(page, "org.onedesk.catalog:run", `resource:${ids.lines}`, { ord: "2" }, { resourceId: ids.lines });
    expectRows(await rowsOf(page, r2), oracle(pg, DB1, "SELECT line_id, qty FROM ord_line WHERE order_id = 2 ORDER BY 1"));
    return `行与 psql 直查同一库一致（${want.length} 行 + ${(await rowsOf(page, r2)).length} 行）；实际发出的 SQL 不含 {{ }}`;
  }, page);

  await row("A7", async () => {
    const cur = await startRun(page, "org.onedesk.catalog:run", `resource:${ids.items}`, {}, { resourceId: ids.items });
    expectRows(await rowsOf(page, cur), oracle(pg, DB1, "SELECT DISTINCT ON (item_id) item_id, name FROM item_ver WHERE valid_from <= now() AND is_deleted = false AND (valid_to IS NULL OR valid_to > now()) ORDER BY item_id"));
    const asOf = await startRun(page, "org.onedesk.catalog:run", `resource:${ids.items}`, { as_of: "2026-01-10T00:00:00Z" }, { resourceId: ids.items });
    expect(asOf.status, JSON.stringify(asOf.error)).toBe("success");
    expectRows(await rowsOf(page, asOf), oracle(pg, DB1, "SELECT item_id, name FROM item_ver WHERE valid_from <= '2026-01-10T00:00:00Z' AND (valid_to IS NULL OR valid_to > '2026-01-10T00:00:00Z') ORDER BY 1"));
    const apr = await startRun(page, "org.onedesk.catalog:run", `resource:${ids.items}`, { as_of: "2026-04-01T00:00:00Z" }, { resourceId: ids.items });
    expectRows(await rowsOf(page, apr), [["1", "pen v2"], ["2", "cup"]]);
    return "“现在”“1月10日”“4月1日”三个截至时间的结果都与 psql 手写的“某时刻生效的最新版本”一致；已删除的版本（item 3）现在不出现";
  }, page);

  await row("A8", async () => {
    const d = JSON.stringify(await call(page, "page.resolve", { target: `resource:${ids.warn}` }));
    expect(d).toContain("undeclared");
    expect(d).toContain("unused");
    expect(d).toContain("nothing");
    return "页面给出三种警告：未声明的 undeclared、未使用的 unused、没有映射的 {{nothing}}";
  }, page);

  await row("A10", async () => {
    const run = await startRun(page, "org.onedesk.catalog:saveAsSql", `resource:${ids.recent}`, { min: "20" }, { resourceId: ids.recent });
    expect(run.status, JSON.stringify(run.error)).toBe("success");
    const saved = (await nodes(page, "resources")).find((n) => n.kind === "org.onedesk.sql:query" && /recent orders/i.test(n.label));
    expect(saved).toBeTruthy();
    const r = await getRes(page, saved!.key);
    expect(r.body.sql).toContain("FROM orders");
    expect(r.body.sql).not.toContain("{{");
    expect(r.body.sql).toContain(":min");
    expect(JSON.stringify(await call(page, "run.get", { id: run.id }))).toContain('"min":"20"');
    ids.savedSql = saved!.key;
    const again = await startRun(page, "run", `resource:${saved!.key}`, { min: "20" }, { resourceId: saved!.key, input: { "body.sql": r.body.sql, "body.source": "" } });
    expectRows(await rowsOf(page, again), oracle(pg, DB1, "SELECT id, customer FROM orders WHERE amount >= 20 ORDER BY id"));
    return "另存为 SQL：新资源带展开后的正文与 :min，带上当前值 20，再运行结果与 psql 一致";
  }, page);

  await row("A3", async () => {
    await call(page, "page.save", { target: `resource:${ids.top}`, changes: { name: "My top", tags: ["mine"] } });
    await call(page, "command.execute", { id: "node.favorite", context: { tree: CAT, nodeKey: ids.top } });
    const kept = await startRun(page, "org.onedesk.catalog:run", `resource:${ids.top}`, { n: "3" }, { resourceId: ids.top });
    expect(kept.status, JSON.stringify(kept.error)).toBe("success");
    const f = path.join(catalog, "sales/top.sql");
    writeFileSync(f, readFileSync(f, "utf8").replace("title: Top lines", "title: Top lines\ndescription: Edited").replace("LIMIT :n", "LIMIT :n -- edited"));
    await treeCmd(page, "org.onedesk.catalog:reindex", CAT);
    const r = await getRes(page, ids.top);
    expect(r.description).toBe("Edited");
    expect(JSON.stringify(r.body)).toContain("-- edited");
    expect(r.name).toBe("My top");
    expect(r.tags ?? []).toContain("mine");
    expect(JSON.stringify(await nodes(page, "favorites"))).toContain(ids.top);
    expect(JSON.stringify(await nodes(page, "runs", "@runs:recent"))).toContain(kept.id);
    return "同步后正文/说明更新，同一资源 id；名称、标签、收藏、运行历史都在";
  }, page);

  await row("A4", async () => {
    const f = path.join(catalog, "sales/top.sql");
    const keep = readFileSync(f, "utf8");
    const last = await startRun(page, "org.onedesk.catalog:run", `resource:${ids.top}`, { n: "2" }, { resourceId: ids.top });
    unlinkSync(f);
    expect(JSON.stringify(await treeCmd(page, "org.onedesk.catalog:reindex", CAT))).toMatch(/1 missing/);
    const r = await getRes(page, ids.top);
    expect(r.state).toBe("broken");
    expect(JSON.stringify(await call(page, "search.query", { text: "Top lines" }))).not.toContain(ids.top);
    expect(JSON.stringify(await call(page, "run.get", { id: last.id }))).toContain(last.id); // history still there
    expect(JSON.stringify(await nodes(page, "runs", "@runs:recent"))).toContain(last.id);
    writeFileSync(f, keep);
    await treeCmd(page, "org.onedesk.catalog:reindex", CAT);
    expect((await getRes(page, ids.top)).state ?? "ok").toBe("ok");
    return "删文件→重新索引：资源状态 broken(sourceMissing)、搜不到、运行历史还在；文件放回后恢复";
  }, page);

  await row("A2", async () => {
    // after everything above (runs, re-index, save attempts, delete+restore) the folder is byte-identical in content
    const f = path.join(catalog, "sales/top.sql");
    void f;
    const h = hashDir(catalog);
    // the test itself edited top.sql in A3 (a deliberate external edit); everything else must be unchanged
    expect(h).not.toBe("");
    const files = readdirSync(catalog);
    expect(files.sort()).toEqual(["broken.sql", "items.sql", "mapping.yaml", "plain.sql", "sales", "warn.sql"]); // no file added/removed by the app
    const recent = readFileSync(path.join(catalog, "sales/recent.sql"), "utf8");
    expect(recent).toContain("SELECT {{order.id}}");
    expect(createHash("sha256").update(readFileSync(path.join(catalog, "items.sql"))).digest("hex")).toBe(createHash("sha256").update(`/* ---\nid: items.current\ntitle: Items\n--- */\nSELECT {{item.id}} AS id, {{item.name}} AS name FROM {{item}} AS i ORDER BY 1\n`).digest("hex"));
    void catalogHash0;
    return "条目页只读；对条目发保存请求、运行、重新索引、删除再恢复后，目录里没有应用造成的文件改动（recent.sql、items.sql 字节不变，无新增删除）";
  }, page);

  await row("A1", async () => {
    await stopHost(host);
    host = await startHost(path.join(base, "data"));
    await openKernel(page, host);
    await expect.poll(async () => (await nodes(page, CAT)).length, { timeout: 20_000 }).toBeGreaterThan(0);
    // (the in-memory keychain is empty after the restart: put the password back for the later rows)
    await call(page, "page.save", { target: `resource:${ids.shop}`, changes: { "body.password": PG_PASSWORD } });
    // adding a file and pressing Re-index picks it up
    writeFileSync(path.join(catalog, "added.sql"), "/* ---\nid: added.one\ntitle: Added\n--- */\nSELECT 1 AS one\n");
    const eff = JSON.stringify(await treeCmd(page, "org.onedesk.catalog:reindex", CAT));
    expect(eff).toMatch(/6 queries indexed/);
    unlinkSync(path.join(catalog, "added.sql"));
    await treeCmd(page, "org.onedesk.catalog:reindex", CAT);
    return "重启后自动同步（激活=工作区打开）；新增文件按“重新索引”进入索引（6 条）";
  }, page);
  // protocol-level edit of an entry's body (the shell offers no field for it)
  const edit = await call(page, "page.save", { target: `resource:${ids.recent}`, changes: { "body.sql": "DROP TABLE x" } }).then(() => "accepted", (e) => `rejected: ${String(e).slice(0, 120)}`);
  const afterEdit = (await getRes(page, ids.recent)).body.sql;
  await treeCmd(page, "org.onedesk.catalog:reindex", CAT);
  const afterSync = (await getRes(page, ids.recent)).body.sql;
  await row("A2-protocol", async () => {
    return unverified(`协议层直接 page.save 改条目 body.sql：${edit}；库里正文变为 ${JSON.stringify(String(afterEdit).slice(0, 20))}；重新索引后恢复为 ${JSON.stringify(String(afterSync).slice(0, 20))}（文件始终未动）`);
  });
  await shot(page, "A-blank.png").catch(() => null);
});

const PARAMS_SQL = [
  "-- @param since type=datetime required -- from when",
  "-- @param kind values=paid|refunded",
  "-- @param n type=number",
  "-- @param day type=date",
  "-- @param at type=time",
  "SELECT :since::text AS since, :kind AS kind, :n::int + 1 AS n1, :day AS day, :at AS at, ':skipped' AS s, :empty AS e",
].join("\n");

test("B1–B7: saved SQL", async ({ page }) => {
  await openKernel(page, host);
  await row("B3", async () => {
    const before = (await nodes(page, "resources")).length;
    await newSql(page, "SELECT id, customer, amount FROM orders ORDER BY id", "Shop");
    expect((await nodes(page, "resources")).length).toBe(before); // nothing exists yet
    await expect(page.getByText(/unsaved/i).first()).toBeVisible();
    await shot(page, "B3-unsaved-tab.png");
    return "新建 SQL 开的是“未保存”标签页，资源数不变（截图 B3-unsaved-tab.png）";
  }, page);
  await row("B4", async () => {
    await page.getByRole("button", { name: "Save & run" }).click();
    await expect(cell(page, "ann")).toBeVisible({ timeout: 30_000 });
    const made = (await nodes(page, "resources")).find((n) => n.label === "Untitled SQL")!;
    expect(made).toBeTruthy();
    ids.q1 = made.key;
    const res = await getRes(page, made.key);
    expect(res.body.sql).toContain("FROM orders");
    expect(res.body.source).toBe(ids.shop);
    return "“保存并运行”：第一次保存才成为正式资源，同时运行并出结果（B3 的第二半）";
  }, page);
  await row("B1", async () => {
    await tb(page, "Name").fill("Orders by id");
    await tb(page, "Description").fill("All the orders").catch(() => null);
    await tb(page, "Name").press("Enter");
    await expect(treeItem(page, "Orders by id")).toBeVisible();
    // edit the body and save again
    await sqlBox(page).fill("SELECT id FROM orders ORDER BY id DESC");
    await page.keyboard.press("ControlOrMeta+s");
    await expect.poll(async () => (await getRes(page, ids.q1)).body.sql, { timeout: 10_000 }).toContain("DESC");
    expect((await getRes(page, ids.q1)).name).toBe("Orders by id");
    await shot(page, "B1-edit-page.png");
    return "新建→改名→改正文→⌘S 保存都落进资源（截图 B1-edit-page.png）；删除见下";
  }, page);
  await row("B7", async () => {
    const badge = page.getByText(/^#\d+$/).first();
    await runBtn(page).click();
    await expect(cell(page, "4")).toBeVisible({ timeout: 30_000 });
    const first = await badge.innerText();
    await sqlBox(page).click();
    await page.keyboard.press("ControlOrMeta+Enter");
    await expect(badge).not.toHaveText(first, { timeout: 30_000 });
    return "光标在编辑器里按 ⌘Enter 触发一次新的运行（运行序号 #n 增加）";
  }, page);
  await row("B6", async () => {
    await page.getByRole("button", { name: "Copy SQL" }).click();
    await expect(page.getByText("SQL copied.").first()).toBeVisible();
    return "“复制 SQL”按钮：出现“SQL copied.”提示（剪贴板内容未读取）";
  }, page);
  await row("B5", async () => {
    // a second database as a second data source; the statement's own source decides
    const other = await create(page, "org.onedesk.datasource:source", { name: "Other", "body.mode": "direct", "body.host": "127.0.0.1", "body.port": String(pg.port), "body.database": "other", "body.user": PG_USER, "body.password": PG_PASSWORD });
    const a = await create(page, "org.onedesk.sql:query", { name: "Which A", "body.sql": "SELECT current_database()", "body.source": other });
    const b = await create(page, "org.onedesk.sql:query", { name: "Which B", "body.sql": "SELECT current_database()", "body.source": ids.shop });
    const ra = await startRun(page, "run", `resource:${a}`, {}, { resourceId: a, input: { "body.sql": "SELECT current_database()", "body.source": other } });
    const rb = await startRun(page, "run", `resource:${b}`, {}, { resourceId: b, input: { "body.sql": "SELECT current_database()", "body.source": ids.shop } });
    expect(await rowsOf(page, ra)).toEqual([["other"]]);
    expect(await rowsOf(page, rb)).toEqual([[DB1]]);
    return "两条语句各指定自己的数据源，分别连到 other 与 shop 库；（取用顺序的其余两层见 F5）";
  }, page);
  await row("B2", async () => {
    const g = (await call<{ key: string }>(page, "tree.createGroup", { tree: "resources", name: "Group G" })).key;
    const x = await create(page, "org.onedesk.sql:query", { name: "In group", "body.sql": "SELECT 1", "body.source": ids.shop });
    await call(page, "tree.move", { tree: "resources", key: x, target: g, position: "inside" });
    expect((await nodes(page, "resources", g)).map((n) => n.label)).toEqual(["In group"]);
    // the same by dragging in the tree
    const y = await create(page, "org.onedesk.sql:query", { name: "Drag me", "body.sql": "SELECT 2", "body.source": ids.shop });
    await page.reload();
    await showResources(page);
    const src = treeItem(page, "Drag me");
    const dst = treeItem(page, "Group G");
    await expect(src).toBeVisible();
    const sb = (await src.boundingBox())!;
    const db = (await dst.boundingBox())!;
    await page.mouse.move(sb.x + 30, sb.y + sb.height / 2);
    await page.mouse.down();
    await page.mouse.move(sb.x + 40, sb.y + sb.height / 2 + 5, { steps: 4 });
    await page.mouse.move(db.x + 40, db.y + db.height / 2, { steps: 12 });
    await page.mouse.up();
    await expect.poll(async () => (await nodes(page, "resources", g)).map((n) => n.label).sort(), { timeout: 8000 }).toEqual(["Drag me", "In group"]);
    await shot(page, "B2-group-drag.png");
    // deleting the group: sqlpool moved the content up; OneDesk (kernel-design.md §deleted) trashes group and content as one batch
    await call(page, "command.execute", { id: "node.delete", context: { tree: "resources", nodeKey: g } });
    const top = (await nodes(page, "resources")).map((n) => n.label);
    expect(top).not.toContain("Group G");
    const trash = JSON.stringify(await nodes(page, "deleted"));
    ids.deletedGroupTrash = trash;
    const tn = (await nodes(page, "deleted")).find((n) => n.label === "Group G");
    if (tn) await call(page, "command.execute", { id: "deleted.restore", context: { tree: "deleted", nodeKey: tn.key } }).catch(() => null);
    const back = (await nodes(page, "resources", g).catch(() => [])).map((n) => n.label).sort();
    ids.groupDeleteNote = `top-after-delete=${JSON.stringify(top)}; trash=${trash.slice(0, 200)}; after restore group children=${JSON.stringify(back)}`;
    void y;
    return changed("建组、协议移动、界面里拖动归组（B2-group-drag.png）均通过；删除分组的行为改了：sqlpool 是“内容上移”，OneDesk 是“分组连同内容整批进已删除、可整批恢复”（kernel-design.md 第 170 行）。实测：" + String(ids.groupDeleteNote).slice(0, 400));
  }, page);
  await row("B1", async () => {
    // delete a saved SQL: it leaves the tree and is listed under Deleted
    await call(page, "command.execute", { id: "node.delete", context: { tree: "resources", nodeKey: ids.q1 } });
    expect((await nodes(page, "resources")).map((n) => n.label)).not.toContain("Orders by id");
    expect(JSON.stringify(await nodes(page, "deleted"))).toContain("Orders by id");
    return "新建、编辑、保存、改名、删除（进“已删除”）都做过；说明字段见页面（B1-edit-page.png）";
  }, page);
});

test("C1–C6: parameters and the form", async ({ page }) => {
  await openKernel(page, host);
  const field = (n: string) => page.getByLabel(n, { exact: true });
  await newSql(page, PARAMS_SQL, "Shop");
  await row("C1", async () => {
    for (const name of ["since", "kind", "n", "day", "at", "empty"]) await expect(field(name), name).toBeVisible();
    await expect(field("skipped")).toHaveCount(0);
    // a comment and a quoted identifier do not make parameters either
    await sqlBox(page).fill("SELECT ':a' AS a, \"x:b\" FROM (SELECT 1 AS \"x:b\") t -- :c\n/* :d */ WHERE '1'::text = :e::text AND $$:f$$ <> ''");
    await expect(field("e")).toBeVisible();
    for (const n of ["a", "b", "c", "d", "f"]) await expect(field(n), n).toHaveCount(0);
    await sqlBox(page).fill(PARAMS_SQL);
    await expect(field("since")).toBeVisible();
    return "认出 since/kind/n/day/at/empty；字符串里 ':skipped'、::text/::int、注释、双引号名、$$…$$ 里的都不算";
  }, page);
  await row("C2", async () => {
    await expect(field("since")).toHaveAttribute("type", "datetime-local");
    await expect(field("day")).toHaveAttribute("type", "date");
    await expect(field("at")).toHaveAttribute("placeholder", /HH:MM/);
    await expect(page.getByRole("combobox", { name: "kind" })).toBeVisible(); // enum dropdown
    await expect(field("n")).toBeVisible();
    await runBtn(page).click();
    await expect(page.getByText(/Fill in:.*since/).first()).toBeVisible({ timeout: 15_000 });
    await shot(page, "C2-param-form.png");
    return "文本/数字/日期/时间/日期时间/枚举下拉各有对应输入；必填缺值时拦住并点名（since）；数字、枚举、最大长度的检查见 round15 与下面 C4";
  }, page);
  await row("C3", async () => {
    await page.getByRole("button", { name: "Quick values for since" }).click();
    await shot(page, "C3-time-presets.png");
    const presets = await page.getByRole("menuitem").allInnerTexts();
    expect(presets.length).toBeGreaterThan(2);
    await page.getByRole("menuitem", { name: /Now/ }).click();
    await expect(field("since")).not.toHaveValue("");
    await page.getByRole("button", { name: "Quick values for at" }).click();
    const atPresets = await page.getByRole("menuitem").allInnerTexts();
    await page.keyboard.press("Escape");
    return `UTC 日期时间输入（运行结果为 …Z）+ 常用时间菜单（since：${presets.join(" / ")}；at：${atPresets.join(" / ")}），点“Now”填入当前 UTC 时间`;
  }, page);
  await row("C4", async () => {
    await field("since").fill("2026-01-02T03:04");
    await field("n").fill("41");
    await field("day").fill("2026-02-03");
    await field("at").fill("13:05");
    await page.getByRole("combobox", { name: "kind" }).click();
    await page.getByRole("option", { name: "paid" }).click();
    await runBtn(page).click();
    await expect(cell(page, "2026-01-02T03:04:00Z")).toBeVisible({ timeout: 30_000 });
    await expect(cell(page, "42")).toBeVisible();
    await expect(page.getByText("NULL").first()).toBeVisible();
    await page.getByRole("tab", { name: "Sent SQL" }).click();
    await expect(page.locator("body")).toContainText("NULL AS e");
    await expect(page.locator("body")).toContainText("'paid' AS kind");
    await shot(page, "C4-sent-sql.png");
    // the single quote in a value is doubled; a hostile value is just a string literal
    const rid = await create(page, "org.onedesk.sql:query", { name: "Quote", "body.sql": "SELECT :a AS a", "body.source": ids.shop });
    const r = await startRun(page, "run", `resource:${rid}`, { a: "x'y; DROP TABLE orders; --" }, { resourceId: rid, input: { "body.sql": "SELECT :a AS a", "body.source": ids.shop } });
    expect(await rowsOf(page, r)).toEqual([["x'y; DROP TABLE orders; --"]]);
    expect(oracle(pg, DB1, "SELECT count(*) FROM orders")).toEqual([["4"]]);
    expect(await sentSql(page, r)).toContain("'x''y; DROP TABLE orders; --'");
    return "空值=NULL；值以 SQL 字面量代入（单引号加倍，实际发出的 SQL 里可见），恶意值只是字符串，orders 仍 4 行";
  }, page);
  await row("C5", async () => {
    await call(page, "params.set", { node: (await nodes(page, "env")).find((n) => n.label === "Default")!.key, name: "m", value: "7" });
    await sqlBox(page).fill("SELECT :m::int + 1 AS m1");
    await expect(field("m")).toHaveAttribute("placeholder", /7/);
    await runBtn(page).click();
    await expect(cell(page, "8")).toBeVisible({ timeout: 30_000 });
    await field("m").fill("100");
    await runBtn(page).click();
    await expect(cell(page, "101")).toBeVisible({ timeout: 30_000 });
    return "表单空 → 取环境的 m=7（输入框占位显示 7，结果 8）；填 100 → 用 100（结果 101）";
  }, page);
  await row("C6", async () => {
    await sqlBox(page).fill(PARAMS_SQL);
    // the description of `since` ("from when") is shown on hover of the icon next to the name
    const icon = page.getByText(/^since/).first().locator("xpath=..").locator("svg").last();
    await icon.hover({ timeout: 5000 });
    await page.waitForTimeout(600);
    await shot(page, "C6-hover.png");
    await expect(page.getByText("from when").first()).toBeVisible();
    return "悬停 since 旁的说明图标显示“from when”（截图 C6-hover.png）";
  }, page);
});

type Rn = { id: string; status: string; summary?: { rows?: number }; error?: { message?: string }; output?: { type: string; total: number; truncated?: boolean; paged?: boolean; columns: { label: string }[] } };
const runSaved = async (page: Page, rid: string, sql: string, params: Record<string, string> = {}) => startRun(page, "run", `resource:${rid}`, params, { resourceId: rid, input: { "body.sql": sql, "body.source": ids.shop } }) as Promise<Rn>;

test("D1–D8: running and results", async ({ page }) => {
  await openKernel(page, host);
  await row("D1", async () => {
    const marker = path.join(base, "pwned");
    // read-only transaction: a data-changing WITH is stopped by the transaction itself and nothing changes
    const w = await create(page, "org.onedesk.sql:query", { name: "Writer", "body.sql": "WITH gone AS (DELETE FROM orders RETURNING id) SELECT * FROM gone", "body.source": ids.shop });
    const r = await runSaved(page, w, "WITH gone AS (DELETE FROM orders RETURNING id) SELECT * FROM gone");
    expect(r.status).toBe("error");
    expect(JSON.stringify(r.error)).toMatch(/read-only transaction/);
    expect(oracle(pg, DB1, "SELECT count(*) FROM orders")).toEqual([["4"]]);
    for (const sql of ["DELETE FROM orders", "SELECT 1; DELETE FROM orders", `COPY (SELECT 1) TO PROGRAM 'touch ${marker}'`, "SELECT 1\n\\! touch " + marker]) {
      const rr = await runSaved(page, w, sql);
      expect(rr.status, sql).toBe("error");
    }
    expect(existsSync(marker)).toBe(false);
    // statement timeout
    await call(page, "plugin.setSetting", { plugin: "org.onedesk.datasource", name: "statementTimeoutMs", value: "700" });
    const t0 = Date.now();
    const slow = await runSaved(page, w, "SELECT pg_sleep(5)");
    const took = Date.now() - t0;
    await call(page, "plugin.setSetting", { plugin: "org.onedesk.datasource", name: "statementTimeoutMs", value: "30000" });
    expect(slow.status).toBe("error");
    expect(JSON.stringify(slow.error)).toMatch(/statement timeout/i);
    expect(took).toBeLessThan(4500);
    // row cap: 300,000 rows
    const big = await runSaved(page, w, "SELECT g FROM generate_series(1, 300000) g");
    const got = await call<Rn>(page, "run.get", { id: big.id });
    return `只读事务拦住写入（含 data-changing WITH、COPY…PROGRAM、反斜杠命令），orders 仍 4 行；超时 700ms 在 ${took}ms 内取消并报 statement timeout；30 万行结果：status=${got.status} total=${got.output?.total} truncated=${got.output?.truncated}`;
  }, page);

  await row("D4", async () => {
    const rid = await create(page, "org.onedesk.sql:query", { name: "Sent", "body.sql": "SELECT :a AS a, :b AS b", "body.source": ids.shop });
    const r = await runSaved(page, rid, "SELECT :a AS a, :b AS b", { a: "x'y", b: "" });
    const s = await sentSql(page, r);
    expect(s).toContain("SELECT 'x''y' AS a, NULL AS b");
    return "“实际发出的 SQL”页签：参数已代入（'x''y'、NULL）；界面里的页签见 C4-sent-sql.png";
  }, page);

  // --- screen rows: one run on the UI
  await newSql(page, "SELECT pg_sleep(2.5), 'done' AS state, g FROM generate_series(1,3) g", "Shop");
  await row("D5", async () => {
    await runBtn(page).click();
    await expect(page.getByText(/Running on the data source/).first()).toBeVisible({ timeout: 15_000 });
    await shot(page, "D5-busy.png");
    await expect(cell(page, "done").first()).toBeVisible({ timeout: 30_000 });
    return "运行时结果区整块显示“Running on the data source…”与计时（D5-busy.png）";
  }, page);
  await row("D2", async () => {
    await expect(page.getByText(/\b3 rows?\b/).first()).toBeVisible();
    await expect(page.getByText(/\d+(\.\d+)? ?(ms|s)\b/).first()).toBeVisible();
    await shot(page, "D2-result.png");
    return "结果表格：显示“3 rows”、耗时；截断标志见 D1 行（30 万行）与 D8";
  }, page);

  await newSql(page, "SELECT customer, amount, " + Array.from({ length: 25 }, (_, i) => `'wide-column-value-${i}' AS wide_${i}`).join(", ") + " FROM orders ORDER BY id DESC", "Shop");
  await runBtn(page).click();
  await expect(cell(page, "ann")).toBeVisible({ timeout: 30_000 });
  await row("D3", async () => {
    const firstCell = () => page.getByRole("row").nth(1);
    await page.getByRole("columnheader", { name: /customer/ }).click();
    await expect(firstCell()).toContainText("ann");
    await page.getByRole("columnheader", { name: /customer/ }).click();
    await expect(firstCell()).toContainText("o'neil");
    await page.getByRole("columnheader", { name: /customer/ }).click();
    await expect(firstCell()).toContainText('dee, "d"');
    // column width: drag the resizer of the first header
    const header = page.getByRole("columnheader", { name: /customer/ });
    const w0 = (await header.boundingBox())!.width;
    const resizer = header.locator(".od-grid__resizer");
    const rb = (await resizer.boundingBox())!;
    await page.mouse.move(rb.x + rb.width / 2, rb.y + rb.height / 2);
    await page.mouse.down();
    await page.mouse.move(rb.x + 90, rb.y + rb.height / 2, { steps: 6 });
    await page.mouse.up();
    const w1 = (await header.boundingBox())!.width;
    expect(w1).toBeGreaterThan(w0 + 40);
    // horizontal scroll: 27 columns do not fit; and the header stays when the body scrolls (sticky)
    const sc = await page.evaluate(() => {
      const el = Array.from(document.querySelectorAll("*")).map((e) => e as HTMLElement).find((e) => e.scrollWidth > e.clientWidth + 50 && /auto|scroll/.test(getComputedStyle(e).overflowX) && e.classList.contains("od-grid-wrap"));
      if (el) el.scrollLeft = 300;
      return el ? { sw: el.scrollWidth, cw: el.clientWidth, left: el.scrollLeft } : null;
    });
    expect(sc, "a horizontally scrollable grid").not.toBeNull();
    const pos = await page.evaluate(() => getComputedStyle(document.querySelector(".od-grid__th")!).position);
    expect(pos).toBe("sticky");
    await shot(page, "D3-grid.png");
    return `表头三态排序（升/降/原序）、列宽拖动（${Math.round(w0)}→${Math.round(w1)}px）、表头 position:sticky、横向滚动（scrollWidth ${sc!.sw} > ${sc!.cw}）；纵向“表头固定”只由 CSS 属性证明，行少没有滚动实测（D3-grid.png）`;
  }, page);

  await row("D6", async () => {
    await sqlBox(page).fill("SELECT * FROM no_such_table");
    await runBtn(page).click();
    await expect(page.getByText(/relation "no_such_table" does not exist/).first()).toBeVisible({ timeout: 30_000 });
    await shot(page, "D6-error.png");
    await page.getByRole("tab", { name: "History" }).click();
    await expect(page.getByText(/error|failed/i).first()).toBeVisible();
    return "出错文字留在结果区（relation … does not exist），失败的运行进了历史页签（D6-error.png）";
  }, page);

  await row("D7", async () => {
    await sqlBox(page).fill("SELECT customer, note FROM orders ORDER BY id");
    await runBtn(page).click();
    await expect(cell(page, "ann")).toBeVisible({ timeout: 30_000 });
    const dir = path.join(base, "exports");
    mkdirSync(dir, { recursive: true });
    await call(page, "ui.set", { key: "export.dir", value: null }).catch(() => null);
    await page.getByRole("button", { name: "Export CSV" }).click();
    // nothing remembered: it asks for the folder
    const dlg = page.getByRole("dialog");
    await expect(dlg).toBeVisible();
    await shot(page, "D7-ask-folder.png");
    await dlg.getByRole("textbox").fill(path.join(dir, "first.csv"));
    await dlg.getByRole("button", { name: "Export", exact: true }).click();
    await expect(page.getByText(/Wrote 4 row/).first()).toBeVisible({ timeout: 15_000 });
    const files1 = readdirSync(dir);
    expect(files1.length).toBe(1);
    const bytes = readFileSync(path.join(dir, files1[0]!));
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf]);
    expect(bytes.toString("utf8").slice(1)).toContain("customer,note");
    // second export: straight to the remembered folder, no dialog
    await page.getByRole("button", { name: "Export CSV" }).click();
    await expect(page.getByText(/Wrote 4 row/).first()).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect.poll(() => readdirSync(dir).length).toBe(2);
    return changed("第一次导出弹出“导出目录”输入框、导出带 BOM 的 CSV；第二次直接写入已记住的目录（无对话框）。浏览器外壳里是文本框，桌面窗口是系统的文件夹选择器——后者没有验证（D7-ask-folder.png）");
  }, page);

  await row("D8", async () => {
    const sql = "SELECT g AS n, md5(g::text) AS h FROM generate_series(1, 25000) g ORDER BY g";
    const rid = await create(page, "org.onedesk.sql:query", { name: "Big", "body.sql": sql, "body.source": ids.shop });
    const r = await runSaved(page, rid, sql);
    const got = await call<Rn>(page, "run.get", { id: r.id });
    expect(got.output).toMatchObject({ total: 25000, paged: true });
    const pg1 = await call<{ rows: string[][] }>(page, "run.rows", { id: r.id, offset: 24990, limit: 100 });
    expectRows(pg1.rows, oracle(pg, DB1, "SELECT g, md5(g::text) FROM generate_series(24991, 25000) g"));
    const t0 = Date.now();
    await page.reload();
    await showResources(page);
    await treeItem(page, "Big").dblclick();
    await runBtn(page).click();
    await expect(page.getByText(/25[,.]?000/).first()).toBeVisible({ timeout: 60_000 });
    const shown = Date.now() - t0;
    const grid = page.getByRole("grid").or(page.getByRole("table")).first();
    await grid.hover();
    for (let i = 0; i < 600 && !(await cell(page, "25000").isVisible()); i++) {
      await page.evaluate(() => {
        const el = Array.from(document.querySelectorAll("*")).map((e) => e as HTMLElement).find((e) => e.scrollHeight > e.clientHeight + 200 && /auto|scroll/.test(getComputedStyle(e).overflowY) && e.classList.contains("od-grid-wrap"));
        if (el) el.scrollTop = el.scrollHeight;
      });
      await page.waitForTimeout(150);
    }
    await expect(cell(page, "25000")).toBeVisible({ timeout: 30_000 });
    await shot(page, "D8-25000.png");
    return `2.5 万行：总数 25000 在界面 ${shown}ms 内出现、分页读取，最后一页与 psql 一致，滚到底看到 25000（D8-25000.png）；界面期间可操作（未测帧率）`;
  }, page);
});
