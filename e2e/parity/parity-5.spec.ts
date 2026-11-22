/** Round 20 parity batch 5: rows K1–K10 against the real kernel, a throw-away PostgreSQL and the local fake AI provider (no real Anthropic is contacted). */
// @ts-nocheck — one-off acceptance script split from one long file: leftover unused helpers and unchecked lookups; it is run by Playwright, not shipped.
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { startFakeAi, type FakeAi } from "../../plugins/_testing/fake-ai/server";
import { DEVHOST, openKernel, rpc, startHost, stopHost, type Host } from "../kernel-host";
import { DB1, PG_PASSWORD, PG_USER, startPg, type Pg } from "../pg-fixture";
import { changed, mkBase, pass, row, shot, unverified } from "./support";

test.use({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
test.describe.configure({ mode: "serial" });
test.setTimeout(180_000);

let host: Host;
let base: string;
let pg: Pg;
let ai: FakeAi;
let docsDir: string;
const AI = "org.onedesk.ai";
const ANTH = "org.onedesk.ai.anthropic";
const DSK = "org.onedesk.datasource:source";
const SQLK = "org.onedesk.sql:query";
const SCR = "org.onedesk.script:script";
const KEY = "sk-ant-parity-KEY-4417-never-leaks";

test.beforeAll(async () => {
  expect(existsSync(DEVHOST)).toBe(true);
  base = mkBase("p5");
  ai = await startFakeAi();
  pg = await startPg(path.join(base, "pg"));
  docsDir = path.join(base, "docs");
  mkdirSync(docsDir, { recursive: true });
  host = await startHost(path.join(base, "data"));
});
test.afterAll(async () => {
  if (host) await stopHost(host);
  if (pg) pg.stop();
  if (ai) await ai.close();
  if (base) rmSync(base, { recursive: true, force: true });
});

const call = <T = unknown>(page: Page, method: string, params: unknown = null) => rpc<T>(page, host, method, params);
type RunInfo = { id: string; status: string; error?: { code: string; message?: string }; summary?: { message?: string }; output?: any; partial?: any };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitRun = async (page: Page, id: string, tries = 300): Promise<RunInfo> => {
  for (let i = 0; i < tries; i++) {
    const r = await call<RunInfo>(page, "run.get", { id });
    if (r.status !== "running") return r;
    await sleep(100);
  }
  throw new Error("run did not end");
};
const startRaw = (page: Page, action: string, target: string, extra: Record<string, unknown> = {}) => call<string>(page, "run.start", { action, target, tabId: "p-tab", input: {}, params: {}, locale: "en-US", ...extra });
const runRes = async (page: Page, id: string, action: string, extra: Record<string, unknown> = {}) => waitRun(page, await startRaw(page, action, `resource:${id}`, { resourceId: id, ...extra }));
const create = async (page: Page, kind: string, changes: Record<string, unknown>) => (await call<{ page: { resourceId: string } }>(page, "page.save", { target: `new:${kind}`, changes })).page.resourceId;
const getRes = (page: Page, id: string) => call<{ id: string; name: string; body: Record<string, any> }>(page, "resource.get", { id });
const dbq = (sql: string): string => execFileSync("/usr/bin/sqlite3", [path.join(base, "data/workspaces/default/workspace.db"), sql], { encoding: "utf8" });
const chats = () => ai.requests.filter((r) => r.method === "POST");
const userText = (r: { body: any }): string => {
  const m = r.body?.messages?.[0];
  return typeof m?.content === "string" ? m.content : Array.isArray(m?.content) ? m.content.map((c: any) => c.text ?? "").join("") : "";
};
const ids: Record<string, string> = {};
const runSql = async (page: Page, sql: string, name: string) => {
  const rid = await create(page, SQLK, { name, "body.sql": sql, "body.source": ids.ds });
  return runRes(page, rid, "run", { input: { "body.sql": sql, "body.source": ids.ds } });
};
const click = async (page: Page, runId: string, action = `${AI}:analyze`) => waitRun(page, await startRaw(page, action, `run:${runId}`, { resultRun: runId }));
const draftOf = (run: RunInfo) => String(run.output?.target ?? "").replace(/^resource:/, "");
const syncDocs = async (page: Page) => waitRun(page, await startRaw(page, `${AI}:syncDocs`, `page:${AI}`));

const MASK_SQL = `SELECT id, 'cust' || id AS customer, 'user' || id || '@example.com' AS email, 'pw-secret-' || id AS password,
  'card 1234567890123456 ok' AS note, repeat('z', 300) AS long_text FROM generate_series(1, 25) AS id ORDER BY id`;

test("K: setup", async ({ page }) => {
  await openKernel(page, host);
  ids.ds = await create(page, DSK, { name: "Shop", "body.mode": "direct", "body.host": "127.0.0.1", "body.port": String(pg.port), "body.database": DB1, "body.user": PG_USER, "body.password": PG_PASSWORD });
  ids.anth = await create(page, `${ANTH}:connection`, { name: "Fake Anthropic", "body.baseUrl": ai.url, "body.secret": KEY });
  await call(page, "plugin.setSetting", { plugin: AI, name: "connection", value: ids.anth });
  const cfg = (await call<{ nodes: { key: string; label: string }[] }>(page, "tree.children", { tree: "config" })).nodes.find((n) => n.label === "Workspace")!.key;
  await call(page, "params.set", { node: cfg, name: "datasource.default", value: ids.ds, type: "ref" });
});

test("K1–K10", async ({ page }) => {
  await openKernel(page, host);
  ai.set({ kind: "ok" });
  let tableRun = "";
  let draft = "";

  await row("K1", async () => {
    const table = await runSql(page, MASK_SQL, "Customers");
    tableRun = table.id;
    const acts = await call<{ plugin: string; id: string; enabled: boolean }[]>(page, "result.actions", { runId: table.id });
    const a = acts.find((x) => x.plugin === AI && x.id === "analyze");
    expect(a?.enabled, JSON.stringify(acts)).toBe(true);
    // a result of another plugin (a local script's output) gets the button too
    const scr = await create(page, SCR, { name: "Prints", "body.script": "echo line-one\necho line-two" });
    const sr = await runRes(page, scr, "run");
    const sacts = await call<{ plugin: string; id: string }[]>(page, "result.actions", { runId: sr.id });
    expect(sacts.some((x) => x.plugin === AI && x.id === "analyze")).toBe(true);
    const failed = await runSql(page, "SELECT * FROM no_such_table", "Broken");
    expect(await call(page, "result.actions", { runId: failed.id })).toEqual([]);
    const n0 = chats().length;
    const c = await click(page, table.id);
    expect(c.status, JSON.stringify(c.error)).toBe("success");
    draft = draftOf(c);
    expect(chats().length).toBe(n0);
    // on screen: the Analyze button sits in the result toolbar of the SQL page
    await page.reload();
    {
      const b = page.getByRole("navigation", { name: "Views" }).getByRole("button", { name: "Resources", exact: true });
      if ((await b.getAttribute("aria-pressed")) !== "true") await b.click();
    }
    await page.getByRole("treeitem", { name: "Customers", exact: true }).dblclick({ timeout: 10_000 });
    await page.getByRole("button", { name: "Run", exact: true }).click();
    await expect(page.getByRole("button", { name: /Analy/ }).first()).toBeVisible({ timeout: 30_000 });
    await shot(page, "K1-analyze-button.png");
    return "SQL 的表格结果、本机脚本的输出（别的插件）上都有“Analyze”按钮；失败的运行没有；点它只生成预览草稿，没有任何请求发出（K1-analyze-button.png）";
  }, page);

  await row("K4", async () => {
    const req = String((await getRes(page, draft)).body.request);
    expect(req).not.toMatch(/pw-secret-/);
    expect(req).not.toContain("@example.com");
    expect(req).not.toContain("1234567890123456");
    expect(req).toContain("***");
    expect(req).toContain("cust20");
    expect(req).not.toContain("cust21");
    expect(req).not.toContain("z".repeat(250));
    return "敏感列（password、email）打码；长数字串、邮箱被替换；只带前 20 行（cust20 有、cust21 无）；长文本在 200 字处截断";
  }, page);

  await row("K3", async () => {
    // documents for the statement's table names (needed for the tick boxes)
    writeFileSync(path.join(docsDir, "orders.md"), "# Orders\nThe orders table keeps customer and amount.\n");
    await call(page, "plugin.setSetting", { plugin: AI, name: "docFolder", value: docsDir });
    await call(page, "plugin.grantFolder", { plugin: AI, path: docsDir });
    expect((await syncDocs(page)).status).toBe("success");
    const orders = await runSql(page, "SELECT customer, amount FROM orders", "Orders");
    const d = draftOf(await click(page, orders.id));
    const res = await getRes(page, d);
    const docs = JSON.parse(res.body.docs) as { name: string; text: string }[];
    expect(docs.map((x) => x.name)).toContain("orders.md");
    const view = JSON.stringify((await call<any>(page, "page.resolve", { target: `resource:${d}` })).view);
    expect(view).toContain("orders.md");
    const n0 = chats().length;
    expect(n0).toBe(chats().length);
    ai.set({ kind: "ok", pieces: ["One", " two"] });
    const r = await runRes(page, d, `${AI}:send`, { input: { "body.request": "EDITED REQUEST", "body.use0": "false" } });
    expect(r.status, JSON.stringify(r.error)).toBe("success");
    expect(chats().length).toBe(n0 + 1);
    const sent = userText(chats().at(-1)!);
    expect(sent).toContain("EDITED REQUEST");
    expect(sent).not.toContain("The orders table keeps");
    // screen: the preview page
    await page.reload();
    await page.getByRole("navigation", { name: "Views" }).getByRole("button", { name: "Resources", exact: true }).click().catch(() => null);
    ids.draft = d;
    return "发送前预览页显示完整请求（可编辑）与每篇文档的勾选；没点发送前没有请求发出；发送的是编辑后的文字，取消勾选的文档没有进请求";
  }, page);

  await row("K5", async () => {
    const last = chats().at(-1)!;
    expect(last.path).toBe("/v1/messages");
    expect(last.headers["x-api-key"]).toBe(KEY);
    expect(last.body.stream).toBe(true);
    const res = JSON.stringify(await getRes(page, ids.anth));
    expect(res).not.toContain(KEY);
    expect(JSON.stringify(await call(page, "page.resolve", { target: `resource:${ids.anth}` }))).not.toContain(KEY);
    let leaked = "";
    try {
      leaked = execFileSync("/usr/bin/grep", ["-rl", "--binary-files=text", KEY, path.join(base, "data")], { encoding: "utf8" });
    } catch {
      /* none */
    }
    expect(leaked).toBe("");
    expect(JSON.stringify(await call(page, "audit.list", {}))).not.toContain(KEY);
    return unverified(`按 Anthropic Messages 协议（POST /v1/messages、SSE 流、x-api-key 由宿主代入）发给本机的假服务：请求头与流式都对；资源、页面描述、审计、数据目录里搜不到密钥。没有连真实 Anthropic（规则不许）、密钥用的是内存钥匙串（不是 macOS 真钥匙串）`);
  }, page);

  await row("K6", async () => {
    const src = await runSql(page, "SELECT 'keep-me-1' AS tag, 7 AS n", "To keep");
    const d = draftOf(await click(page, src.id));
    ai.set({ kind: "ok", pieces: ["The answer is ", "SEVEN-MARKER"] });
    expect((await runRes(page, d, `${AI}:send`)).status).toBe("success");
    const rows = () => dbq(`SELECT name || '|' || kind || '|' || data FROM run_artifacts WHERE run_id = '${src.id}'`).trim();
    const kept = await call<any>(page, "page.event", { target: `resource:${d}`, event: "keep", context: { params: { name: "Seven analysis" } } });
    expect(JSON.stringify(kept)).toContain("Seven analysis");
    expect(rows()).toContain("Seven analysis|analysis|");
    expect(rows()).toContain("SEVEN-MARKER");
    expect(rows()).toMatch(/model/);
    await call(page, "run.setKept", { id: src.id, kept: true, name: "Analysed" });
    await call(page, "command.execute", { id: "run.delete", context: { args: { run: src.id, confirmed: true } } });
    expect(rows()).toBe("");
    return "保存分析：名称、请求、回答、模型存进该结果的 run_artifacts 行（挂在那次运行下）；删除这次运行后分析一并删除";
  }, page);

  await row("K2", async () => {
    writeFileSync(path.join(docsDir, "billing.md"), "# Billing\nInvoices reference the amount of an order.\n");
    writeFileSync(path.join(docsDir, "unrelated.md"), "# Gardening\nTomatoes need sun.\n");
    mkdirSync(path.join(docsDir, "sub"), { recursive: true });
    writeFileSync(path.join(docsDir, "sub", "notes.txt"), "orders orders orders customer amount\n");
    const s = await syncDocs(page);
    expect(s.status, JSON.stringify(s.error)).toBe("success");
    const kind = `${AI}:doc`;
    const q = async (p: Record<string, unknown>) => (await call<{ title: string }[]>(page, "search.query", { text: "", ...p })).map((h) => h.title);
    const any = await q({ text: "orders gardening", mode: "any", rank: "relevance", kinds: [kind] });
    expect(any).toEqual(expect.arrayContaining(["orders.md", "unrelated.md", "notes.txt"]));
    const best = await q({ text: "orders customer amount", mode: "any", rank: "relevance", kinds: [kind] });
    expect(best.indexOf("billing.md")).toBeGreaterThan(0);
    expect(await q({ text: "orders gardening", mode: "all", kinds: [kind] })).toEqual([]);
    // budget: the draft takes few docs, within the token budget
    const orders = await runSql(page, "SELECT customer, amount FROM orders", "Orders again");
    const d = draftOf(await click(page, orders.id));
    const docs = JSON.parse((await getRes(page, d)).body.docs) as { name: string; tokens: number }[];
    expect(docs.length).toBeLessThanOrEqual(8);
    expect(docs.reduce((n, x) => n + x.tokens, 0)).toBeLessThanOrEqual(3000);
    expect(docs.map((x) => x.name)).not.toContain("unrelated.md");
    return `资料文件夹（授权后）建成文档资源；“命中任一词、按相关度排序、限定类型”的查询成立；按语句里的表名/列名挑文档（${docs.map((x) => x.name).join("、")}），总量在预算（3000 token）内、无关文档不选`;
  }, page);

  await row("K7", async () => {
    ids.sql = await create(page, SQLK, { name: "Ask AI", "body.sql": "SELECT * FROM orders", "body.source": ids.ds });
    ai.set({ kind: "ok", pieces: ["```sql\nSELECT customer, sum(amount) FROM orders GROUP BY customer\n```"] });
    const n0 = chats().length;
    const w = await runRes(page, ids.sql, "org.onedesk.sql:aiWrite", { params: { aiInstruction: "total amount per customer" }, input: { "body.sql": "SELECT * FROM orders", "body.source": ids.ds } });
    expect(w.status, JSON.stringify(w.error)).toBe("success");
    expect(chats().length).toBe(n0); // preview first
    const sqlView = JSON.stringify((await call<any>(page, "page.resolve", { target: `resource:${ids.sql}` })).view);
    ids.gdraft = /"target":"resource:([0-9a-f]+)"/.exec(sqlView)![1]!;
    const dr = await getRes(page, ids.gdraft);
    expect(dr.body.request).toContain("total amount per customer");
    expect(dr.body.request).toContain("orders");
    const send = await runRes(page, ids.gdraft, `${AI}:send`);
    expect(send.status, JSON.stringify(send.error)).toBe("success");
    const body = userText(chats().at(-1)!);
    expect(body).not.toMatch(/\bann\b|\bbob\b|o'neil/);
    expect(body).not.toContain("10.50");
    return "从“说明”出发生成 SQL：请求带说明与相关文档、表名，不带任何数据行（ann/bob/10.50 都不在请求里）；先预览、点发送才发出";
  }, page);

  await row("K9", async () => {
    const f = await runRes(page, ids.sql, "org.onedesk.sql:aiFetch");
    expect(f.status, JSON.stringify(f.error)).toBe("success");
    const acc = await call<{ changes?: Record<string, string> }>(page, "page.event", { target: `resource:${ids.sql}`, event: "aiAccept" });
    expect(acc.changes?.["body.sql"]).toBe("SELECT customer, sum(amount) FROM orders GROUP BY customer");
    expect((await getRes(page, ids.sql)).body.sql).toBe("SELECT * FROM orders");
    const rej = await call<{ changes?: unknown }>(page, "page.event", { target: `resource:${ids.sql}`, event: "aiDiscard" });
    expect(rej.changes).toBeUndefined();
    return "“接受”返回对编辑器的修改（body.sql = 提议），已保存的资源不变（即未保存的修改）；“放弃”不改编辑器";
  }, page);

  await row("K8", async () => {
    await call(page, "params.set", { node: (await call<{ nodes: { key: string }[] }>(page, "tree.children", { tree: "env" })).nodes[0]!.key, name: "ai.policy", value: "allow" });
    const env = (await call<{ nodes: { key: string }[] }>(page, "tree.children", { tree: "env" })).nodes[0]!.key;
    const cases = ["DROP TABLE orders", "DELETE FROM orders WHERE id = 1", "SELECT 1; DROP TABLE orders", "WITH x AS (DELETE FROM orders RETURNING *) SELECT * FROM x", "SELECT * INTO backup FROM orders"];
    for (const text of cases) {
      ai.set({ kind: "ok", pieces: [text] });
      await runRes(page, ids.sql, "org.onedesk.sql:aiWrite", { params: { aiInstruction: "do something" }, input: { "body.sql": "SELECT * FROM orders", "body.source": ids.ds }, envId: env });
      const acc = await call<{ changes?: unknown }>(page, "page.event", { target: `resource:${ids.sql}`, event: "aiAccept" });
      expect(acc.changes, text).toBeUndefined();
    }
    // the command plugin's proposals: dangerous words warn (not blocked), and are never run
    ai.set({ kind: "ok", pieces: ["SELECT 'DROP TABLE x' AS s FROM orders"] });
    await runRes(page, ids.sql, "org.onedesk.sql:aiWrite", { params: { aiInstruction: "words" }, input: { "body.sql": "SELECT * FROM orders", "body.source": ids.ds }, envId: env });
    const ok = await call<{ changes?: Record<string, string> }>(page, "page.event", { target: `resource:${ids.sql}`, event: "aiAccept" });
    expect(ok.changes?.["body.sql"]).toContain("SELECT 'DROP TABLE x'");
    expect(oracleCount()).toBe("4");
    await call(page, "params.unset", { node: env, name: "ai.policy" });
    return unverified("SQL：写语句、两条语句、WITH 里写、SELECT INTO 都不能接受，字符串里的 DROP 字样可以；orders 仍 4 行。服务器命令/本机脚本生成时“危险词给警告”的那一半没有在界面逐条验证（只验了 SQL）");
  }, page);

  await row("K10", async () => {
    const models = await runRes(page, ids.anth, `${ANTH}:models`);
    expect(models.output.text).toContain("claude-");
    const d = await create(page, `${AI}:analysis`, { name: "Draft", "body.request": "hi" });
    const view = JSON.stringify((await call<any>(page, "page.resolve", { target: `resource:${d}` })).view);
    expect(view).toContain("Fake Anthropic");
    // remove the key (Secrets page → Delete = secrets.delete): a send then fails in words and sends nothing
    const list = await call<{ name: string }[]>(page, "secrets.list");
    const name = list.find((x) => x.name.endsWith(".secret") && x.name.startsWith(ids.anth))!.name;
    await call(page, "secrets.delete", { name });
    const n0 = chats().length;
    ai.set({ kind: "ok", pieces: ["x"] });
    const after = await runRes(page, d, `${AI}:send`);
    expect(after.status).toBe("error");
    expect(chats().length).toBe(n0);
    const words = String(after.error?.message ?? "");
    await call(page, "secrets.set", { name, value: KEY }); // put it back
    return changed(`sqlpool 在 AI 设置页保存/移除 API 密钥、选模型；OneDesk：密钥填在每个连接的表单里（存钥匙串，K5），移除在“密钥”页点删除；模型在连接上可“列出模型”（${models.output.text.split("\n").length} 个）并在分析页选连接。删除密钥后发送失败且没有请求发出（提示：${words.slice(0, 100)}）。密钥页的删除我走的是 secrets.delete 协议调用，没有在界面上点按钮`);
  }, page);
});
const oracleCount = () => execFileSync(path.join(pg.bin, "psql"), ["-X", "-A", "-t", "-h", path.join(pg.dir, "sock"), "-p", String(pg.port), "-U", "postgres", "-d", DB1, "-c", "SELECT count(*) FROM orders"], { encoding: "utf8" }).trim();
void pass;
