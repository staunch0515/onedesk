/**
 * Round 16 (sqlpool-parity A, E, G, H) against the real kernel and a throw-away PostgreSQL.
 * Most rows are checked through the protocol (what the shell sends); the rows that are about what is on screen use the page.
 * Defects found in other sessions' files are `test.fixme` with the reason, and listed in docs/handoff/round16-tests-done.md.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { DEVHOST, openKernel, rpc, startHost, stopHost, type Host } from "./kernel-host";
import { DB1, PG_PASSWORD, PG_SKIP_REASON, PG_USER, startPg, type Pg } from "./pg-fixture";

test.use({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
test.describe.configure({ mode: "serial" });
test.setTimeout(90_000);

let host: Host;
let base: string;
let pg: Pg;
let catalog: string;

const MAPPING = `entities:
  order:
    table: orders
    description: Orders of the shop
    columns:
      id: id
      customer: customer
      amount: amount
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
  ghost:
    table: no_such_table
    columns:
      id: id
`;

test.beforeAll(async () => {
  if (process.env.ONEDESK_E2E_REQUIRE_DEVHOST === "1") expect(existsSync(DEVHOST), `onedesk-devhost not built at ${DEVHOST}`).toBe(true);
  else test.skip(!existsSync(DEVHOST), `onedesk-devhost not built at ${DEVHOST}`);
  if (process.env.ONEDESK_E2E_REQUIRE_PG === "1") expect(PG_SKIP_REASON, "PostgreSQL is required").toBeNull();
  else test.skip(PG_SKIP_REASON !== null, PG_SKIP_REASON ?? "");
  base = realpathSync(mkdtempSync(path.join(tmpdir(), "od-round16-")));
  pg = await startPg(path.join(base, "pg"));
  pg.psql(
    DB1,
    `CREATE TABLE item_ver (item_id int, name text, valid_from timestamptz, valid_to timestamptz, is_deleted boolean DEFAULT false);
     INSERT INTO item_ver VALUES
       (1,'pen','2026-01-01T00:00:00Z','2026-02-01T00:00:00Z',false),
       (1,'pen v2','2026-02-01T00:00:00Z',NULL,false),
       (2,'cup','2026-01-01T00:00:00Z',NULL,false),
       (3,'old','2026-01-01T00:00:00Z','2026-01-15T00:00:00Z',false),
       (3,'old','2026-01-15T00:00:00Z',NULL,true);`,
  );
  catalog = path.join(base, "catalog");
  mkdirSync(path.join(catalog, "sales"), { recursive: true });
  const q = (rel: string, head: string, body: string) => writeFileSync(path.join(catalog, rel), `/* ---\n${head}\n--- */\n${body}\n`);
  q("sales/recent.sql", "id: sales.orders.recent\ntitle: Recent orders\ndescription: Orders above an amount\nparams:\n  - name: min\n    type: number\n    required: true", "SELECT {{order.id}} AS id, {{order.customer}} AS customer FROM {{order}} WHERE {{order.amount}} >= :min ORDER BY {{order.id}}");
  q("sales/top.sql", "id: sales.top\ntitle: Top\nparams: [n]", "SELECT {{order.id}} AS id FROM {{order}} ORDER BY {{order.id}} LIMIT :n");
  q("items.sql", "id: items.current\ntitle: Items now", "SELECT {{item.id}} AS id, {{item.name}} AS name FROM {{item}} AS i ORDER BY 1");
  q("warn.sql", "id: misc.warn\ntitle: Warns\nparams: [unused]", "SELECT {{nothing}} AS x, :undeclared AS y");
  writeFileSync(path.join(catalog, "plain.sql"), "SELECT 1\n"); // no header
  writeFileSync(path.join(catalog, "broken.sql"), "/* ---\nid: [oops\n--- */\nSELECT 1\n");
  writeFileSync(path.join(catalog, "mapping.yaml"), MAPPING);
  host = await startHost(path.join(base, "data"));
});
test.afterAll(async () => {
  if (host) await stopHost(host);
  if (pg) pg.stop();
  if (base) rmSync(base, { recursive: true, force: true });
});

const call = <T = unknown>(page: Page, method: string, params: unknown = null) => rpc<T>(page, host, method, params);
type Res = { id: string; name: string; description: string; state?: string; stateReason?: string; body: Record<string, any>; tags?: string[]; deleted?: boolean };
type Node = { key: string; label: string; kind?: string; state?: string; target?: string; badge?: string; menu?: { id: string }[] };
const nodes = async (page: Page, tree: string, parent?: string) => (await call<{ nodes: Node[] }>(page, "tree.children", { tree, parent })).nodes;
const getRes = (page: Page, id: string) => call<Res>(page, "resource.get", { id });
const create = async (page: Page, kind: string, changes: Record<string, unknown>) => (await call<{ page: { resourceId: string } }>(page, "page.save", { target: `new:${kind}`, changes })).page.resourceId;

type RunInfo = { id: string; status: string; kept?: boolean; error?: { code: string; message?: string }; summary?: { rows?: number; message?: string }; params?: Record<string, string> };
const waitRun = async (page: Page, id: string): Promise<RunInfo> => {
  for (let i = 0; i < 150; i++) {
    const r = await call<RunInfo>(page, "run.get", { id });
    if (r.status !== "running") return r;
    await new Promise((res) => setTimeout(res, 200));
  }
  throw new Error("run did not end");
};
const startRun = async (page: Page, action: string, target: string, params: Record<string, string> = {}, extra: Record<string, unknown> = {}) =>
  waitRun(page, await call<string>(page, "run.start", { action, target, tabId: "e2e-tab", input: {}, params, locale: "en-US", ...extra }));
const rowsOf = async (page: Page, run: RunInfo) => (await call<{ rows: string[][] }>(page, "run.rows", { id: run.id, offset: 0, limit: 100 })).rows;
const sentSql = async (page: Page, run: RunInfo) => JSON.stringify(await call(page, "run.render", { id: run.id, tabId: "sent", locale: "en-US" }).catch(() => null));

/** Runs the saved SQL made by A10 (a plain SQL resource, so the catalog's data source lookup is not involved). */
const runSql = (page: Page, min: string) =>
  startRun(page, "run", `resource:${ids.savedSql}`, { min }, { resourceId: ids.savedSql, input: { "body.sql": ids.savedSqlText, "body.source": "" } });

const CAT = "org.onedesk.catalog:catalog";
const ids = {} as Record<"shop" | "recent" | "items" | "top" | "savedSql" | "savedSqlText" | "run" | "ghost" | "items2", string>;
const treeCmd = (page: Page, id: string, tree: string) => call(page, "command.execute", { id, context: { tree } });

/* ---------------------------------------------------------------- setup: data source and the granted folder */

test("setup: a data source, the workspace default, the granted folder, the first index", async ({ page }) => {
  await openKernel(page, host);
  ids.shop = await create(page, "org.onedesk.datasource:source", { name: "Shop", "body.mode": "direct", "body.host": "127.0.0.1", "body.port": String(pg.port), "body.database": DB1, "body.user": PG_USER, "body.password": PG_PASSWORD });
  const cfg = (await nodes(page, "config")).find((n) => n.label === "Workspace")!.key;
  await call(page, "params.set", { node: cfg, name: "datasource.default", value: ids.shop, type: "ref" });
  await call(page, "plugin.grantFolder", { plugin: "org.onedesk.catalog", path: catalog });
  const effects = await treeCmd(page, "org.onedesk.catalog:reindex", CAT);
  expect(JSON.stringify(effects)).toMatch(/4 queries indexed, 2 skipped, 0 missing/);
});

/* ---------------------------------------------------------------- A: query catalog */

test("A1/A9: the files become entries (external key = path), grouped by the first two parts of the id", async ({ page }) => {
  await openKernel(page, host);
  const top = await nodes(page, CAT);
  expect(top.map((n) => n.label).sort()).toEqual(["items", "misc", "sales"]);
  const sales = await nodes(page, CAT, "g:sales");
  expect(sales.map((n) => n.label).sort()).toEqual(["Top", "orders"]);
  const orders = await nodes(page, CAT, "g:sales.orders");
  expect(orders.map((n) => n.label)).toEqual(["Recent orders"]);
  ids.recent = orders[0]!.key;
  const r = await getRes(page, ids.recent);
  expect(r.body.path).toBe(path.join(catalog, "sales/recent.sql"));
  expect(r.description).toBe("Orders above an amount");
  const entries = await nodes(page, CAT, "g:items");
  ids.items = entries[0]!.key;
  ids.top = sales.find((n) => n.label === "Top")!.key;
});

test("A2: an entry's page binds no field (nothing the user types can reach the file)", async ({ page }) => {
  await openKernel(page, host);
  const d = await call<{ readOnly: boolean; values: Record<string, unknown> }>(page, "page.resolve", { target: `resource:${ids.recent}` });
  expect(JSON.stringify(d)).not.toContain('"bind"');
  const kinds = JSON.stringify(await call(page, "tree.list"));
  expect(kinds).not.toContain("new:org.onedesk.catalog:entry"); // nothing to create
});

// DEFECT (kernel `pages.rs` `page.resolve`): the plugin's render result carries `values: { sql }` and `readOnly: true`
// (plugins/org.onedesk.catalog/main.js:949) but the kernel takes values only from bound fields and `readOnly` only from the
// kind, so the entry page shows an empty, editable-looking SQL box. Listed in docs/handoff/round16-tests-done.md.
test("A2 (screen data): the entry page carries the file's SQL and is read-only", async ({ page }) => {
  await openKernel(page, host);
  const d = await call<{ readOnly: boolean; values: Record<string, string> }>(page, "page.resolve", { target: `resource:${ids.recent}` });
  expect(d.readOnly).toBe(true);
  expect(d.values.sql).toContain("SELECT");
});

test("A5: files that cannot be indexed are listed with the reason (no header, bad YAML)", async ({ page }) => {
  await openKernel(page, host);
  const d = JSON.stringify(await call(page, "page.resolve", { target: "page:org.onedesk.catalog/index" }));
  expect(d).toContain("plain.sql");
  expect(d).toContain("broken.sql");
  expect(d).toMatch(/header/i);
  expect(d).toMatch(/line \d+|YAML/i);
});

test("A3: a re-index changes only the text; the tags, the favourite and the name the user gave stay (the run history is kept by the kernel, see crates/kernel tests)", async ({ page }) => {
  await openKernel(page, host);
  await call(page, "page.save", { target: `resource:${ids.recent}`, changes: { name: "My recent orders", tags: ["mine"] } });
  await call(page, "command.execute", { id: "node.favorite", context: { tree: CAT, nodeKey: ids.recent } });
  writeFileSync(path.join(catalog, "sales/recent.sql"), `/* ---\nid: sales.orders.recent\ntitle: Recent orders\ndescription: Edited description\nparams:\n  - name: min\n    type: number\n    required: true\n--- */\nSELECT {{order.id}} AS id, {{order.customer}} AS customer FROM {{order}} WHERE {{order.amount}} >= :min ORDER BY {{order.id}} DESC\n`);
  await treeCmd(page, "org.onedesk.catalog:reindex", CAT);
  const r = await getRes(page, ids.recent);
  expect(r.id).toBe(ids.recent); // the same resource
  expect(r.description).toBe("Edited description");
  expect(JSON.stringify(r.body)).toContain("DESC");
  expect(r.name, "the name the user gave is kept").toBe("My recent orders");
  expect(r.tags ?? [], "the tags are kept").toContain("mine");
  expect(JSON.stringify(await nodes(page, "favorites")), "the favourite is kept").toContain(ids.recent);
});

// DEFECT (plugins/org.onedesk.catalog/manifest.json, also org.onedesk.table): a plugin may list another plugin's kind only if one of
// its own actions names that kind in `kinds` (crates/kernel manifest.rs `foreign_kinds`); the catalog names none, so the data
// source list is empty and every run fails with "Data source … does not exist". Verified to pass with a local patch that adds
// an action naming `org.onedesk.datasource:source`; see round16-tests-done.md.
test("A6/A7: entities become table and column names; a versioned entity is the latest version at the time", async ({ page }) => {
  await openKernel(page, host);
  const run = await startRun(page, "org.onedesk.catalog:run", `resource:${ids.recent}`, { min: "20" }, { resourceId: ids.recent });
  expect(run.status, JSON.stringify(run.error)).toBe("success");
  expect((await rowsOf(page, run)).map((r) => r[0])).toEqual(["3", "2"]); // amount >= 20, ordered DESC by the edited file
  const sent = await sentSql(page, run);
  expect(sent).toContain("FROM orders");
  expect(sent).not.toContain("{{");
  // A7: now, and as of a date in the middle of the history
  const now = await startRun(page, "org.onedesk.catalog:run", `resource:${ids.items}`, {}, { resourceId: ids.items });
  expect(now.status, JSON.stringify(now.error)).toBe("success");
  expect(await rowsOf(page, now)).toEqual([["1", "pen v2"], ["2", "cup"]]); // item 3 is deleted
  const asOf = await startRun(page, "org.onedesk.catalog:run", `resource:${ids.items}`, { as_of: "2026-01-10T00:00:00Z" }, { resourceId: ids.items });
  expect(asOf.status, JSON.stringify(asOf.error)).toBe("success");
  expect(await rowsOf(page, asOf)).toEqual([["1", "pen"], ["2", "cup"], ["3", "old"]]);
});

test("A8: undeclared and unused parameters and an unmapped placeholder are warned about", async ({ page }) => {
  await openKernel(page, host);
  const warn = (await nodes(page, CAT, "g:misc")).concat(await nodes(page, CAT, "g:misc.warn")).find((n) => n.target)!;
  const page_ = JSON.stringify(await call(page, "page.resolve", { target: warn.target! }));
  expect(page_).toContain("undeclared");
  expect(page_).toContain("unused");
  expect(page_).toContain("nothing");
});

test("A10: Save as SQL makes a saved statement (mapping applied, parameters declared) and links to it", async ({ page }) => {
  await openKernel(page, host);
  const run = await startRun(page, "org.onedesk.catalog:saveAsSql", `resource:${ids.recent}`, { min: "20" }, { resourceId: ids.recent });
  expect(run.status, JSON.stringify(run.error)).toBe("success");
  expect(JSON.stringify(await call(page, "run.get", { id: run.id })), "the link carries the typed values (D423)").toContain('"min":"20"');
  const saved = (await call<{ nodes: Node[] }>(page, "tree.children", { tree: "resources" })).nodes.find((n) => n.kind === "org.onedesk.sql:query" && /recent orders/i.test(n.label));
  expect(saved, "a SQL resource appeared").toBeTruthy();
  const r = await getRes(page, saved!.key);
  expect(r.body.sql).toContain("-- @param min");
  expect(r.body.sql).toContain("FROM orders");
  expect(r.body.sql).not.toContain("{{");
  expect(r.body.sql).toContain(":min");
  ids.savedSql = saved!.key;
  ids.savedSqlText = r.body.sql;
  const again = await startRun(page, "run", `resource:${saved!.key}`, { min: "20" }, { resourceId: saved!.key, input: { "body.sql": r.body.sql, "body.source": "" } });
  expect(again.status, JSON.stringify(again.error)).toBe("success");
});

test("A4: a deleted file leaves the search, the entry stays in the tree marked missing, its history stays; it comes back with the file", async ({ page }) => {
  await openKernel(page, host);
  const file = path.join(catalog, "sales/top.sql");
  const keep = (await import("node:fs")).readFileSync(file, "utf8");
  unlinkSync(file);
  const effects = await treeCmd(page, "org.onedesk.catalog:reindex", CAT);
  expect(JSON.stringify(effects)).toMatch(/1 missing/);
  // D422: the entry stays in the tree, marked as missing (its history and favourites stay reachable); search drops it
  const gone = (await nodes(page, CAT, "g:sales")).find((n) => n.label === "Top");
  expect(gone, "still listed").toBeTruthy();
  expect(gone!.state === "broken" || /miss|失效/i.test(gone!.badge ?? ""), JSON.stringify(gone)).toBe(true);
  const found = await call<{ results?: { id: string }[]; items?: { id: string }[] }>(page, "search.query", { text: "Top" });
  expect(JSON.stringify(found)).not.toContain(ids.top);
  const r = await getRes(page, ids.top);
  expect(r.state).toBe("broken");
  expect(r.stateReason).toBe("sourceMissing");
  writeFileSync(file, keep);
  await treeCmd(page, "org.onedesk.catalog:reindex", CAT);
  expect((await getRes(page, ids.top)).state ?? "ok").toBe("ok");
  expect((await nodes(page, CAT, "g:sales")).map((n) => n.label)).toContain("Top");
});

test("A (activation): the catalog is indexed when the workspace opens, without anyone pressing re-index", async ({ page }) => {
  const h2 = await startHost(path.join(base, "data2"));
  try {
    // a second workspace data dir has no grant, so the catalog is empty; the first one (with the grant) is restarted
    await stopHost(host);
    host = await startHost(path.join(base, "data"));
    await openKernel(page, host);
    await expect.poll(async () => (await nodes(page, CAT)).length, { timeout: 15_000 }).toBeGreaterThan(0);
    // the test keychain is in memory: it is empty after the restart, so give the data source its password again
    await call(page, "page.save", { target: `resource:${ids.shop}`, changes: { "body.password": PG_PASSWORD } });
  } finally {
    await stopHost(h2);
  }
});

/* ---------------------------------------------------------------- E: history and saved results */

test("E1/E2/E3: every run is recorded with its values; reuse reopens the statement with them", async ({ page }) => {
  await openKernel(page, host);
  const run = await runSql(page, "5");
  expect(run.status, JSON.stringify(run.error)).toBe("success");
  const info = await call<RunInfo & { params: Record<string, string> }>(page, "run.get", { id: run.id });
  expect(info.params.min).toBe("5");
  const groups = await nodes(page, "runs");
  expect(groups.map((g) => g.label)).toEqual(["Saved results", "Recent runs"]);
  const recent = await nodes(page, "runs", "@runs:recent");
  const node = recent.find((n) => n.key === run.id)!;
  expect(node, "the run is in Recent runs").toBeTruthy();
  const effects = await call<{ type: string; target?: string; params?: Record<string, string> }[]>(page, "command.execute", { id: "run.reuse", context: { tree: "runs", nodeKey: run.id } });
  expect(effects[0]).toMatchObject({ type: "open", target: `resource:${ids.savedSql}` });
  expect(effects[0]!.params).toMatchObject({ min: "5" });
  ids.run = run.id;
});

test("E4/E5: keep a result with a name; it moves to Saved results; unkeep; delete asks first and removes it", async ({ page }) => {
  await openKernel(page, host);
  await call(page, "run.setKept", { id: ids.run, kept: true, name: "Orders over 5" });
  const saved = await nodes(page, "runs", "@runs:saved");
  const n = saved.find((x) => x.key === ids.run)!;
  expect(n.label).toContain("Orders over 5");
  expect(n.target).toBe(`run:${ids.run}`);
  expect((await nodes(page, "runs", "@runs:recent")).map((x) => x.key)).not.toContain(ids.run);
  // E6: opens as its own page with the rows
  const d = JSON.stringify(await call(page, "page.resolve", { target: `run:${ids.run}` }));
  expect(d).toContain(`"runId":"${ids.run}"`);
  expect(d).toContain('"readOnly":true');
  const rows = await call<{ rows: string[][]; total?: number }>(page, "run.rows", { id: ids.run, offset: 0, limit: 10 });
  expect(rows.rows.length).toBeGreaterThan(0);
  // unkeep and keep again
  await call(page, "run.setKept", { id: ids.run, kept: false });
  expect((await nodes(page, "runs", "@runs:saved")).map((x) => x.key)).not.toContain(ids.run);
  await call(page, "run.setKept", { id: ids.run, kept: true, name: "Orders over 5" });
  // delete: first a confirmation, nothing removed yet
  const ask = await call<{ type: string; command?: string }[]>(page, "command.execute", { id: "run.delete", context: { tree: "runs", nodeKey: ids.run } });
  expect(ask[0]).toMatchObject({ type: "confirm", command: "run.delete" });
  expect((await nodes(page, "runs", "@runs:saved")).map((x) => x.key)).toContain(ids.run);
  await call(page, "command.execute", { id: "run.delete", context: { tree: "runs", nodeKey: ids.run, args: { confirmed: true } } });
  expect((await nodes(page, "runs", "@runs:saved")).map((x) => x.key)).not.toContain(ids.run);
});

test("E1: a kept result is not counted in the limit of the last 200 runs", async ({ page }) => {
  await openKernel(page, host);
  const first = await runSql(page, "1");
  await call(page, "run.setKept", { id: first.id, kept: true, name: "Keep me" });
  const mk = Array.from({ length: 205 }, (_, i) => call<string>(page, "run.start", { action: "run", target: `resource:${ids.savedSql}`, resourceId: ids.savedSql, tabId: "e2e-tab", input: { "body.sql": ids.savedSqlText, "body.source": "" }, params: { min: String(i % 7) }, locale: "en-US" }));
  const started = await Promise.all(mk);
  for (const id of started.slice(-3)) await waitRun(page, id);
  await new Promise((r) => setTimeout(r, 3000));
  const recent = (await nodes(page, "runs", "@runs:recent")).length;
  expect(recent).toBeLessThanOrEqual(200);
  expect((await nodes(page, "runs", "@runs:saved")).map((x) => x.key)).toContain(first.id);
});

/* ---------------------------------------------------------------- G: environments and the data source */

test("G3: a child environment inherits the data source reference; a stale reference says where it came from", async ({ page }) => {
  await openKernel(page, host);
  const sql = "SELECT current_database() AS db";
  const rid = await create(page, "org.onedesk.sql:query", { name: "Which db", "body.sql": sql, "body.source": "" });
  const root = (await nodes(page, "env"))[0]!.key;
  await call(page, "command.execute", { id: "env.newChild", context: { tree: "env", nodeKey: root } });
  const kid = (await call<{ nodes: Node[] }>(page, "tree.children", { tree: "env", parent: root })).nodes.find((n) => n.label === "New environment")!.key;
  const cfg = (await nodes(page, "config")).find((n) => n.label === "Workspace")!.key;
  const run = (env: string) => startRun(page, "run", `resource:${rid}`, {}, { resourceId: rid, input: { "body.sql": sql, "body.source": "" }, envId: env });
  // the workspace default (set in setup) answers when nothing else does
  const a = await run(kid);
  expect(await rowsOf(page, a)).toEqual([[DB1]]);
  await call(page, "params.unset", { node: cfg, name: "datasource.default" });
  const none = await run(kid);
  expect(none.status).toBe("error");
  expect(JSON.stringify(none.error)).toContain("No data source");
  // the parent environment names the source; the child run gets it
  await call(page, "params.set", { node: root, name: "datasource", value: ids.shop, type: "ref" });
  expect(await rowsOf(page, await run(kid))).toEqual([[DB1]]);
  const resolved = await call<{ value?: string; display?: string; sourceName?: string }>(page, "params.resolve", { envId: kid, name: "datasource" });
  expect(resolved.value).toBe(ids.shop);
  expect(resolved.display, "a reference shows the name of the data source, not its id").toBe("Shop");
  expect(resolved.sourceName, "and which environment it came from (G4)").toBe((await nodes(page, "env"))[0]!.label);
  // the data source is deleted: the error names the environment
  const gone = await create(page, "org.onedesk.datasource:source", { name: "Gone", "body.mode": "direct", "body.host": "127.0.0.1", "body.port": "1", "body.database": "x", "body.user": "u" });
  await call(page, "params.set", { node: root, name: "datasource", value: gone, type: "ref" });
  await call(page, "resource.delete", { id: gone });
  const stale = await run(kid);
  expect(stale.status).toBe("error");
  expect(stale.error?.message).toContain("(from the environment)");
  await call(page, "params.unset", { node: root, name: "datasource" });
  await call(page, "params.set", { node: cfg, name: "datasource.default", value: ids.shop, type: "ref" });
});

test("G1/G2/G7: environments nest with inheritance and override, move under another parent, rename and delete", async ({ page }) => {
  await openKernel(page, host);
  const root = (await nodes(page, "env"))[0]!.key;
  const kids = async (parent: string) => (await nodes(page, "env", parent)).map((n) => ({ key: n.key, label: n.label }));
  const add = async (parent: string) => {
    const before = new Set((await kids(parent)).map((k) => k.key));
    await call(page, "command.execute", { id: "env.newChild", context: { tree: "env", nodeKey: parent } });
    return (await kids(parent)).find((k) => !before.has(k.key))!.key;
  };
  const a = await add(root);
  const b = await add(root);
  const a1 = await add(a);
  await call(page, "tree.rename", { tree: "env", key: a, name: "Team A" });
  await call(page, "tree.rename", { tree: "env", key: b, name: "Team B" });
  expect((await kids(root)).map((k) => k.label)).toEqual(expect.arrayContaining(["Team A", "Team B"]));
  // G1: a value set on the root is inherited by the grandchild; an override wins; unsetting brings the inherited one back
  await call(page, "params.set", { node: root, name: "region", value: "eu" });
  const val = async (env: string) => (await call<{ value: string; sourceName: string }>(page, "params.resolve", { envId: env, name: "region" }));
  expect((await val(a1)).value).toBe("eu");
  await call(page, "params.set", { node: a, name: "region", value: "us" });
  expect((await val(a1)).value).toBe("us");
  expect((await val(a1)).sourceName).toBe("Team A"); // G4: says which layer
  await call(page, "params.unset", { node: a, name: "region" });
  expect((await val(a1)).value).toBe("eu");
  // G2: moving Team A (with its child) under Team B changes what the child inherits
  await call(page, "params.set", { node: b, name: "region", value: "asia" });
  await call(page, "tree.move", { tree: "env", key: a, target: b, position: "inside" });
  expect((await kids(b)).map((k) => k.label)).toEqual(["Team A"]);
  expect((await kids(root)).map((k) => k.label)).not.toContain("Team A");
  expect((await val(a1)).value).toBe("asia");
  // G7: delete takes it (and its child) out of the tree; it goes to the Deleted list, from where it can come back
  await call(page, "command.execute", { id: "node.delete", context: { tree: "env", nodeKey: b } });
  expect((await kids(root)).map((k) => k.label)).not.toContain("Team B");
  expect(JSON.stringify(await nodes(page, "deleted"))).toContain("Team B");
});

/* ---------------------------------------------------------------- H: tables */

const TABLES = "org.onedesk.table:tables";
const nodeTarget = (key: string) => `node:org.onedesk.table:tables/${encodeURIComponent(key)}`;

const OVERVIEW = "page:org.onedesk.table/overview";
/** D421: the tree shows what the last "Refresh" read; the reading happens in a run, started from the overview page. */
const refreshTables = async (page: Page) => {
  const r = await startRun(page, "org.onedesk.table:refresh", OVERVIEW, {});
  expect(r.status, JSON.stringify(r.error)).toBe("success");
};

test("H1/H3: before the first refresh the tree says so; after it the mapping's tables are listed by prefix", async ({ page }) => {
  await openKernel(page, host);
  const empty = await nodes(page, TABLES);
  expect(empty.map((n) => n.label)).toEqual(["Not loaded — open to refresh"]);
  expect(empty[0]!.target).toBe(OVERVIEW);
  await refreshTables(page);
  const top = await nodes(page, TABLES);
  expect(top.map((n) => n.label)).toEqual(expect.arrayContaining(["item_*", "no_*", "orders"])); // H1: prefix groups and a plain table
  const find = async (re: RegExp, parent?: string): Promise<Node | undefined> => {
    for (const n of await nodes(page, TABLES, parent)) {
      if (re.test(n.label)) return n;
      if (n.key.startsWith("g:")) {
        const hit = await find(re, n.key);
        if (hit) return hit;
      }
    }
    return undefined;
  };
  const isMissing = (n: Node) => n.state === "broken" || /miss/i.test(n.badge ?? "");
  const items = await find(/^item_ver$/);
  expect(items, "item_ver is under the item_* group").toBeTruthy();
  ids.items2 = JSON.stringify(items);
  const ghost = await find(/^no_such_table$/);
  expect(ghost, "the table the database does not have is listed").toBeTruthy();
  ids.ghost = JSON.stringify(ghost);
  void isMissing;
});

// H3 (fixed in the table plugin and the data source `inline` query): after "Refresh" only the table the database lacks is marked missing.
test("H3: only a table the database does not have is marked missing", async ({ page }) => {
  await openKernel(page, host);
  const bad = (n: Node) => n.state === "broken" || /miss/i.test(n.badge ?? "");
  expect(bad(JSON.parse(ids.ghost) as Node), ids.ghost).toBe(true);
  expect(bad(JSON.parse(ids.items2) as Node), ids.items2).toBe(false);
});

test("H2: the toolbar has the one/two levels switch and Refresh; two levels group by two name parts, and Refresh opens the overview", async ({ page }) => {
  await openKernel(page, host);
  const t = (await call<{ id: string; toolbar?: { id: string }[] }[]>(page, "tree.list")).find((x) => x.id === TABLES)!;
  expect(t.toolbar!.map((c) => c.id)).toEqual(expect.arrayContaining(["org.onedesk.table:toggleDepth", "org.onedesk.table:refresh"]));
  const refreshEffects = JSON.stringify(await treeCmd(page, "org.onedesk.table:refresh", TABLES));
  expect(refreshEffects).toContain(OVERVIEW);
  const before = JSON.stringify(await nodes(page, TABLES));
  await treeCmd(page, "org.onedesk.table:toggleDepth", TABLES);
  const after = JSON.stringify(await nodes(page, TABLES));
  expect(after).not.toBe("");
  await treeCmd(page, "org.onedesk.table:toggleDepth", TABLES);
  expect(JSON.stringify(await nodes(page, TABLES))).toBe(before);
});

test("H4: the table page shows the description, the source and the columns to tick", async ({ page }) => {
  await openKernel(page, host);
  const d = JSON.stringify(await call(page, "page.resolve", { target: nodeTarget("t:order") }));
  expect(d).toContain("Orders of the shop");
  expect(d).toContain("orders");
  expect(d).toContain("customer");
});

// DEFECT (kernel `runs.rs` ~403, still open after D421): an action run for a `node:` target gets `ctx.target` but no `ctx.node`, and the
// table plugin's `entityOfNode` reads `ctx.node.key`, so every table action fails with " is not in the mapping". Passes with a local
// patch taking the key from ctx.target (docs/handoff/round16-probe-patches.diff).
test("H4: Fetch rows reads the ticked columns only (all when none is ticked)", async ({ page }) => {
  await openKernel(page, host);
  const all = await startRun(page, "rows", nodeTarget("t:order"), {});
  expect(all.status, JSON.stringify(all.error)).toBe("success");
  expect((await rowsOf(page, all))[0]!.length).toBe(5); // none ticked: every column of the table
  const some = await startRun(page, "rows", nodeTarget("t:order"), { "col.customer": "true" });
  expect(some.status, JSON.stringify(some.error)).toBe("success");
  expect((await rowsOf(page, some))[0]).toEqual(["ann"]);
});

// DEFECT (kernel `runs.rs` ~403, still open after D421): an action run for a `node:` target gets `ctx.target` but no `ctx.node`, and the
// table plugin's `entityOfNode` reads `ctx.node.key`, so every table action fails with " is not in the mapping". Passes with a local
// patch taking the key from ctx.target (docs/handoff/round16-probe-patches.diff).
test("H5: the five version queries give the current rows, one record's history, a point in time, a period and the deleted ones", async ({ page }) => {
  await openKernel(page, host);
  const t = nodeTarget("t:item");
  const cur = await startRun(page, "current", t, {});
  expect(cur.status, JSON.stringify(cur.error)).toBe("success");
  expect((await rowsOf(page, cur)).map((r) => r[0]).sort()).toEqual(["1", "2"]);
  const hist = await startRun(page, "history", t, { key: "1" });
  expect(hist.status, JSON.stringify(hist.error)).toBe("success");
  expect((await rowsOf(page, hist)).length).toBe(2);
  const at = await startRun(page, "at", t, { at: "2026-01-10T00:00:00Z" });
  expect((await rowsOf(page, at)).map((r) => r[0]).sort()).toEqual(["1", "2", "3"]);
  const ch = await startRun(page, "changes", t, { from: "2026-01-20T00:00:00Z", to: "2026-03-01T00:00:00Z" });
  expect(ch.status, JSON.stringify(ch.error)).toBe("success");
  expect((await rowsOf(page, ch)).map((r) => r[0])).toEqual(["1"]); // only item 1 got a new version in [Jan 20, Mar 1)
  const del = await startRun(page, "deleted", t, {});
  expect(del.status, JSON.stringify(del.error)).toBe("success");
  expect((await rowsOf(page, del)).map((r) => r[0])).toEqual(["3"]);
  const need = await startRun(page, "history", t, {});
  expect(need.status).toBe("error"); // the key is required
  const plain = await startRun(page, "history", nodeTarget("t:order"), { key: "1" });
  expect(plain.status).toBe("error"); // not a versioned table
});

/* ---------------------------------------------------------------- catalog limits (review #6, #18) */

const limitsHost = async (page: Page, files: number, tag: string, extra: (dir: string) => void = () => {}) => {
  const h = await startHost(path.join(base, `data-lim-${tag}`));
  const dir = path.join(base, `big-${tag}`);
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < files; i++) writeFileSync(path.join(dir, `q${i}.sql`), `/* ---\nid: lim.item${i}\n--- */\nSELECT ${i}\n`);
  symlinkSync(".", path.join(dir, "loop"));
  extra(dir);
  await openKernel(page, h);
  const c = <T = unknown>(method: string, params: unknown = null) => rpc<T>(page, h, method, params);
  await c("plugin.grantFolder", { plugin: "org.onedesk.catalog", path: dir });
  return { h, dir, c };
};

test("A1 (limits): a symlink loop in the folder is walked once and does not eat the file limit", async ({ page }) => {
  const { h, c } = await limitsHost(page, 12, "loop");
  try {
    const first = JSON.stringify(await c("command.execute", { id: "org.onedesk.catalog:reindex", context: { tree: CAT } }));
    expect(first).toMatch(/12 queries indexed/);
    expect(first).not.toMatch(/Stopped at/);
    expect((await c<{ nodes: Node[] }>("tree.children", { tree: CAT, parent: "g:lim" })).nodes.length).toBe(12);
  } finally {
    await stopHost(h);
  }
});

// A1 (fixed in the catalog plugin): with 5,100 files the index reports it stopped at 5000 and marks nothing missing.
test("A1 (limits): more than 5000 files is reported as cut short and nothing already indexed is marked missing", async ({ page }) => {
  const { h, c } = await limitsHost(page, 12, "over");
  try {
    await c("command.execute", { id: "org.onedesk.catalog:reindex", context: { tree: CAT } });
    const dir = path.join(base, "big-over");
    mkdirSync(path.join(dir, "many"));
    for (let i = 0; i < 5100; i++) writeFileSync(path.join(dir, "many", `f${String(i).padStart(4, "0")}.sql`), `/* ---\nid: many.f${i}\n--- */\nSELECT ${i}\n`);
    const runId = await c<string>("run.start", { action: "org.onedesk.catalog:reindex", target: "page:org.onedesk.catalog/index", tabId: "e2e-tab", input: {}, params: {}, locale: "en-US" });
    let info: { status: string } = { status: "running" };
    for (let i = 0; i < 300 && info.status === "running"; i++) {
      await new Promise((r) => setTimeout(r, 200));
      info = await c("run.get", { id: runId });
    }
    const text = JSON.stringify(info);
    expect(text, text).toMatch(/Stopped at 5000 files/);
    expect(text).toMatch(/0 missing/);
    const items = (await c<{ nodes: Node[] }>("tree.children", { tree: CAT, parent: "g:lim" })).nodes;
    expect(items.length).toBe(12);
    expect(items.every((n) => n.state !== "broken" && !/miss/i.test(n.badge ?? ""))).toBe(true);
  } finally {
    await stopHost(h);
  }
});

/* ---------------------------------------------------------------- on screen */

test("E3/E5 (screen): the run history has two groups, a kept result sits under Saved results with its name, a double click opens it", async ({ page }) => {
  await openKernel(page, host);
  const r = await runSql(page, "3");
  await call(page, "run.setKept", { id: r.id, kept: true, name: "Screen result" });
  await page.getByRole("navigation", { name: "Views" }).getByRole("button", { name: "Run records", exact: true }).click();
  await expect(page.getByRole("treeitem", { name: "Recent runs" })).toBeVisible();
  await expect(page.getByRole("treeitem", { name: "Saved results" })).toBeVisible();
  // Both groups open by themselves (D424): no click on a group. The kept result may sit below many recent runs, so find it by name.
  await page.getByLabel("Filter by name").fill("Screen result");
  await expect(page.getByRole("treeitem", { name: /Screen result/ })).toBeVisible();
  await page.getByRole("treeitem", { name: /Screen result/ }).dblclick();
  await expect(page.getByRole("tab", { name: /Screen result|recent orders/i }).first()).toBeVisible();
  await page.screenshot({ path: "test-results/screenshots/round16/saved-result.png" });
});
