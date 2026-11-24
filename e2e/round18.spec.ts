/**
 * Round 18 (sqlpool-parity K1–K10, docs/redesign/ai-plugins.md; kernel X5/X6/X15/X16) against the real kernel.
 * Nothing real is contacted: both AI providers talk to the local fake of plugins/_testing/fake-ai (Anthropic SSE + Ollama
 * NDJSON), the data comes from a throw-away PostgreSQL, API keys live only in the in-memory secret store.
 * The two test plugins in fixtures/r18-plugins call the plugin interface without / with `uses`.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { startFakeAi, type FakeAi } from "../plugins/_testing/fake-ai/server";
import { DEVHOST, openKernel, OUT, ROOT, rpc, startHost, stopHost, ui, type Host, linkAllPlugins } from "./kernel-host";
import { DB1, PG_PASSWORD, PG_SKIP_REASON, PG_USER, startPg, type Pg } from "./pg-fixture";

test.use({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
test.describe.configure({ mode: "serial" });
test.setTimeout(120_000);

let host: Host;
let base: string;
let ai: FakeAi;
let pg: Pg;
let docsDir: string;

const AI = "org.onedesk.ai";
const ANTH = "org.onedesk.ai.anthropic:connection";
const OLL = "org.onedesk.ai.ollama:connection";
const DS = "org.onedesk.datasource:source";
const SQLK = "org.onedesk.sql:query";
const KEY = "sk-ant-e2e-KEY-7731-never-leaks";
const OLLAMA_AUTH = "Bearer OLLAMA-e2e-token-5519";

test.beforeAll(async () => {
  if (process.env.ONEDESK_E2E_REQUIRE_DEVHOST === "1") expect(existsSync(DEVHOST), `onedesk-devhost not built at ${DEVHOST}`).toBe(true);
  else test.skip(!existsSync(DEVHOST), `onedesk-devhost not built at ${DEVHOST}`);
  if (process.env.ONEDESK_E2E_REQUIRE_PG === "1") expect(PG_SKIP_REASON, "PostgreSQL is required").toBeNull();
  else test.skip(PG_SKIP_REASON !== null, PG_SKIP_REASON ?? "");
  base = realpathSync(mkdtempSync(path.join(tmpdir(), "od-round18-")));
  ai = await startFakeAi();
  pg = await startPg(path.join(base, "pg"));
  docsDir = path.join(base, "docs");
  mkdirSync(docsDir, { recursive: true });
  // the real plugins (symlinks) plus the two probe plugins
  const plugins = path.join(base, "plugins");
  mkdirSync(plugins);
  linkAllPlugins(plugins);
  for (const n of readdirSync(path.join(ROOT, "e2e/fixtures/r18-plugins"))) cpSync(path.join(ROOT, "e2e/fixtures/r18-plugins", n), path.join(plugins, n), { recursive: true });
  host = await startHost(path.join(base, "data"), { ONEDESK_TEST_HOOKS: "1" }, plugins);
});
test.afterAll(async () => {
  if (host) await stopHost(host);
  if (pg) pg.stop();
  if (ai) await ai.close();
  if (base) rmSync(base, { recursive: true, force: true });
});
test.beforeEach(() => {
  ai?.set({ kind: "ok" });
  ai?.setModels(["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"]);
  ai?.setLoading(false);
});

/* ------------------------------------------------------------------ helpers */

const call = <T = unknown>(page: Page, method: string, params: unknown = null) => rpc<T>(page, host, method, params);
type Res = { id: string; name: string; kind?: string; body: Record<string, any> };
type RunInfo = { id: string; status: string; error?: { code: string; message?: string; params?: Record<string, string> }; summary?: { message?: string }; output?: any; partial?: any; progress?: any };
const getRes = (page: Page, id: string) => call<Res>(page, "resource.get", { id });
const create = async (page: Page, kind: string, changes: Record<string, unknown>) => (await call<{ page: { resourceId: string } }>(page, "page.save", { target: `new:${kind}`, changes })).page.resourceId;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitRun = async (page: Page, id: string, tries = 300): Promise<RunInfo> => {
  for (let i = 0; i < tries; i++) {
    const r = await call<RunInfo>(page, "run.get", { id });
    if (r.status !== "running") return r;
    await sleep(100);
  }
  throw new Error("run did not end");
};
const startRaw = (page: Page, action: string, target: string, extra: Record<string, unknown> = {}) =>
  call<string>(page, "run.start", { action, target, tabId: "e2e-tab", input: {}, params: {}, locale: "en-US", ...extra });
const runRes = async (page: Page, id: string, action: string, extra: Record<string, unknown> = {}) => waitRun(page, await startRaw(page, action, `resource:${id}`, { resourceId: id, ...extra }));
type Node = { key: string; label: string };
const nodes = async (page: Page, tree: string) => (await call<{ nodes: Node[] }>(page, "tree.children", { tree })).nodes;
const nodeId = async (page: Page, tree: string, label: string) => (await nodes(page, tree)).find((n) => n.label === label)!.key;
const dbq = (sql: string): string => execFileSync("/usr/bin/sqlite3", [path.join(base, "data/workspaces/default/workspace.db"), sql], { encoding: "utf8" });
const grepData = (word: string): string => {
  try {
    return execFileSync("/usr/bin/grep", ["-rl", "--binary-files=text", word, path.join(base, "data")], { encoding: "utf8" });
  } catch {
    return "";
  }
};
const ids = {} as Record<"anth" | "ollama" | "ds" | "query" | "textRun" | "tableRun" | "analysis" | "analysisRun" | "sql" | "keepRun", string>;
/**
 * An assertion about a defect another session is fixing: it does not stop the serial run (later cases need the state), it is
 * collected and the last test fails with the whole list. So every assertion is real — nothing is skipped or tolerated.
 */
const defects: string[] = [];
const note = (name: string, e: unknown) => defects.push(`${name}: ${String((e as Error).message).split("\n").slice(0, 3).join(" | ").slice(0, 300)}`);
const finding = (name: string, fn: () => void) => {
  try {
    fn();
  } catch (e) {
    note(name, e);
  }
};
const findingA = async (name: string, fn: () => Promise<void>) => {
  try {
    await fn();
  } catch (e) {
    note(name, e);
  }
};
const chats = () => ai.requests.filter((r) => r.method === "POST");
const lastChat = () => chats().at(-1)!;
const userText = (r: { body: any }): string => {
  const m = r.body?.messages?.[0];
  return typeof m?.content === "string" ? m.content : Array.isArray(m?.content) ? m.content.map((c: any) => c.text ?? "").join("") : "";
};

/** A result: the statement runs on the throw-away PostgreSQL. */
const runSql = async (page: Page, sql: string, name: string, extra: Record<string, unknown> = {}): Promise<RunInfo> => {
  const rid = await create(page, SQLK, { name, "body.sql": sql, "body.source": ids.ds });
  return runRes(page, rid, "run", { input: { "body.sql": sql, "body.source": ids.ds }, ...extra });
};
const CLICK_ENV = async (page: Page) => nodeId(page, "env", "Default");
/** What the shell does when the user clicks a result-area button: run.start with `resultRun`. */
const clickAction = async (page: Page, runId: string, action = `${AI}:analyze`, extra: Record<string, unknown> = {}) => waitRun(page, await startRaw(page, action, `run:${runId}`, { resultRun: runId, ...extra }));
const resourceOf = (run: RunInfo) => String(run.output?.target ?? "").replace(/^resource:/, "");
const resultActionsOf = (page: Page, runId: string) => call<{ plugin: string; id: string; action: string; label: string; enabled: boolean; disabledReason?: string }[]>(page, "result.actions", { runId });
// D479: an analysis is an AI chat. What the user says is the input box (the run parameter `message`); under the default
// policy (preview) the first Send only shows the full text and the same Send again sends it.
const said: Record<string, string> = {};
const PREVIEWED = /Press Send again/;
const sendOnce = (page: Page, id: string, input: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => runRes(page, id, `${AI}:send`, { input, params: { message: said[id] ?? "" }, ...extra });
const sendAnalysis = async (page: Page, id: string, input: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => {
  const first = await sendOnce(page, id, input, extra);
  return PREVIEWED.test(first.summary?.message ?? "") ? sendOnce(page, id, input, extra) : first;
};
/** The preview of the next Send (nothing goes out); the Send after it sends. */
const previewNext = async (page: Page, id: string, extra: Record<string, unknown> = {}) => {
  const r = await sendOnce(page, id, {}, extra);
  expect(r.summary?.message ?? "", JSON.stringify(r.error)).toMatch(PREVIEWED);
  return r;
};
const newAnalysis = async (page: Page, request: string, extra: Record<string, unknown> = {}) => {
  const id = await create(page, `${AI}:analysis`, { name: "Draft", ...extra });
  said[id] = request;
  return id;
};
const syncDocs = async (page: Page) => waitRun(page, await startRaw(page, `${AI}:syncDocs`, `page:${AI}`));
const setDefaultConnection = (page: Page, id: string) => call(page, "plugin.setSetting", { plugin: AI, name: "connection", value: id });
const setEnv = async (page: Page, name: string, value: string) => call(page, "params.set", { node: await CLICK_ENV(page), name, value });
const unsetEnv = async (page: Page, name: string) => call(page, "params.unset", { node: await CLICK_ENV(page), name });

/* ------------------------------------------------------------------ providers: connections, key handling, test/models */

test("K5/K10: connections for both providers; the API key goes to the keychain only and reaches the fake only as a header", async ({ page }) => {
  await openKernel(page, host);
  ids.anth = await create(page, ANTH, { name: "Fake Anthropic", "body.baseUrl": ai.url, "body.secret": KEY });
  ids.ollama = await create(page, OLL, { name: "Fake Ollama", "body.baseUrl": ai.url, "body.model": "llama3.2:latest", "body.secret": OLLAMA_AUTH });
  const a = await getRes(page, ids.anth);
  expect(a.body.secret).toEqual({ secret: expect.any(String) });
  expect(JSON.stringify(a)).not.toContain(KEY);
  const t = await runRes(page, ids.anth, `${ANTH.split(":")[0]}:test`);
  expect(t.status, JSON.stringify(t.error)).toBe("success");
  expect(t.output.text).toMatch(/3 models/);
  const m = await runRes(page, ids.anth, `${ANTH.split(":")[0]}:models`);
  expect(m.output.text.split("\n")).toEqual(["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"]);
  const req = ai.requests.find((r) => r.path === "/v1/models")!;
  expect(req.headers["x-api-key"]).toBe(KEY); // the host put it in; the plugin only wrote a placeholder
  expect(req.headers["anthropic-version"]).toBeTruthy();
  expect(JSON.stringify(t) + JSON.stringify(m)).not.toContain(KEY);
  expect(JSON.stringify(await call(page, "secrets.list"))).not.toContain(KEY);
  expect(grepData(KEY), "the key is in no file of the data directory").toBe("");
});

test("K5: Ollama — /api/version and /api/tags; no model → how to pull; the auth header only goes as a header; a closed port is a plain error", async ({ page }) => {
  await openKernel(page, host);
  const t = await runRes(page, ids.ollama, "org.onedesk.ai.ollama:test");
  expect(t.status, JSON.stringify(t.error)).toBe("success");
  expect(t.output.text).toMatch(/Ollama 0\.99\.0-fake/);
  expect(t.output.text).toMatch(/3 models/);
  expect(ai.requests.some((r) => r.path === "/api/version")).toBe(true);
  expect(ai.requests.find((r) => r.path === "/api/tags")!.headers.authorization).toBe(OLLAMA_AUTH);
  ai.setModels([]);
  const none = await runRes(page, ids.ollama, "org.onedesk.ai.ollama:test");
  expect(JSON.stringify(none.output) + JSON.stringify(none.error)).toMatch(/ollama pull/);
  const dead = await create(page, OLL, { name: "Nobody home", "body.baseUrl": "http://127.0.0.1:9", "body.model": "x" });
  const d = await runRes(page, dead, "org.onedesk.ai.ollama:test");
  expect(d.status).toBe("error");
  expect(d.error?.message ?? JSON.stringify(d.error)).not.toContain(OLLAMA_AUTH);
  expect(grepData("OLLAMA-e2e-token-5519")).toBe("");
});

/* ------------------------------------------------------------------ X15: the plugin interface */

test("X15: no `uses` → denied/notUsed; with `uses`: list shows both providers, no implementation / wrong kind / missing resource are refused with their codes, a real call answers", async ({ page }) => {
  await openKernel(page, host);
  const no = await runRes(page, "", "org.test.nouses:probe").catch(() => null);
  void no;
  const nouses = await waitRun(page, await startRaw(page, "org.test.nouses:probe", "page:org.test.nouses"));
  expect(nouses.status, JSON.stringify(nouses.error)).toBe("success");
  const n = JSON.parse(nouses.output.text);
  expect(n.call).toMatchObject({ code: "denied", reason: "notUsed" });
  expect(n.list).toMatchObject({ code: "denied", reason: "notUsed" });
  expect(n.read).toMatchObject({ code: "denied", reason: "notInResultAction" }); // not in a result-area click
  ids.ds = await create(page, DS, { name: "Local shop", "body.mode": "direct", "body.host": "127.0.0.1", "body.port": String(pg.port), "body.database": DB1, "body.user": PG_USER, "body.password": PG_PASSWORD });
  ai.set({ kind: "ok", pieces: ["probe", " answer"] });
  const uses = await waitRun(page, await startRaw(page, "org.test.uses:probe", "page:org.test.uses", { input: { good: ids.anth, wrong: ids.ds } }));
  expect(uses.status, JSON.stringify(uses.error)).toBe("success");
  const u = JSON.parse(uses.output.text);
  expect(u.list).toEqual([`${ANTH.split(":")[0]}:connection`, `${OLL.split(":")[0]}:connection`].sort());
  expect(u.none).toMatchObject({ code: "invalid", reason: "noImplementation" });
  expect(u.wrong).toMatchObject({ code: "invalid", reason: "wrongInterface" });
  expect(u.missing).toMatchObject({ code: "notFound" });
  expect(u.good).toBe("probe answer");
  const audit = JSON.stringify(await call(page, "audit.list", {}));
  expect(audit).toContain("interfaces.call");
  expect(audit).not.toContain("probe answer");
  expect(audit).not.toContain(KEY);
});

/* ------------------------------------------------------------------ K10 settings, K2 documents */

test("K10: the default connection is a plugin setting (a resource reference); the pickers list the provider connections by name; the uses permission is listed", async ({ page }) => {
  await openKernel(page, host);
  await setDefaultConnection(page, ids.anth);
  const draft = await newAnalysis(page, "Picker test");
  const view = JSON.stringify((await call<any>(page, "page.resolve", { target: `resource:${draft}` })).view);
  expect(view).toContain("@implements:onedesk.ai.chat/1");
  expect(view, "options carry the connection names, not only ids").toContain("Fake Anthropic");
  expect(view).toContain("Fake Ollama");
  expect(view, "the AI workbench's own default is named on the page").toContain("Fake Anthropic");
  // #5: `uses` of someone else's interface is a permission the user sees (install/upgrade), for both users of an interface
  const perms = async (plugin: string) => (await call<{ permissions?: { id: string; detail: string }[] }>(page, "plugin.get", { plugin })).permissions?.filter((x) => x.id === "uses").map((x) => x.detail) ?? [];
  expect((await perms(AI)).join(" ")).toContain("onedesk.ai.chat/1");
  expect((await perms("org.onedesk.sql")).join(" ")).toContain("onedesk.ai.generate/1");
  expect(await perms("org.test.nouses")).toEqual([]);
});

test("K2/X6: an authorised documents folder becomes document resources; relevance search finds them by any word, best first, limited to the kind", async ({ page }) => {
  await openKernel(page, host);
  writeFileSync(path.join(docsDir, "orders.md"), "# Orders\nThe orders table keeps customer and amount. Orders are placed by customers; amount is in euros.\n");
  writeFileSync(path.join(docsDir, "billing.md"), "# Billing\nInvoices reference the amount of an order. Nothing about shipping here.\n");
  writeFileSync(path.join(docsDir, "unrelated.md"), "# Gardening\nTomatoes need sun.\n");
  mkdirSync(path.join(docsDir, "sub"));
  writeFileSync(path.join(docsDir, "sub", "notes.txt"), "orders orders orders customer amount\n");
  writeFileSync(path.join(docsDir, "image.png"), "not a document");
  const before = await syncDocs(page);
  expect(before.status).toBe("error"); // no folder set
  await call(page, "plugin.setSetting", { plugin: AI, name: "docFolder", value: docsDir });
  const notAuthorized = await syncDocs(page);
  expect(notAuthorized.status, "a folder the user did not authorize is refused").toBe("error");
  await call(page, "plugin.grantFolder", { plugin: AI, path: docsDir });
  const sync = await syncDocs(page);
  expect(sync.status, JSON.stringify(sync.error)).toBe("success");
  expect(sync.output.text).toMatch(/^4 /); // md and txt, subfolders too; the png is not a document
  const kind = `${AI}:doc`;
  const q = async (p: Record<string, unknown>) => (await call<{ target: string; title: string }[]>(page, "search.query", { text: "", ...p })).map((h) => ({ id: h.target.replace(/^resource:/, ""), name: h.title }));
  const any = await q({ text: "orders gardening", mode: "any", rank: "relevance", kinds: [kind] });
  const names = any.map((i) => i.name);
  expect(names).toEqual(expect.arrayContaining(["orders.md", "unrelated.md", "notes.txt"]));
  const all = await q({ text: "orders gardening", mode: "all", kinds: [kind] });
  expect(all, "every word must hit with mode all").toEqual([]);
  const best = await q({ text: "orders customer amount", mode: "any", rank: "relevance", kinds: [kind] });
  expect(best[0]!.name).toMatch(/orders\.md|notes\.txt/);
  expect(best.map((i) => i.name)).toContain("billing.md");
  expect(best.map((i) => i.name).indexOf("billing.md")).toBeGreaterThan(0); // fewer hits → later
  // kinds restricts: a note with the same words is not a document
  await create(page, "org.onedesk.note:note", { name: "orders note", "body.text": "orders customer amount" });
  expect((await q({ text: "orders", mode: "any", rank: "relevance" })).map((i) => i.name), "without kinds the note is found too").toContain("orders note");
  const onlyDocs = await q({ text: "orders", mode: "any", rank: "relevance", kinds: [kind] });
  expect(onlyDocs.length).toBeGreaterThan(0);
  expect(onlyDocs.map((i) => i.name)).not.toContain("orders note");
  // a change in the folder: a removed file disappears on the next sync
  rmSync(path.join(docsDir, "unrelated.md"));
  await syncDocs(page);
  expect((await q({ text: "gardening", kinds: [kind] })).length).toBe(0);
});

/* ------------------------------------------------------------------ K1: result actions, K4 masking, K3 preview */

const MASK_SQL = `SELECT id, 'cust' || id AS customer, 'user' || id || '@example.com' AS email, 'pw-secret-' || id AS password,
  'card 1234567890123456 ok' AS note, repeat('z', 300) AS long_text FROM generate_series(1, 25) AS id ORDER BY id`;

test("K1/X5: result.actions offers Analyze on table and text results only; a failed run has none; clicking creates a draft and sends nothing", async ({ page }) => {
  await openKernel(page, host);
  const table = await runSql(page, MASK_SQL.replace("FROM generate_series", "FROM generate_series"), "Customers");
  expect(table.status, JSON.stringify(table.error)).toBe("success");
  ids.tableRun = table.id;
  const acts = await resultActionsOf(page, table.id);
  const analyze = acts.find((a) => a.plugin === AI && a.id === "analyze")!;
  expect(analyze, JSON.stringify(acts)).toBeTruthy();
  expect(analyze.enabled).toBe(true);
  expect(analyze.action).toBe(`${AI}:analyze`);
  const failed = await runSql(page, "SELECT * FROM no_such_table", "Broken");
  expect(failed.status).toBe("error");
  expect(await resultActionsOf(page, failed.id)).toEqual([]);
  const before = ai.requests.length;
  const click = await clickAction(page, table.id);
  expect(click.status, JSON.stringify(click.error)).toBe("success");
  expect(click.output.type).toBe("link");
  ids.analysis = resourceOf(click);
  expect((await getRes(page, ids.analysis)).body.runId).toBe(table.id);
  expect(ai.requests.length, "Analyze only prepares the preview; nothing goes to the provider").toBe(before);
  // a result of the AI itself is text: Analyze is offered there too; a link result is not
  const link = click;
  expect((await resultActionsOf(page, link.id)).filter((a) => a.plugin === AI)).toEqual([]);
});

test("K1/X5: the AI plugin can read only the clicked run: running Analyze without a click, or on another run, fails", async ({ page }) => {
  await openKernel(page, host);
  const direct = await waitRun(page, await startRaw(page, `${AI}:analyze`, "page:org.onedesk.ai", { input: { runId: ids.tableRun } }));
  expect(direct.status).toBe("error");
  const second = await runSql(page, "SELECT 1 AS other", "Other");
  // a click on one run cannot be redirected to another through the input
  const click = await clickAction(page, second.id, `${AI}:analyze`, { input: { runId: ids.tableRun } });
  expect(click.status, JSON.stringify(click.error)).toBe("success");
  const made = await getRes(page, resourceOf(click));
  expect(made.body.runId).toBe(second.id);
  expect(made.body.runText).not.toContain("pw-secret");
  // not a result action: the kernel refuses (analysis `send` is no result action)
  const bad = await startRaw(page, `${AI}:syncDocs`, `run:${second.id}`, { resultRun: second.id }).then(
    () => "started",
    (e) => String(e),
  );
  expect(bad).toMatch(/notResultAction/);
});

test("K4/K3: masking before anything leaves — sensitive columns, e-mails, long digit strings, 20 rows, cut cells; the preview is the text and it is editable", async ({ page }) => {
  await openKernel(page, host);
  const n0 = chats().length;
  const a = await getRes(page, ids.analysis);
  const req: string = a.body.runText;
  expect(req).not.toMatch(/pw-secret-/); // the password column
  expect(req).not.toContain("@example.com"); // the e-mail column
  expect(req).not.toContain("1234567890123456"); // long digit strings
  expect(req).toContain("***");
  expect(req).toContain("[number]");
  expect(req).toContain("cust1");
  expect(req).not.toContain("cust21"); // only the first 20 rows
  expect(req).toContain("cust20");
  expect(req).not.toContain("z".repeat(250)); // cells cut at 200
  expect(req).toMatch(/20 of 25|first 20/i);
  // the preview (the first Send): connection and model, token estimate, the full text
  said[ids.analysis] = "What stands out?";
  const preview = JSON.stringify((await previewNext(page, ids.analysis)).output);
  finding("preview shows the connection", () => expect(preview).toMatch(/Fake Anthropic/));
  expect(preview).toMatch(/tokens/i);
  expect(preview).toContain("cust20");
  expect(preview).not.toContain("pw-secret-");
  expect(chats().length, "nothing sent by previewing").toBe(n0);
  // the user's own words for what is sensitive: another column name
  await call(page, "plugin.setSetting", { plugin: AI, name: "sensitiveColumns", value: "customer" });
  const again = await clickAction(page, ids.tableRun);
  const second = await getRes(page, resourceOf(again));
  expect(second.body.runText).not.toContain("cust1 ");
  expect(second.body.runText).not.toMatch(/cust\d/);
  await call(page, "plugin.setSetting", { plugin: AI, name: "sensitiveColumns", value: "" });
  await call(page, "plugin.setSetting", { plugin: AI, name: "maxRows", value: "3" });
  const three = await getRes(page, resourceOf(await clickAction(page, ids.tableRun)));
  expect(three.body.runText).toContain("cust3");
  expect(three.body.runText).not.toContain("cust4");
  await call(page, "plugin.setSetting", { plugin: AI, name: "maxRows", value: "20" });
});

test("K4/#7: sensitive columns are found by part of the name (passwordhash, accesstoken, emailaddress), by Chinese and Japanese words, and by the key as well as the label", async ({ page }) => {
  await openKernel(page, host);
  const run = await runSql(
    page,
    `SELECT 'hash-AAA' AS passwordhash, 'tok-BBB' AS accesstoken, 'mail-CCC' AS emailaddress, 'mima-DDD' AS "密码", 'shouji-EEE' AS "手机号", 'denwa-FFF' AS "電話番号", 'api-GGG' AS "ApiKey", 'plain-visible' AS city`,
    "Sensitive names",
  );
  expect(run.status, JSON.stringify(run.error)).toBe("success");
  const made = await getRes(page, resourceOf(await clickAction(page, run.id)));
  const req: string = made.body.runText;
  for (const v of ["hash-AAA", "tok-BBB", "mail-CCC", "mima-DDD", "shouji-EEE", "denwa-FFF", "api-GGG"]) expect(req, `${v} must be masked`).not.toContain(v);
  expect(req).toContain("plain-visible");
  // phone-like numbers in an ordinary column are masked as well
  const phone = await runSql(page, `SELECT 'call +86 138 0013 8000 or (415) 555-0132' AS note`, "Phones");
  const p = (await getRes(page, resourceOf(await clickAction(page, phone.id)))).body.runText as string;
  expect(p).not.toMatch(/138 0013 8000|555-0132/);
});

test("K3: nothing is sent before Send; Send sends what the user said with the masked result; the answer streams into the partial output and is kept as a turn", async ({ page }) => {
  await openKernel(page, host);
  const n0 = chats().length;
  const orders = await runSql(page, "SELECT customer, amount FROM orders", "Orders");
  const draft = resourceOf(await clickAction(page, orders.id));
  said[draft] = "EDITED REQUEST ABOUT ORDERS";
  const pageView = JSON.stringify((await call<any>(page, "page.resolve", { target: `resource:${draft}` })).view);
  expect(pageView, "the page is a conversation").toContain('"type":"conversation"');
  await previewNext(page, draft);
  expect(chats().length, "the preview sends nothing").toBe(n0);
  ai.set({ kind: "slow", pieces: ["One", " two", " three", " four"], delayMs: 500 });
  const runId = await startRaw(page, `${AI}:send`, `resource:${draft}`, { resourceId: draft, params: { message: said[draft] } });
  const seen: string[] = [];
  for (let i = 0; i < 60; i++) {
    const r = await call<RunInfo>(page, "run.get", { id: runId });
    if (r.partial?.text && seen.at(-1) !== r.partial.text) seen.push(r.partial.text);
    if (r.status !== "running") break;
    await sleep(100);
  }
  const done = await waitRun(page, runId);
  expect(done.status, JSON.stringify(done.error)).toBe("success");
  expect(seen.length, `partial output arrived while streaming: ${JSON.stringify(seen)}`).toBeGreaterThanOrEqual(2);
  expect(seen.every((s, i) => i === 0 || s.startsWith(seen[i - 1]!) || seen[i - 1]!.startsWith(s))).toBe(true); // the whole text each time
  expect(seen.at(0)!.length).toBeLessThan("One two three four".length);
  expect(done.output.text).toBe("One two three four");
  expect(chats().length).toBe(n0 + 1);
  expect(userText(lastChat())).toBe("EDITED REQUEST ABOUT ORDERS");
  const system = JSON.stringify(lastChat().body.system);
  expect(system, "the analysed result goes along as material").toContain("customer");
  expect(lastChat().body.stream).toBe(true);
  expect(lastChat().headers["x-api-key"]).toBe(KEY);
  expect(lastChat().body.model).toBe("claude-haiku-5-5");
  expect(lastChat().body.thinking, "no thinking field").toBeUndefined();
  expect(lastChat().body.temperature, "no sampling parameters").toBeUndefined();
  const turns = (await getRes(page, draft)).body.turns;
  expect(turns.map((t: any) => [t.role, t.text])).toEqual([["user", "EDITED REQUEST ABOUT ORDERS"], ["assistant", "One two three four"]]);
  ids.analysisRun = done.id;
  ids.textRun = done.id;
  ids.analysis = draft;
  // the answer is text: it can be analysed again (result.actions on a text run)
  expect((await resultActionsOf(page, done.id)).some((a) => a.plugin === AI && a.id === "analyze")).toBe(true);
});

test("K3: a connection written on the page beats the environment's, which beats the workspace default; Ollama goes by NDJSON", async ({ page }) => {
  await openKernel(page, host);
  const d = await newAnalysis(page, "Which provider?");
  ai.set({ kind: "ok", pieces: ["from ", "the default"] });
  const viaSettings = await sendAnalysis(page, d);
  expect(viaSettings.status, JSON.stringify(viaSettings.error)).toBe("success");
  expect(lastChat().path).toBe("/v1/messages");
  await setEnv(page, "ai.connection", ids.ollama);
  ai.set({ kind: "ok", pieces: ["from ", "ollama"] });
  const env = await CLICK_ENV(page);
  const viaEnv = await sendAnalysis(page, d, {}, { envId: env });
  expect(viaEnv.status, JSON.stringify(viaEnv.error)).toBe("success");
  expect(lastChat().path).toBe("/api/chat");
  expect(viaEnv.output.text).toBe("from ollama");
  expect(lastChat().body).toMatchObject({ model: "llama3.2:latest", stream: true });
  expect(lastChat().headers.authorization).toBe(OLLAMA_AUTH);
  const onPage = await sendAnalysis(page, d, { "body.connectionId": ids.anth }, { envId: env });
  expect(onPage.status, JSON.stringify(onPage.error)).toBe("success");
  expect(lastChat().path).toBe("/v1/messages");
  await unsetEnv(page, "ai.connection");
  // a resource that is no AI connection is said so in words
  const wrong = await sendAnalysis(page, d, { "body.connectionId": ids.ds });
  expect(wrong.status).toBe("error");
  finding("a non-AI resource on the page is said in words, not as a raw text key", () => expect(wrong.error?.message).not.toMatch(/^error\./));
  expect(wrong.error?.message).toBeTruthy();
  // nothing chosen anywhere → words telling where to choose
  await setDefaultConnection(page, "");
  const none = await sendAnalysis(page, d);
  expect(none.status).toBe("error");
  expect(none.error?.message).toMatch(/No AI connection/);
  await setDefaultConnection(page, ids.anth);
});

/* ------------------------------------------------------------------ providers: errors, refusal, cancel */

test("X16/K5: provider errors are mapped (401, 429+retry-after, 529, too long, refusal, error event in the stream) and never show the key", async ({ page }) => {
  await openKernel(page, host);
  const d = await newAnalysis(page, "Errors please");
  const err = async (status: number, headers: Record<string, string> = {}, body?: unknown) => {
    ai.once({ kind: "error", status, headers, body });
    return sendAnalysis(page, d);
  };
  const r401 = await err(401);
  expect(r401.status).toBe("error");
  expect(r401.error?.message).toMatch(/refused the key/i);
  const r429 = await err(429, { "retry-after": "7" });
  expect(r429.error?.message).toMatch(/limiting requests.*7 s/i);
  const r529 = await err(529);
  expect(r529.error?.message).toMatch(/busy/i);
  const tooLong = await err(400, {}, { type: "error", error: { type: "invalid_request_error", message: "prompt is too long: 300000 tokens > 200000 maximum" } });
  expect(tooLong.error?.message).toMatch(/too long/i);
  ai.set({ kind: "refusal", pieces: ["I can't help with that"] });
  const refused = await sendAnalysis(page, d);
  expect(refused.status).toBe("error");
  expect(refused.error?.message).toMatch(/declined/i);
  ai.set({ kind: "streamError" });
  const mid = await sendAnalysis(page, d);
  expect(mid.status).toBe("error");
  ai.set({ kind: "ok", pieces: ["fine"] });
  const ok = await sendAnalysis(page, d);
  expect(ok.status, "after errors the connection works again").toBe("success");
  for (const r of [r401, r429, r529, tooLong, refused, mid]) expect(JSON.stringify(r)).not.toContain(KEY);
  // a failed send stores no turn: only the one that worked is in the conversation
  expect((await getRes(page, d)).body.turns.map((t: any) => t.text)).toEqual(["Errors please", "fine"]);
});

test("X16: cancelling a streaming run ends it at once (the connection is dropped, not drained)", async ({ page }) => {
  await openKernel(page, host);
  const d = await newAnalysis(page, "Slow one");
  ai.set({ kind: "slow", pieces: Array.from({ length: 30 }, (_, i) => `p${i} `), delayMs: 1000 }); // 30 s if nobody cancels
  await previewNext(page, d);
  const runId = await startRaw(page, `${AI}:send`, `resource:${d}`, { resourceId: d, params: { message: said[d] } });
  for (let i = 0; i < 60; i++) {
    const r = await call<RunInfo>(page, "run.get", { id: runId });
    if (r.partial?.text) break;
    await sleep(100);
  }
  const t0 = Date.now();
  await call(page, "command.execute", { id: "run.cancel", context: { args: { run: runId } } });
  const r = await waitRun(page, runId, 100);
  expect(r.status).toBe("cancelled");
  expect(Date.now() - t0).toBeLessThan(3000);
  ai.set({ kind: "ok" });
});

test("X16: Ollama — NDJSON lines are joined, the loading line shows nothing wrong, the usage comes from the last line; no model downloaded is words, not a crash", async ({ page }) => {
  await openKernel(page, host);
  const d = await newAnalysis(page, "Ask ollama", { "body.connectionId": ids.ollama });
  ai.setLoading(true);
  ai.set({ kind: "ok", pieces: ["Hel", "lo ", "wörld ✓"], inputTokens: 12, outputTokens: 3 });
  const r = await sendAnalysis(page, d);
  expect(r.status, JSON.stringify(r.error)).toBe("success");
  expect(r.output.text).toBe("Hello wörld ✓");
  expect(lastChat().path).toBe("/api/chat");
  ai.set({ kind: "error", status: 404, body: { error: "model 'llama3.2:latest' not found" } });
  const missing = await sendAnalysis(page, d);
  expect(missing.status).toBe("error");
  expect(missing.error?.message).toMatch(/ollama pull/);
  ai.set({ kind: "drop", pieces: ["part", "ial"] });
  await previewNext(page, d);
  const dropRun = await startRaw(page, `${AI}:send`, `resource:${d}`, { resourceId: d, params: { message: said[d] } });
  let dropped: RunInfo | null = null;
  try {
    dropped = await waitRun(page, dropRun, 150); // 15 s: a dropped connection is seen at once, not after the 60 s timeout
  } catch {
    /* reported below */
  }
  finding("a connection dropped in the middle ends the run at once", () => {
    expect(dropped, "run still running after 15 s (round18-tests-done.md §Defects 3)").not.toBeNull();
    expect(dropped!.status, "an error, not half an answer").toBe("error");
    expect(dropped!.error?.message ?? "").not.toMatch(/did not answer in time/);
  });
  if (!dropped) await call(page, "command.execute", { id: "run.cancel", context: { args: { run: dropRun } } });
});

/* ------------------------------------------------------------------ K6 (D479): the conversation is kept in its resource */

test("K6/D479: the conversation is kept in its own resource; the audit holds no content", async ({ page }) => {
  await openKernel(page, host);
  const source = await runSql(page, "SELECT 'keep-me-1' AS tag, 7 AS n", "To keep");
  const draft = resourceOf(await clickAction(page, source.id));
  said[draft] = "What is n?";
  ai.set({ kind: "ok", pieces: ["The answer is ", "SEVEN-MARKER"] });
  const sent = await sendAnalysis(page, draft);
  expect(sent.status, JSON.stringify(sent.error)).toBe("success");
  ids.keepRun = source.id;
  const kept = await getRes(page, draft);
  expect(kept.body.turns.at(-1)).toMatchObject({ role: "assistant", text: "The answer is SEVEN-MARKER" });
  expect(JSON.stringify(kept.body)).not.toContain(KEY);
  // audit: what was done, never what was said
  const audit = JSON.stringify(await call(page, "audit.list", {}));
  expect(audit).toContain("runs.read");
  for (const secret of ["SEVEN-MARKER", "keep-me-1", "What is n?", KEY, OLLAMA_AUTH]) expect(audit, `audit must not contain ${secret}`).not.toContain(secret);
});

test("D442: an artifact kept in a result-area click lives with its run: listed, one per click, gone when the user deletes the run; the audit has no content", async ({ page }) => {
  await openKernel(page, host);
  const source = await runSql(page, "SELECT 'marker-row' AS tag", "Artifact source");
  const click = await clickAction(page, source.id, "org.test.keeper:keep");
  expect(click.status, JSON.stringify(click.error)).toBe("success");
  expect(JSON.parse(click.output.text).count).toBe(1);
  const rows = () => dbq(`SELECT name || '|' || kind || '|' || plugin || '|' || data FROM run_artifacts WHERE run_id = '${source.id}'`).trim();
  expect(rows()).toContain("Kept by test|note|org.test.keeper|");
  expect(rows()).toContain("ARTIFACT-MARKER");
  // not from outside a click
  const bare = await waitRun(page, await startRaw(page, "org.test.keeper:keep", "page:org.test.keeper", { input: { runId: source.id } }));
  expect(bare.status, "without a click the plugin cannot attach anything to a run").toBe("error");
  expect(rows().split("\n")).toHaveLength(1);
  const audit = JSON.stringify(await call(page, "audit.list", {}));
  expect(audit).toContain("runs.saveArtifact");
  expect(audit).not.toContain("ARTIFACT-MARKER");
  expect(audit).not.toContain("Kept by test");
  // the user keeps, then deletes the run: the artifact goes with it
  await call(page, "run.setKept", { id: source.id, kept: true, name: "Source" });
  await call(page, "command.execute", { id: "run.delete", context: { args: { run: source.id, confirmed: true } } });
  expect(dbq(`SELECT count(*) FROM runs WHERE id = '${source.id}'`).trim()).toBe("0");
  expect(rows(), "the artifact is deleted with its run").toBe("");
});

/* ------------------------------------------------------------------ K7–K9 generate SQL */

test("K7/K9 + #6: “Write with AI” under preview — the workbench makes the request and shows it; only the user's Send on that page sends it, exactly that text; no rows go; accepting puts the proposal into the editor as an unsaved change", async ({ page }) => {
  await openKernel(page, host);
  ids.sql = await create(page, SQLK, { name: "Ask AI", "body.sql": "SELECT * FROM orders", "body.source": ids.ds });
  const write = (instruction: string) =>
    runRes(page, ids.sql, "org.onedesk.sql:aiWrite", { params: { aiInstruction: instruction }, input: { "body.sql": "SELECT * FROM orders", "body.source": ids.ds } });
  ai.set({ kind: "ok", pieces: ["```sql\nSELECT customer, sum(amount) FROM orders GROUP BY customer\n```"] });
  const before = chats().length;
  const first = await write("total amount per customer, ask jane@example.com about 4111111111111111");
  expect(first.status, JSON.stringify(first.error)).toBe("success");
  expect(chats().length, "policy preview: nothing sent yet").toBe(before);
  // the preview is the workbench's own page (a draft analysis); the SQL page links to it
  const sqlView = JSON.stringify((await call<any>(page, "page.resolve", { target: `resource:${ids.sql}` })).view);
  const draft = /"target":"resource:([0-9a-f]+)"/.exec(sqlView)?.[1];
  expect(draft, "the SQL page links to the preview draft").toBeTruthy();
  const dr = await getRes(page, draft!);
  expect(dr.body.request).toContain("total amount per customer");
  expect(dr.body.request).toContain("orders"); // table names go
  expect(dr.body.request, "e-mails and long numbers in the sentence are masked").not.toContain("jane@example.com");
  expect(dr.body.request).not.toContain("4111111111111111");
  expect(String(dr.body.system), "the preview shows the system prompt too").not.toBe("");
  // before the user sends there, the SQL side has no answer to fetch
  const early = await runRes(page, ids.sql, "org.onedesk.sql:aiFetch");
  expect(JSON.stringify(early.output) + JSON.stringify(early.error)).toMatch(/not sent|send/i);
  expect(chats().length).toBe(before);
  // the user presses Send on the preview page
  const send = await runRes(page, draft!, `${AI}:send`);
  expect(send.status, JSON.stringify(send.error)).toBe("success");
  expect(chats().length).toBe(before + 1);
  const body = userText(lastChat());
  expect(body.trimEnd(), "what was sent is what the preview showed").toBe(String(dr.body.request).trimEnd());
  expect(body).not.toMatch(/\bann\b|\bbob\b|o'neil/); // rows never go (K7)
  expect(body).not.toContain("10.50");
  const fetched = await runRes(page, ids.sql, "org.onedesk.sql:aiFetch");
  expect(fetched.status, JSON.stringify(fetched.error)).toBe("success");
  // K9: accepting puts it into the editor as an unsaved change; the saved resource is untouched
  const accept = await call<{ changes?: Record<string, string>; message?: string }>(page, "page.event", { target: `resource:${ids.sql}`, event: "aiAccept" });
  expect(accept.changes?.["body.sql"]).toBe("SELECT customer, sum(amount) FROM orders GROUP BY customer");
  expect((await getRes(page, ids.sql)).body.sql, "nothing saved by accepting").toBe("SELECT * FROM orders");
});

test("#6: a caller cannot send for the user — `confirm:true` is ignored under preview; names that are not identifiers and rows in `context` do not travel", async ({ page }) => {
  await openKernel(page, host);
  const n0 = chats().length;
  ai.set({ kind: "ok", pieces: ["SELECT 1"] });
  const gen = await waitRun(
    page,
    await startRaw(page, `${AI}:generate`, `page:${AI}`, {
      input: { kind: "sql", instruction: "count orders", confirm: true, context: { tables: [{ name: "orders", columns: ["id", "ann@example.com", "x; DROP TABLE y"] }, { name: "bad name; DROP", columns: [] }], rows: [["ann", "10.50"]] } },
    }),
  );
  expect(gen.status, JSON.stringify(gen.error)).toBe("success");
  expect(chats().length, "confirm:true from a caller must not skip the preview").toBe(n0);
  const shown = String(gen.output?.text ?? "");
  expect(shown).toContain("count orders");
  expect(shown).not.toContain("ann@example.com");
  expect(shown).not.toContain("DROP");
  expect(shown).not.toMatch(/10\.50|\bann\b/);
});

test("K8: a proposal that is not one single SELECT/WITH cannot be accepted; rejecting leaves the editor alone", async ({ page }) => {
  await openKernel(page, host);
  await setEnv(page, "ai.policy", "allow"); // no preview step: the request goes at once
  const envId = await CLICK_ENV(page);
  const write = (instruction: string) => runRes(page, ids.sql, "org.onedesk.sql:aiWrite", { params: { aiInstruction: instruction }, input: { "body.sql": "SELECT * FROM orders", "body.source": ids.ds }, envId });
  const cases: [string, string][] = [
    ["DROP TABLE orders", "write"],
    ["DELETE FROM orders WHERE id = 1", "write"],
    ["SELECT 1; DROP TABLE orders", "two statements"],
    ["SELECT 1 /* harmless */; DELETE FROM orders", "comment hides nothing"],
    ["WITH x AS (DELETE FROM orders RETURNING *) SELECT * FROM x", "write inside WITH"],
    ["SELECT * INTO backup FROM orders", "SELECT INTO"],
    ["", "empty"],
  ];
  for (const [text, why] of cases) {
    ai.set({ kind: "ok", pieces: [text || " "] });
    const r = await write("do something");
    expect(r.status, `${why}: ${JSON.stringify(r.error)}`).toBe("success");
    const acc = await call<{ changes?: unknown; message?: string }>(page, "page.event", { target: `resource:${ids.sql}`, event: "aiAccept" });
    expect(acc.changes, `${why}: must not reach the editor`).toBeUndefined();
    expect(JSON.stringify(acc), `${why}: said so in words`).toMatch(/cannot|can't|No proposal|check/i);
  }
  // a harmless word inside a string or a comment is fine
  ai.set({ kind: "ok", pieces: ["SELECT 'DROP TABLE x; DELETE' AS s -- insert update\nFROM orders"] });
  await write("words");
  const ok = await call<{ changes?: Record<string, string> }>(page, "page.event", { target: `resource:${ids.sql}`, event: "aiAccept" });
  expect(ok.changes?.["body.sql"]).toContain("SELECT 'DROP TABLE x; DELETE' AS s");
  // reject: the editor text stays
  await write("again");
  const rej = await call<{ changes?: unknown; message?: string }>(page, "page.event", { target: `resource:${ids.sql}`, event: "aiDiscard" });
  expect(rej.changes).toBeUndefined();
  expect((await getRes(page, ids.sql)).body.sql).toBe("SELECT * FROM orders");
  await unsetEnv(page, "ai.policy");
});

/* ------------------------------------------------------------------ K10 ai.policy */

test("K10: ai.policy — off refuses analysis, sending and generating; preview is the default and also the answer to a bad value; allow sends a generate request at once", async ({ page }) => {
  await openKernel(page, host);
  const d = await newAnalysis(page, "Policy test");
  const n0 = chats().length;
  await setEnv(page, "ai.policy", "off");
  const env = await CLICK_ENV(page);
  // the environment of a result-area click is the source run's (D444 ④): the source ran in Default
  const src = await runSql(page, "SELECT 1 AS one", "Policy source", { envId: env });
  const click = await clickAction(page, src.id, `${AI}:analyze`, { envId: env });
  expect(click.status).toBe("error");
  expect(click.error?.message).toMatch(/turned off/i);
  const send = await sendAnalysis(page, d, {}, { envId: env });
  expect(send.status).toBe("error");
  expect(send.error?.message).toMatch(/turned off/i);
  const gen = await runRes(page, ids.sql, "org.onedesk.sql:aiWrite", { params: { aiInstruction: "x" }, input: { "body.sql": "SELECT 1", "body.source": ids.ds }, envId: env });
  expect(JSON.stringify(gen.output) + JSON.stringify(gen.error)).toMatch(/turned off/i);
  expect(chats().length, "off: nothing left the machine").toBe(n0);
  // a value nobody knows counts as preview, never as allow
  await setEnv(page, "ai.policy", "everything");
  ai.set({ kind: "ok", pieces: ["SELECT 1"] });
  await runRes(page, ids.sql, "org.onedesk.sql:aiWrite", { params: { aiInstruction: "x" }, input: { "body.sql": "SELECT 1", "body.source": ids.ds }, envId: env });
  expect(chats().length, "unknown value = preview: not sent").toBe(n0);
  await setEnv(page, "ai.policy", "allow");
  await runRes(page, ids.sql, "org.onedesk.sql:aiWrite", { params: { aiInstruction: "x" }, input: { "body.sql": "SELECT 1", "body.source": ids.ds }, envId: env });
  expect(chats().length, "allow: a request without data goes at once").toBe(n0 + 1);
  await unsetEnv(page, "ai.policy");
});

/* ------------------------------------------------------------------ the whole run: nothing leaks */

test("K5: after everything, the API keys are in no file, no run, no resource, no audit row, no search hit", async ({ page }) => {
  await openKernel(page, host);
  expect(grepData(KEY), "API key in the data directory").toBe("");
  expect(grepData("OLLAMA-e2e-token-5519")).toBe("");
  const audit = JSON.stringify(await call(page, "audit.list", {}));
  expect(audit).not.toContain(KEY);
  const runs = JSON.stringify(await call(page, "run.tasks", {}));
  expect(runs).not.toContain(KEY);
  expect(JSON.stringify(await getRes(page, ids.anth))).not.toContain(KEY);
  expect(JSON.stringify(await getRes(page, ids.ollama))).not.toContain("OLLAMA-e2e");
  for (const t of dbq(".tables").split(/\s+/).filter(Boolean)) expect(dbq(`.dump ${t}`), `table ${t}`).not.toContain(KEY);
  // only the connections' own host was ever contacted: the fake saw every request
  expect(ai.requests.every((r) => r.path.startsWith("/v1/") || r.path.startsWith("/api/"))).toBe(true);
});

/* ------------------------------------------------------------------ the shell (screenshots) */

test("shell: the result area shows an Analyze button on a table; Analyze makes a chat; the first Send shows the full text with the connection and the token estimate; the answer is readable Markdown", async ({ page }) => {
  await openKernel(page, host);
  mkdirSync(OUT, { recursive: true });
  const nav = page.getByRole("navigation", { name: "Views" }).getByRole("button", { name: "Resources", exact: true });
  if ((await nav.getAttribute("aria-pressed")) !== "true") await nav.click();
  await page.getByRole("treeitem", { name: "Orders", exact: true }).first().dblclick();
  await page.getByRole("button", { name: "Run", exact: true }).click();
  const analyze = page.getByRole("button", { name: "Analyze" });
  await expect(analyze).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: path.join(OUT, "round18-result-actions.png") });
  const keys = async () => new Set((await nodes(page, "resources")).map((n) => n.key));
  const before = await keys();
  await analyze.click();
  await expect.poll(async () => [...(await keys())].filter((k) => !before.has(k)).length, { timeout: 15_000 }).toBe(1);
  const draftKey = [...(await keys())].find((k) => !before.has(k))!;
  await page.waitForTimeout(500);
  await findingA("clicking Analyze lands on the chat (a link result opens its target)", async () => {
    expect(await page.getByText(/Connection: Fake Anthropic/).count()).toBeGreaterThan(0);
  });
  // the shell shows a run tab with an empty body today: open the draft from the tree to carry on
  await ui.nodeKey(page, draftKey).dblclick();
  await expect(page.getByText(/Connection: Fake Anthropic/).first()).toBeVisible({ timeout: 15_000 });
  const area = page.getByRole("region", { name: "Result area" });
  // Nothing typed: the description (the default analysis request) is what is asked. The first Send is the preview.
  await page.getByRole("button", { name: "Send" }).first().click();
  await expect(area.getByText(/tokens will be sent/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(area.getByText(/Fake Anthropic/).first()).toBeVisible();
  await page.screenshot({ path: path.join(OUT, "round18-analysis-preview.png") });
  ai.set({ kind: "slow", pieces: ["## Summary\n\n", "- first point\n", "- **second** point\n", "\nDone."], delayMs: 1500 });
  await page.getByRole("button", { name: "Send" }).first().click();
  await expect(area.locator("li", { hasText: "first point" })).toBeVisible({ timeout: 20_000 }); // Markdown: a real list item, not the raw text
  await page.screenshot({ path: path.join(OUT, "round18-streaming-answer.png") });
  // the answer is in the result area (the run output) and, once stored, on the page body too: look in the result area
  await expect(area.locator("p", { hasText: "Done." })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/Answered by/).first()).toBeVisible({ timeout: 20_000 }); // the run has ended: the final output replaced the partial one
  await page.screenshot({ path: path.join(OUT, "round18-answer.png") });
  await findingA("the finished answer is shown as readable Markdown, like the partial one was", async () => {
    await expect(area.getByRole("heading", { name: "Summary" })).toBeVisible({ timeout: 2000 });
  });
});

test("no assertion about a known defect failed along the way", () => {
  expect(defects, defects.join("\n")).toEqual([]);
});
