/** Round 20 parity batch 6: row K11 (the MCP service) with the real `onedesk-mcp` binary, application closed (headless worker path), real PostgreSQL. */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { UserKernel } from "../_mcp/kernel-conn";
import { connectMcp } from "../_mcp/mcp-client";
import { DEVHOST, ROOT } from "../kernel-host";
import { DB1, PG_TRUST_USER, startPg, type Pg } from "../pg-fixture";
import { changed, mkBase, oracle, row, seedParity, unverified } from "./support";

test.describe.configure({ mode: "serial" });
test.setTimeout(180_000);
const MCP_BIN = process.env.ONEDESK_MCP_BIN ?? path.join(ROOT, "target/debug/onedesk-mcp");
const DS = "org.onedesk.datasource:source";
const SQLK = "org.onedesk.sql:query";
let base: string, dataDir: string, pg: Pg, user: UserKernel;
const ids = {} as Record<"ds"|"q"|"unmappedOk", string>;
const policy = async (u: UserKernel, p: Record<string, string>) => {
  for (const [name, value] of Object.entries(p)) await u.rpc("workspace.setConfig", { name: `mcp.${name}`, value });
};
const open = () => connectMcp({ command: MCP_BIN, args: ["--data-dir", dataDir], env: { ONEDESK_DATA_DIR: dataDir, ONEDESK_MCP_IDLE_MS: "300" } });
const create = async (u: UserKernel, kind: string, changes: Record<string, unknown>) => (await u.rpc("page.save", { target: `new:${kind}`, changes })).page.resourceId as string;
const asUser = async <T>(fn: (u: UserKernel) => Promise<T>) => {
  await user.start();
  try {
    return await fn(user);
  } finally {
    await user.stop();
  }
};

test.beforeAll(async () => {
  expect(existsSync(DEVHOST) && existsSync(MCP_BIN), `${DEVHOST} / ${MCP_BIN}`).toBe(true);
  base = mkBase("p6");
  dataDir = path.join(base, "data");
  pg = await startPg(path.join(base, "pg"));
  seedParity(pg, DB1);
  const plugins = path.join(base, "plugins");
  mkdirSync(plugins);
  for (const n of readdirSync(path.join(ROOT, "plugins"))) symlinkSync(path.join(ROOT, "plugins", n), path.join(plugins, n));
  const catalog = path.join(base, "catalog");
  mkdirSync(catalog);
  writeFileSync(path.join(catalog, "mapping.yaml"), "entities:\n  order:\n    table: orders\n    columns:\n      id: id\n      customer: customer\n      amount: amount\n");
  writeFileSync(path.join(catalog, "q.sql"), "/* ---\nid: sales.big\ntitle: Big orders\nparams:\n  - name: min\n    type: number\n    required: true\n--- */\nSELECT {{order.id}} AS id, {{order.customer}} AS customer FROM {{order}} WHERE {{order.amount}} >= :min ORDER BY 1\n");
  user = new UserKernel(dataDir, plugins);
});
test.afterAll(async () => {
  await user?.stop();
  pg?.stop();
  if (base) rmSync(base, { recursive: true, force: true });
});

test("K11 setup: data source (trust role), saved query, catalog + mapping + table list; all made visible to AI", async () => {
  await asUser(async (u) => {
    ids.ds = await create(u, DS, { name: "Shop", "body.mode": "direct", "body.host": "127.0.0.1", "body.port": String(pg.port), "body.database": DB1, "body.user": PG_TRUST_USER });
    ids.q = await create(u, SQLK, { name: "Orders over n", "body.sql": "-- @param n type=number required -- minimum\nSELECT id, customer FROM orders WHERE amount >= :n::numeric ORDER BY id", "body.source": ids.ds });
    const cfg = (await u.rpc("tree.children", { tree: "config" })).nodes.find((n: any) => n.label === "Workspace").key;
    await u.rpc("params.set", { node: cfg, name: "datasource.default", value: ids.ds, type: "ref" });
    await u.rpc("plugin.grantFolder", { plugin: "org.onedesk.catalog", path: path.join(base, "catalog") });
    await u.rpc("command.execute", { id: "org.onedesk.catalog:reindex", context: { tree: "org.onedesk.catalog:catalog" } });
    const rid = await u.rpc("run.start", { action: "org.onedesk.table:refresh", target: "page:org.onedesk.table/overview", tabId: "p", input: {}, params: {}, locale: "en-US" });
    for (let i = 0; i < 100; i++) {
      const r = await u.rpc("run.get", { id: rid });
      if (r.status !== "running") break;
      await new Promise((r) => setTimeout(r, 200));
    }
    for (const id of [ids.ds, ids.q]) await u.rpc("resource.setAiVisible", { id, visible: true });
    await policy(u, { enabled: "true", max_rows: "50", rate_per_minute: "600" });
  });
});

test("K11", async () => {
  await row("K11", async () => {
    const notes: string[] = [];
    // 1. the application is not running here (the devhost is stopped): a separate command-line program answers
    let c = await open();
    try {
      const names = (await c.listTools()).map((t) => t.name);
      expect(names).toEqual(expect.arrayContaining(["search", "describe", "run", "get_run", "org_onedesk_table__list_tables"]));
      expect(names).not.toContain("org_onedesk_table__run_sql"); // free query: off by default
      notes.push(`应用没开（只有独立的 onedesk-mcp 命令行程序 + 无界面工作进程）时 tools/list = ${names.join("、")}`);
      // search / describe / run (saved queries)
      const found = await c.callTool("search", { query: "Orders" });
      expect(found.json.items.map((i: any) => i.name)).toContain("Orders over n");
      const d = await c.callTool("describe", { id: ids.q });
      expect(d.isError, d.text).toBe(false);
      const r = await c.callTool("run", { id: ids.q, action: "run", params: { n: 20 } });
      expect(r.json.status, r.text.slice(0, 300)).toBe("success");
      expect(r.json.output.rows).toEqual(oracle(pg, DB1, "SELECT id, customer FROM orders WHERE amount >= 20 ORDER BY id"));
      notes.push("search/describe/run 保存的查询：行与 psql 直查相同");
      // list_tables: the mapped tables
      const lt = await c.callTool("org_onedesk_table__list_tables", {});
      expect(lt.isError, lt.text).toBe(false);
      expect(JSON.stringify(lt.json)).toContain("orders");
      notes.push("list_tables 列出映射里的表 orders");
      // a hidden resource is invisible: make a second query not visible
      const hidden = await c.callTool("describe", { id: "no-such" });
      expect(hidden.isError).toBe(true);
      // only reading: write statements as saved queries fail (round19-sql covers); here the audit has the calls
    } finally {
      await c.close();
    }
    // 2. free query tool: opened by the user; single SELECT with a lexical check
    await asUser((u) => policy(u, { allow_free_query: "true" }));
    c = await open();
    try {
      const names = (await c.listTools()).map((t) => t.name);
      expect(names).toContain("org_onedesk_table__run_sql");
      const ok = await c.callTool("org_onedesk_table__run_sql", { sql: "SELECT id, customer FROM orders ORDER BY id" });
      expect(ok.isError, ok.text.slice(0, 300)).toBe(false);
      expect(JSON.stringify(ok.json)).toContain("ann");
      const bads = ["DELETE FROM orders", "SELECT 1; DELETE FROM orders", "SELECT * INTO x FROM orders", "SELECT pg_sleep(1)", "COPY orders TO '/tmp/x'", "/* x */ DROP TABLE orders", "SELECT 1 -- ;\n; DELETE FROM orders"];
      const results: string[] = [];
      for (const sql of bads) {
        const x = await c.callTool("org_onedesk_table__run_sql", { sql });
        const refused = x.isError || x.json?.status === "error" || /denied|refus|not allowed|only|error/i.test(x.text.slice(0, 300));
        results.push(`${refused ? "拒" : "放行"}:${sql.slice(0, 30).replace(/\n/g, " ")}`);
        expect(refused, sql + " → " + x.text.slice(0, 200)).toBe(true);
      }
      // sqlpool: "对映射过的表运行单条 SELECT" — what about tables that are NOT in the mapping?
      const unmapped = await c.callTool("org_onedesk_table__run_sql", { sql: "SELECT line_id FROM ord_line LIMIT 2" });
      const catalogRead = await c.callTool("org_onedesk_table__run_sql", { sql: "SELECT usename FROM pg_catalog.pg_user LIMIT 2" });
      const unmappedOk = !(unmapped.isError || unmapped.json?.status === "error");
      const catalogOk = !(catalogRead.isError || catalogRead.json?.status === "error");
      notes.push(`未映射的表 ord_line：${unmappedOk ? "放行了（返回行）" : "被拒"}；系统目录 pg_catalog.pg_user：${catalogOk ? "放行了（返回行）" : "被拒"}`);
      ids.unmappedOk = String(unmappedOk || catalogOk);
      expect(oracle(pg, DB1, "SELECT count(*) FROM orders")).toEqual([["4"]]);
      notes.push(`自由查询（打开 allow_free_query 后）单条 SELECT 成功；${bads.length} 种越权写法全部被拒：${results.join("；")}；orders 仍 4 行`);
    } finally {
      await c.close();
    }
    await asUser((u) => policy(u, { allow_free_query: "false" }));
    // 3. its own index and history: the AI's runs are in the workspace history with the AI as the actor
    const hist = await asUser(async (u) => JSON.stringify(await u.rpc("audit.list", {})));
    expect(hist).toMatch(/ai:/);
    notes.push("每次调用进审计，操作者 ai:<客户端名>");
    if (ids.unmappedOk === "true") throw new Error(`自由查询工具不限于映射过的表：${notes.join("。")}。sqlpool 的该工具只对映射过的表运行；根本边界是只读事务 + 只读角色，但行里的内容可见（第十九轮已记为已接受的限制：“黑名单挡不住未列入的函数”）`);
    return unverified(`${notes.join("。")}。没有验证：Claude Desktop 本身（只用本仓库的 MCP 客户端，stdin/stdout JSON-RPC）、应用开着时走 mcp.sock 的路径（只有 Rust 测试覆盖）、带密码的数据源（无界面进程看不到内存钥匙串，所以用了免密码角色）。sqlpool 的 MCP 有“自己的索引与历史”——OneDesk 的 AI 接口是工作区内核的一部分，用同一份索引和运行历史，不再另有一份；这是设计上的变化（第十九轮 D447）`);
  });
});
void changed;
void readFileSync;
void execFileSync;
