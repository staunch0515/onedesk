/**
 * Round 19 (D450): the real SQL query plugin still runs with parameters under MCP, against a throw-away PostgreSQL, after the
 * kernel's new rules ("an action without declared parameters takes none", "secrets.get is refused in an AI run").
 * Same two connections as round19.spec.ts: the devhost (user) for the setup, `onedesk-mcp` headless for the AI side.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { AiWorker, UserKernel } from "./_mcp/kernel-conn";
import { connectMcp } from "./_mcp/mcp-client";
import { DEVHOST, ROOT } from "./kernel-host";
import { DB1, PG_PASSWORD, PG_SKIP_REASON, PG_TRUST_USER, startPg, type Pg } from "./pg-fixture";

test.describe.configure({ mode: "serial" });
test.setTimeout(120_000);

const MCP_BIN = process.env.ONEDESK_MCP_BIN ?? path.join(ROOT, "target/debug/onedesk-mcp");
const DS = "org.onedesk.datasource:source";
const SQLK = "org.onedesk.sql:query";
let base: string;
let dataDir: string;
let pg: Pg;
let user: UserKernel;
const ids = {} as Record<"ds" | "q" | "bad", string>;

test.beforeAll(async () => {
  if (process.env.ONEDESK_E2E_REQUIRE_DEVHOST === "1") expect(existsSync(DEVHOST)).toBe(true);
  else test.skip(!existsSync(DEVHOST) || !existsSync(MCP_BIN), "onedesk-devhost / onedesk-mcp not built");
  if (process.env.ONEDESK_E2E_REQUIRE_PG === "1") expect(PG_SKIP_REASON, "PostgreSQL is required").toBeNull();
  else test.skip(PG_SKIP_REASON !== null, PG_SKIP_REASON ?? "");
  base = realpathSync(mkdtempSync(path.join(tmpdir(), "od-round19sql-")));
  dataDir = path.join(base, "data");
  pg = await startPg(path.join(base, "pg"));
  const plugins = path.join(base, "plugins");
  mkdirSync(plugins);
  for (const n of readdirSync(path.join(ROOT, "plugins"))) symlinkSync(path.join(ROOT, "plugins", n), path.join(plugins, n));
  user = new UserKernel(dataDir, plugins);
});
test.afterAll(async () => {
  await user?.stop();
  pg?.stop();
  if (base) rmSync(base, { recursive: true, force: true });
});

const create = async (u: UserKernel, kind: string, changes: Record<string, unknown>) => (await u.rpc("page.save", { target: `new:${kind}`, changes })).page.resourceId as string;
const dbq = (sql: string): string => execFileSync("/usr/bin/sqlite3", [path.join(dataDir, "workspaces/default/workspace.db"), sql], { encoding: "utf8" });
const open = () => connectMcp({ command: MCP_BIN, args: ["--data-dir", dataDir], env: { ONEDESK_DATA_DIR: dataDir, ONEDESK_MCP_IDLE_MS: "300" } });

test("setup: a data source and a saved query with a declared parameter; both visible to AI", async () => {
  await user.start();
  try {
    ids.ds = await create(user, DS, { name: "Local shop", "body.mode": "direct", "body.host": "127.0.0.1", "body.port": String(pg.port), "body.database": DB1, "body.user": PG_TRUST_USER }); // no password: the test PostgreSQL trusts local connections, and a password would sit in the devhost's in-memory secret store, which a headless worker (another process) cannot see — that case is for the manual acceptance with the real keychain
    ids.q = await create(user, SQLK, {
      name: "Numbers up to n",
      "body.sql": "-- @param n type=number required -- how many\nSELECT g AS id, 'row-' || g AS label FROM generate_series(1, :n::int) g ORDER BY g",
      "body.source": ids.ds,
    });
    ids.bad = await create(user, SQLK, { name: "Writes", "body.sql": "DELETE FROM nothing", "body.source": ids.ds });
    for (const id of [ids.ds, ids.q, ids.bad]) await user.rpc("resource.setAiVisible", { id, visible: true });
    for (const [name, value] of Object.entries({ enabled: "true", max_rows: "50" })) await user.rpc("workspace.setConfig", { name: `mcp.${name}`, value });
  } finally {
    await user.stop();
  }
});

test("search finds the saved query; describe lists its declared parameter n (number, required)", async () => {
  const c = await open();
  try {
    const found = await c.callTool("search", { query: "Numbers" });
    expect(found.json.items.map((i: { name: string }) => i.name)).toContain("Numbers up to n");
    const d = await c.callTool("describe", { id: ids.q });
    expect(d.isError, d.text).toBe(false);
    const run = d.json.actions.find((a: { action: string }) => a.action === "run");
    expect(run.params).toEqual([expect.objectContaining({ name: "n", type: "number", required: true })]);
  } finally {
    await c.close();
  }
});

test("run with parameters works under MCP: rows come back, cut at the row limit; a missing required parameter is refused before anything runs", async () => {
  const c = await open();
  try {
    const r = await c.callTool("run", { id: ids.q, action: "run", params: { n: 3 } });
    expect(r.isError, r.text).toBe(false);
    expect(r.json.status, r.text + "\n" + dbq("SELECT title||' '||ifnull(error,'') FROM runs ORDER BY seq DESC LIMIT 3")).toBe("success");
    expect(r.json.output.columns, "column names, not keys (c0, c1)").toEqual(["id", "label"]);
    expect(r.json.output.rows).toEqual([["1", "row-1"], ["2", "row-2"], ["3", "row-3"]]); // a data source answers in text
    const big = await c.callTool("run", { id: ids.q, action: "run", params: { n: 80 } });
    expect(big.json.output.rows).toHaveLength(50);
    expect(big.json.output).toMatchObject({ truncated: true });
    const missing = await c.callTool("run", { id: ids.q, action: "run" });
    expect(missing.isError).toBe(true);
    const wrongType = await c.callTool("run", { id: ids.q, action: "run", params: { n: "abc" } });
    expect(wrongType.isError, wrongType.text).toBe(true);
    const extra = await c.callTool("run", { id: ids.q, action: "run", params: { n: 2, sneaky: "x" } });
    expect(extra.isError, "a parameter the action did not declare").toBe(true);
  } finally {
    await c.close();
  }
});

test("a statement that writes is stopped by the read-only execution, not by trust (nothing changes)", async () => {
  pg.psql(DB1, "CREATE TABLE IF NOT EXISTS keep (id int); INSERT INTO keep VALUES (1);", "postgres");
  const c = await open();
  try {
    const r = await c.callTool("run", { id: ids.bad, action: "run" });
    expect(r.json?.status ?? "error").not.toBe("success");
  } finally {
    await c.close();
  }
  expect(pg.psql(DB1, "SELECT count(*) FROM keep", "postgres").trim()).toContain("1");
});

test("the raw AI connection sees no connection secrets in describe/run output", async () => {
  const w = await new AiWorker(dataDir, "e2e-sql").start();
  try {
    const out = JSON.stringify(await w.call("mcp.call", { name: "describe", arguments: { id: ids.ds } }).catch((e) => e.err));
    expect(out).not.toContain(PG_PASSWORD);
    const run = JSON.stringify(await w.call("mcp.call", { name: "run", arguments: { id: ids.q, action: "run", params: { n: 2 } } }));
    expect(run).not.toContain(PG_PASSWORD);
  } finally {
    await w.stop();
  }
});
