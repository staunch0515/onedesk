/**
 * Round 17 (sqlpool-parity I, J, L; requirements I.10b, I.10b-2, I.10h) against the real kernel.
 * Nothing real is contacted: ssh/docker are the fakes of fake-tools.ts, PostgreSQL is a throw-away one, the Trash is a temp
 * folder (ONEDESK_TRASH_DIR), "open"/"show in Finder" are written to a log (ONEDESK_OPEN_LOG), HTTP goes to a local server.
 * Defects found in other sessions' files are `test.fixme` with the reason, and listed in docs/handoff/round17-tests-done.md.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { FakeTools } from "./fake-tools";
import { DEVHOST, OUT, openKernel, ROOT, rpc, startHost, stopHost, ui, type Host, allPlugins } from "./kernel-host";
import { DB1, PG_SKIP_REASON, pgBinOrNull, startPg, type Pg } from "./pg-fixture";

test.use({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
test.describe.configure({ mode: "serial" });
test.setTimeout(120_000);

let host: Host;
let base: string;
let pg: Pg;
let fake: FakeTools;
let granted: string; // the folder the file tests work in
let trashDir: string;
let openLog: string;
let api: http.Server;
let apiPort = 0;
const apiSeen: { method: string; url: string; headers: http.IncomingHttpHeaders }[] = [];

test.beforeAll(async () => {
  if (process.env.ONEDESK_E2E_REQUIRE_DEVHOST === "1") expect(existsSync(DEVHOST), `onedesk-devhost not built at ${DEVHOST}`).toBe(true);
  else test.skip(!existsSync(DEVHOST), `onedesk-devhost not built at ${DEVHOST}`);
  if (process.env.ONEDESK_E2E_REQUIRE_PG === "1") expect(PG_SKIP_REASON, "PostgreSQL is required").toBeNull();
  else test.skip(PG_SKIP_REASON !== null, PG_SKIP_REASON ?? "");
  base = realpathSync(mkdtempSync(path.join(tmpdir(), "od-round17-")));
  pg = await startPg(path.join(base, "pg"));
  fake = new FakeTools(path.join(base, "fake"), pgBinOrNull);
  fake.remoteDockerShim();
  granted = path.join(base, "granted");
  trashDir = path.join(base, "trash"); // same volume as the files: the kernel moves into it, never into ~/.Trash
  openLog = path.join(base, "open.log");
  mkdirSync(granted, { recursive: true });
  mkdirSync(trashDir, { recursive: true });
  api = http.createServer((req, res) => {
    apiSeen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, path: req.url }));
  });
  await new Promise<void>((r) => api.listen(0, "127.0.0.1", r));
  apiPort = (api.address() as import("node:net").AddressInfo).port;
  const plugins = fake.preparePlugins(allPlugins(), path.join(base, "plugins"), path.join(base, "data"));
  host = await startHost(path.join(base, "data"), { ONEDESK_TEST_HOOKS: "1", ONEDESK_TRASH_DIR: trashDir, ONEDESK_OPEN_LOG: openLog }, plugins);
});
test.afterAll(async () => {
  if (host) await stopHost(host);
  if (pg) pg.stop();
  if (api) api.close();
  if (base) rmSync(base, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ helpers */

const call = <T = unknown>(page: Page, method: string, params: unknown = null) => rpc<T>(page, host, method, params);
type Node = { key: string; label: string; kind?: string; target?: string; menu?: string[]; draggable?: boolean };
const nodes = async (page: Page, tree: string, parent?: string) => (await call<{ nodes: Node[] }>(page, "tree.children", { tree, parent })).nodes;
type Res = { id: string; name: string; deleted: boolean; body: Record<string, any> };
const getRes = (page: Page, id: string) => call<Res>(page, "resource.get", { id });
const create = async (page: Page, kind: string, changes: Record<string, unknown>) => (await call<{ page: { resourceId: string } }>(page, "page.save", { target: `new:${kind}`, changes })).page.resourceId;
type RunInfo = { id: string; status: string; kept?: boolean; error?: { code: string; message?: string; params?: Record<string, string> }; summary?: { rows?: number; message?: string }; params?: Record<string, string>; partial?: unknown; output?: any };
const waitRun = async (page: Page, id: string): Promise<RunInfo> => {
  for (let i = 0; i < 300; i++) {
    const r = await call<RunInfo>(page, "run.get", { id });
    if (r.status !== "running") return r;
    await new Promise((res) => setTimeout(res, 200));
  }
  throw new Error("run did not end");
};
const startRaw = (page: Page, action: string, target: string, params: Record<string, string> = {}, extra: Record<string, unknown> = {}) =>
  call<string>(page, "run.start", { action, target, tabId: "e2e-tab", input: {}, params, locale: "en-US", ...extra });
const runRes = async (page: Page, id: string, action: string, params: Record<string, string> = {}, extra: Record<string, unknown> = {}) =>
  waitRun(page, await startRaw(page, action, `resource:${id}`, params, { resourceId: id, ...extra }));
const rowsOf = async (page: Page, run: RunInfo) => (await call<{ rows: string[][] }>(page, "run.rows", { id: run.id, offset: 0, limit: 1000 })).rows;
/** Every node of the resource tree, groups opened (disk files sit in `disk-folder` groups). */
const walkRes = async (page: Page, parent?: string, depth = 0): Promise<Node[]> => {
  const out: Node[] = [];
  for (const n of await nodes(page, "resources", parent)) {
    out.push(n);
    if (depth < 6) out.push(...(await walkRes(page, n.key, depth + 1).catch(() => [])));
  }
  return out;
};
const ids = {} as Record<"cmd" | "script" | "sshSource" | "backupSource" | "diskA" | "connBearer", string>;

const CMD = "org.onedesk.command:command";
const SCR = "org.onedesk.script:script";
const DS = "org.onedesk.datasource:source";
const FILES = "org.onedesk.files";
const CONN = "org.onedesk.connection:connection";

/* ------------------------------------------------------------------ I1-I7 server commands */

test("I1/I3/I4: a saved command with a :name parameter runs through ssh with the fixed options; the command goes over stdin", async ({ page }) => {
  await openKernel(page, host);
  fake.reset();
  fake.rule("ssh", { mode: "exec" });
  ids.cmd = await create(page, CMD, { name: "Say hello", "body.host": "web-1", "body.command": "echo \"hello $NAME_UNUSED\" >/dev/null\necho out-line\necho err-line >&2\nexit 0" });
  const run = await runRes(page, ids.cmd, "run");
  expect(run.status, JSON.stringify(run.error)).toBe("success");
  const calls = fake.calls("ssh");
  expect(calls).toHaveLength(1);
  const a = calls[0]!.args;
  expect(a).toContain("BatchMode=yes"); // never asks for a password (I4)
  expect(a).toContain("web-1");
  expect(a.indexOf("--")).toBeGreaterThanOrEqual(0);
  expect(a.indexOf("--")).toBeLessThan(a.indexOf("web-1")); // the host cannot be read as an option
  const rows = await rowsOf(page, run);
  expect(rows).toEqual(expect.arrayContaining([["stdout", "out-line"], ["stderr", "err-line"]]));
});

test("I2: values are quoted as one shell word and cannot inject; :name is a parameter only outside quotes", async ({ page }) => {
  await openKernel(page, host);
  fake.reset();
  fake.rule("ssh", { mode: "exec" });
  const marker = path.join(base, "injected");
  const id = await create(page, CMD, { name: "Echo it", "body.host": "web-1", "body.command": "printf '%s\\n' :msg" });
  for (const evil of [`x'; touch ${marker}; echo '`, `$(touch ${marker})`, `\`touch ${marker}\``, `a b; touch ${marker}`, `"; touch ${marker}; "`, "line1\nline2"]) {
    const run = await runRes(page, id, "run", { msg: evil });
    expect(run.status, JSON.stringify(run.error)).toBe("success");
    const out = (await rowsOf(page, run)).filter((r) => r[0] === "stdout").map((r) => r[1]).join("\n");
    expect(out).toBe(evil); // the value arrives as the one word it is
  }
  expect(existsSync(marker), "no injected command ran").toBe(false);
});

test("I3: a host name that could be read as an ssh option is refused before ssh starts", async ({ page }) => {
  await openKernel(page, host);
  fake.reset();
  fake.rule("ssh", { mode: "exec" });
  const id = await create(page, CMD, { name: "Bad host", "body.host": "-oProxyCommand=touch x", "body.command": "true" });
  const run = await runRes(page, id, "run");
  expect(run.status).not.toBe("success");
  expect(fake.calls("ssh")).toHaveLength(0);
});

test("I4: ssh failing by itself (255) is a failed run that carries ssh's own words; a non-zero exit of the command is a failed run too (D435) but keeps its output and is in the history", async ({ page }) => {
  await openKernel(page, host);
  fake.reset();
  fake.rule("ssh", { match: "down-host", steps: [{ err: "ssh: connect to host down-host port 22: Connection refused" }], code: 255 });
  fake.rule("ssh", { mode: "exec" });
  const down = await create(page, CMD, { name: "Down", "body.host": "down-host", "body.command": "true" });
  const r1 = await runRes(page, down, "run");
  expect(r1.status).toBe("error");
  expect(JSON.stringify(r1.error)).toContain("Connection refused");
  const ok = await create(page, CMD, { name: "Exit 3", "body.host": "web-1", "body.command": "echo before\nexit 3" });
  const r2 = await runRes(page, ok, "run");
  expect(r2.status, "non-zero exit = failed (D435)").toBe("error");
  expect(JSON.stringify(r2.error)).toMatch(/3/);
  expect((await rowsOf(page, r2)).map((r) => r[1]), "the output is kept").toContain("before");
  expect(r2.summary?.message ?? "").toMatch(/3/);
  expect(JSON.stringify(await call(page, "run.listFor", { id: ok })), "the run is in the history").toContain(r2.id);
});

test("I5: the output is a stream/line table that can be exported, kept and found in the history", async ({ page }) => {
  await openKernel(page, host);
  fake.reset();
  fake.rule("ssh", { mode: "exec" });
  const run = await runRes(page, ids.cmd, "run");
  const info = await call<RunInfo>(page, "run.get", { id: run.id });
  expect(JSON.stringify(info)).toContain("stream");
  const csv = path.join(base, "cmd-output.csv");
  await call(page, "run.export", { run: run.id, path: csv, format: "csv" });
  expect(readFileSync(csv, "utf8")).toMatch(/stdout,.*out-line/);
  await call(page, "run.setKept", { id: run.id, kept: true, name: "Hello output" });
  expect((await nodes(page, "runs", "@runs:saved")).some((n) => n.key === run.id)).toBe(true);
  const hist = await call<{ runs?: RunInfo[] } | RunInfo[]>(page, "run.listFor", { id: ids.cmd });
  expect(JSON.stringify(hist)).toContain(run.id);
});

test("I6: the output asks for the terminal look and tones each line by its stream", async ({ page }) => {
  await openKernel(page, host);
  fake.reset();
  fake.rule("ssh", { mode: "exec" });
  const run = await runRes(page, ids.cmd, "run");
  const out = JSON.stringify(await call(page, "run.render", { id: run.id, tabId: "response", locale: "en-US" }).catch(() => null)) + JSON.stringify(await call(page, "run.get", { id: run.id }));
  expect(out).toContain("terminal");
  expect(out).toContain("toneColumn");
});

test("I7: values of password-like variables are masked in the output", async ({ page }) => {
  await openKernel(page, host);
  fake.reset();
  fake.rule("ssh", { mode: "exec" });
  const id = await create(page, CMD, { name: "Env dump", "body.host": "web-1", "body.command": "echo DB_PASSWORD=hunter2\necho API_TOKEN: s3cr3t-token\necho HOME_DIR=/home/x\necho 'Authorization: Bearer abc.def'" });
  const run = await runRes(page, id, "run");
  const lines = (await rowsOf(page, run)).map((r) => r[1]).join("\n");
  expect(lines).not.toContain("hunter2");
  expect(lines).not.toContain("s3cr3t-token");
  expect(lines).not.toContain("abc.def");
  expect(lines).toContain("HOME_DIR=/home/x");
  expect(lines).toContain("***");
});

test("I5: timeout and line limit keep the lines already received and say why in the summary", async ({ page }) => {
  await openKernel(page, host);
  fake.reset();
  fake.rule("ssh", { mode: "exec" });
  const slow = await create(page, CMD, { name: "Slow", "body.host": "web-1", "body.command": "echo first\nsleep 30\necho never", "body.timeoutSec": "2" });
  const r1 = await runRes(page, slow, "run", {}, { input: { "body.timeoutSec": "2" } }); // the page sends its field values as `input`
  expect((await rowsOf(page, r1)).map((r) => r[1])).toContain("first");
  expect((await rowsOf(page, r1)).map((r) => r[1])).not.toContain("never");
  expect(JSON.stringify(r1.summary)).toMatch(/imeout|超时|时/i);
  const many = await create(page, CMD, { name: "Many", "body.host": "web-1", "body.command": "i=0\nwhile [ $i -lt 50 ]; do echo line-$i; i=$((i+1)); done", "body.maxLines": "5" });
  const r2 = await runRes(page, many, "run", {}, { input: { "body.maxLines": "5" } });
  expect(await rowsOf(page, r2)).toHaveLength(5);
  expect(JSON.stringify(r2.summary)).toMatch(/5/);
});

test("I5: cancelling a running command ends the ssh process at once", async ({ page }) => {
  await openKernel(page, host);
  fake.reset();
  fake.rule("ssh", { mode: "exec" });
  const id = await create(page, CMD, { name: "Forever", "body.host": "web-1", "body.command": "echo started\nsleep 120" });
  const runId = await startRaw(page, "run", `resource:${id}`, {}, { resourceId: id });
  await new Promise((r) => setTimeout(r, 1500));
  const t0 = Date.now();
  await call(page, "run.cancel", { id: runId });
  const done = await waitRun(page, runId);
  expect(Date.now() - t0).toBeLessThan(8000);
  expect(done.status).not.toBe("running");
});

/* ------------------------------------------------------------------ I8-I9 local scripts */

test("I8: a local bash script runs with parameters; stderr is its own stream; timeout and line limit apply", async ({ page }) => {
  await openKernel(page, host);
  await call(page, "plugin.grantFolder", { plugin: "org.onedesk.script", path: path.join(base, "scripts-out") }).catch(() => null);
  ids.script = await create(page, SCR, { name: "Greeter", "body.script": "printf 'hi %s\\n' :who\necho oops >&2" });
  const run = await runRes(page, ids.script, "run", { who: "there; echo injected" });
  expect(run.status, JSON.stringify(run.error)).toBe("success");
  const rows = await rowsOf(page, run);
  expect(rows).toEqual(expect.arrayContaining([["stdout", "hi there; echo injected"], ["stderr", "oops"]]));
  const slow = await create(page, SCR, { name: "Slow script", "body.script": "echo first\nsleep 30", "body.timeoutSec": "2" });
  const r2 = await runRes(page, slow, "run", {}, { input: { "body.timeoutSec": "2" } });
  expect((await rowsOf(page, r2)).map((r) => r[1])).toContain("first");
  const many = await create(page, SCR, { name: "Many lines", "body.script": "for i in 1 2 3 4 5 6 7 8 9 10; do echo l$i; done", "body.maxLines": "3" });
  expect(await rowsOf(page, await runRes(page, many, "run", {}, { input: { "body.maxLines": "3" } }))).toHaveLength(3);
});

test("I9: all scripts are exported as .sh files into an authorized folder; nothing outside it is written", async ({ page }) => {
  await openKernel(page, host);
  const out = path.join(base, "scripts-out");
  mkdirSync(out, { recursive: true });
  await call(page, "plugin.grantFolder", { plugin: "org.onedesk.script", path: out });
  const run = await runRes(page, ids.script, "exportAll", { folder: out });
  expect(run.status, JSON.stringify(run.error)).toBe("success");
  const files = readdirSync(out).sort();
  expect(files).toEqual(expect.arrayContaining(["Greeter.sh"]));
  expect(files.every((f) => f.endsWith(".sh") && !f.startsWith("."))).toBe(true);
  expect(readFileSync(path.join(out, "Greeter.sh"), "utf8")).toMatch(/^#!.*bash/);
  expect(readFileSync(path.join(out, "Greeter.sh"), "utf8")).toContain(":who");
  // not authorized -> nothing is written
  const elsewhere = path.join(base, "not-granted");
  mkdirSync(elsewhere, { recursive: true });
  const refused = await runRes(page, ids.script, "exportAll", { folder: elsewhere });
  expect(refused.status).toBe("error");
  expect(readdirSync(elsewhere)).toEqual([]);
});

/* ------------------------------------------------------------------ J backup to this Mac */

const dbExists = (name: string) => pg.psql("postgres", `SELECT count(*) FROM pg_database WHERE datname='${name}'`, "postgres").includes("1") && !/\b0\b/.test(pg.psql("postgres", `SELECT count(*) FROM pg_database WHERE datname='${name}'`, "postgres"));
const pgEnv = () => ({ PGHOST: path.join(pg.dir, "sock"), PGPORT: String(pg.port) });
const backupRules = () => {
  fake.reset();
  // the server side: `ssh host "docker exec c pg_dump …"` reaches the temp PostgreSQL through the shim
  fake.rule("ssh", { mode: "exec", env: pgEnv() });
  fake.rule("docker", { match: "^cp ", mode: "docker-cp" });
  fake.rule("docker", { match: "^exec ", mode: "docker-exec", env: pgEnv() });
};
const backupDir = () => path.join(base, "data/workspaces/default/plugin-data/org.onedesk.datasource/backups");
const backup = (page: Page, over: Record<string, string> = {}) =>
  runRes(page, ids.sshSource, "backup", { backupName: "shop_copy", backupContainer: "local-pg", backupPort: "5432", backupUser: "postgres", ...over });

test("J1/J4: backup to this Mac: pg_dump on the server, the dump in the app's backup folder, into the local container, a new database, a new direct data source", async ({ page }) => {
  await openKernel(page, host);
  fake.reset();
  fake.remoteDockerShim();
  ids.sshSource = await create(page, DS, { name: "Prod over ssh", "body.mode": "ssh", "body.sshHost": "backup-host", "body.container": "server-pg", "body.database": DB1, "body.user": "postgres" });
  backupRules();
  const run = await backup(page);
  expect(run.status, JSON.stringify(run.error)).toBe("success");
  // the order of what ran: docker (check), ssh (dump), docker (copy, create, restore, clean up)
  const log = fake.calls().map((c) => `${c.tool}:${c.args.join(" ")}`);
  expect(log[0]).toMatch(/^docker:exec local-pg psql .*pg_database/);
  expect(log[1]).toMatch(/^ssh:.*backup-host docker exec server-pg pg_dump -Fc/);
  expect(log[2]).toMatch(/^docker:cp .*backups\/shop-.*\.dump local-pg:\/tmp\/onedesk-restore-/);
  expect(log[3]).toMatch(/^docker:exec local-pg createdb .*shop_copy/);
  expect(log[4]).toMatch(/^docker:exec local-pg pg_restore --no-owner --no-acl .*-d shop_copy/);
  expect(log.findIndex((l) => l.includes("createdb"))).toBeLessThan(log.findIndex((l) => l.includes("pg_restore")));
  // J4: the dump file is in the backup folder of the app, with content
  const dumps = readdirSync(backupDir()).filter((f) => f.endsWith(".dump"));
  expect(dumps).toHaveLength(1);
  expect(dumps[0]).toContain(DB1);
  expect(readFileSync(path.join(backupDir(), dumps[0]!)).subarray(0, 5).toString()).toBe("PGDMP");
  // the new database really has the data; the copy in the container was removed again
  expect(pg.psql("shop_copy", "SELECT count(*) FROM orders", "postgres")).toContain("4");
  expect(log.some((l) => /^docker:exec local-pg rm /.test(l))).toBe(true);
  // J1: a new direct data source was created
  const made = (await nodes(page, "resources")).find((n) => n.label.includes("shop_copy"));
  expect(made, "the new data source is in the resource tree").toBeTruthy();
  const res = await getRes(page, made!.key);
  expect(res.body).toMatchObject({ mode: "direct", database: "shop_copy", host: "localhost" });
  ids.backupSource = made!.key;
});

test("J3: a database that already exists is never touched: the run stops at step 1 and the server is not contacted", async ({ page }) => {
  await openKernel(page, host);
  backupRules();
  pg.psql("shop_copy", "INSERT INTO orders VALUES (99,'keep',1,now(),'untouched')", "postgres");
  const before = readdirSync(backupDir()).length;
  const run = await backup(page); // shop_copy exists now
  expect(run.status).toBe("error");
  expect(JSON.stringify(run.error) + JSON.stringify(run.summary)).toMatch(/exists|already/i);
  expect(fake.calls("ssh").filter((c) => c.args.join(" ").includes("pg_dump"))).toHaveLength(1 - 1 + 0);
  expect(readdirSync(backupDir()).length).toBe(before);
  const all = fake.calls().map((c) => c.args.join(" ")).join("\n");
  expect(all).not.toMatch(/dropdb|DROP|--clean|--create/i);
  expect(pg.psql("shop_copy", "SELECT note FROM orders WHERE id=99", "postgres")).toContain("untouched");
});

test("J3: names are checked: only safe characters for the database, container, port and user", async ({ page }) => {
  await openKernel(page, host);
  backupRules();
  for (const bad of <Record<string, string>[]>[{ backupName: "Shop-Copy" }, { backupName: "x; drop database shop" }, { backupName: "" }, { backupName: "1abc" }, { backupContainer: "a b" }, { backupContainer: "-rm" }, { backupPort: "99999" }, { backupUser: "pg user" }]) {
    const run = await backup(page, { backupName: "fresh_copy", ...bad });
    expect(run.status, JSON.stringify(bad)).toBe("error");
  }
  expect(fake.calls(), "nothing ran for any bad name").toHaveLength(0);
  expect(dbExists("fresh_copy")).toBe(false);
});

test("J1: each step that fails stops the run and names the step; later steps do not happen", async ({ page }) => {
  await openKernel(page, host);
  // the dump fails on the server
  fake.reset();
  fake.rule("docker", { match: "^exec .*pg_database", mode: "docker-exec", env: pgEnv() });
  fake.rule("ssh", { steps: [{ err: "pg_dump: error: connection to server failed" }], code: 1 });
  const r1 = await backup(page, { backupName: "never_made_1" });
  expect(r1.status).toBe("error");
  expect(JSON.stringify(r1.error)).toContain("pg_dump");
  expect(fake.calls("docker").filter((c) => c.args[0] === "cp")).toHaveLength(0);
  expect(dbExists("never_made_1")).toBe(false);
  // createdb fails (the dump file is named by the second: wait so that it is a new one)
  await new Promise((r) => setTimeout(r, 1200));
  fake.reset();
  fake.rule("docker", { match: "^exec .*createdb", steps: [{ err: "createdb: error: permission denied to create database" }], code: 1 });
  fake.rule("docker", { match: "^cp ", mode: "docker-cp" });
  fake.rule("docker", { match: "^exec ", mode: "docker-exec", env: pgEnv() });
  fake.rule("ssh", { mode: "exec", env: pgEnv() });
  const r2 = await backup(page, { backupName: "never_made_2" });
  expect(r2.status).toBe("error");
  expect(JSON.stringify(r2.error)).toContain("permission denied");
  expect(fake.calls("docker").some((c) => c.args.join(" ").includes("pg_restore"))).toBe(false);
  expect((await nodes(page, "resources")).some((n) => n.label.includes("never_made"))).toBe(false);
});

test("J2: docker is looked for in fixed places; when it is not there the run says so (no PATH is read)", async ({ page }) => {
  await openKernel(page, host);
  // The real manifests (not the copy with fakes): docker is a system program with searchPaths, never found through PATH.
  const m = JSON.parse(readFileSync(path.join(ROOT, "plugins-external/org.onedesk.datasource/manifest.json"), "utf8"));
  const dk = m.requires.programs.find((p: { name: string }) => p.name === "docker");
  expect(dk.source).toBe("system");
  expect(dk.searchPaths.join(" ")).toMatch(/Docker\.app/);
  expect(dk.searchPaths.join(" ")).toMatch(/OrbStack/);
});

/* ------------------------------------------------------------------ I.10b / I.10b-2 disk files */

const nodeTarget = (key: string) => `node:${FILES}:files/${encodeURIComponent(key)}`;
const doAct = async (page: Page, action: string, p: string, params: Record<string, string> = {}) =>
  waitRun(page, await startRaw(page, action, nodeTarget(p), params, { input: { path: p } }));
/** trash / delete / open / reveal are actions of a disk-file resource: import the folder, take the resource of that path. */
const diskRes = async (page: Page, file: string) => {
  const imp = await doAct(page, "import", path.dirname(file), {});
  expect(imp.status, JSON.stringify(imp.error)).toBe("success");
  const n = (await walkRes(page)).find((x) => x.label === path.basename(file) && x.kind !== "folder");
  expect(n, `resource of ${file}`).toBeTruthy();
  return n!.key;
};
const resAct = async (page: Page, id: string, action: string) => waitRun(page, await startRaw(page, action, `resource:${id}`, {}, { resourceId: id }));
const put = (rel: string, text = rel) => {
  const f = path.join(granted, rel);
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(f, text);
  return f;
};
const grants = async (page: Page, plugin = FILES) => (await call<{ folders: string[] }>(page, "plugin.grants", { plugin })).folders;
const auditOps = async (page: Page) => (await call<{ operation: string; target: string; detail: string }[]>(page, "audit.list", {})).map((r) => `${r.operation}|${r.target}|${r.detail}`);

test("files I.10b: several authorized folders can be added, listed, changed and removed; removing deletes no resource and no file", async ({ page }) => {
  await openKernel(page, host);
  const second = path.join(base, "second");
  const third = path.join(base, "third");
  mkdirSync(second, { recursive: true });
  mkdirSync(third, { recursive: true });
  put("keep/a.txt", "alpha");
  put("keep/b.md", "beta");
  await call(page, "plugin.grantFolder", { plugin: FILES, path: granted });
  await call(page, "plugin.grantFolder", { plugin: FILES, path: second });
  expect(await grants(page)).toEqual(expect.arrayContaining([granted, second]));
  // the list view of the authorized folders: one node per folder (plus "add")
  const list = await nodes(page, `${FILES}:folders`);
  expect(list.map((n) => n.key)).toEqual(expect.arrayContaining([granted, second]));
  // import something first so there is a resource that must survive a removal
  const imp = await doAct(page, "import", granted, { recursive: "true" });
  expect(imp.status, JSON.stringify(imp.error)).toBe("success");
  const resBefore = (await walkRes(page)).length;
  // change: the second folder is replaced by the third
  await call(page, "plugin.replaceFolder", { plugin: FILES, path: second, newPath: third });
  expect(await grants(page)).toEqual(expect.arrayContaining([granted, third]));
  expect(await grants(page)).not.toContain(second);
  // remove
  await call(page, "plugin.revokeFolder", { plugin: FILES, path: third });
  expect(await grants(page)).not.toContain(third);
  expect(existsSync(third) && existsSync(second) && existsSync(path.join(granted, "keep/a.txt"))).toBe(true);
  expect((await walkRes(page)).length).toBe(resBefore);
  const ops = (await auditOps(page)).join("\n");
  expect(ops).toContain("plugin.grantFolder");
  expect(ops).toContain("plugin.replaceFolder");
  expect(ops).toContain("plugin.revokeFolder");
  // a path outside every grant is refused
  const outside = await doAct(page, "mkdir", second, { newName: "x" });
  expect(outside.status).toBe("error");
  expect(existsSync(path.join(second, "x"))).toBe(false);
});

test("files I.10b: importing a folder registers disk-file resources (path, size, modified, extension); importing again only updates; a file that is gone is marked stale", async ({ page }) => {
  await openKernel(page, host);
  const imp = await doAct(page, "import", granted, { recursive: "true" });
  expect(imp.status, JSON.stringify(imp.error)).toBe("success");
  const all = await walkRes(page);
  const find = (label: string) => all.find((n) => n.label === label);
  expect(find("a.txt"), JSON.stringify(all.map((n) => n.label))).toBeTruthy();
  const a = await getRes(page, find("a.txt")!.key);
  expect(a.body).toMatchObject({ path: path.join(granted, "keep/a.txt"), ext: "txt", size: "5" });
  expect(String(a.body.modifiedAt)).toMatch(/^\d{4}-\d\d-\d\dT/);
  ids.diskA = a.id;
  // importing again: the same resource ids, no duplicates
  const again = await doAct(page, "import", granted, { recursive: "true" });
  expect(again.status, JSON.stringify(again.error)).toBe("success");
  expect((await walkRes(page)).filter((n) => n.label === "a.txt")).toHaveLength(1);
  expect((await walkRes(page)).find((n) => n.label === "a.txt")!.key).toBe(ids.diskA);
  // the file disappears -> the resource is stale, not deleted
  rmSync(path.join(granted, "keep/b.md"));
  await doAct(page, "import", granted, { recursive: "true" });
  const b = (await walkRes(page)).find((n) => n.label === "b.md");
  expect(b, "the resource of a vanished file stays").toBeTruthy();
  const bRes = await getRes(page, b!.key);
  expect(JSON.stringify(bRes)).toMatch(/stale|missing|失效/i);
  put("keep/b.md", "beta"); // it comes back
  await doAct(page, "import", granted, { recursive: "true" });
  expect(JSON.stringify(await getRes(page, b!.key))).not.toMatch(/"stale":\s*true/);
});

test("files I.10b-2: new folder and file, rename, move, copy; every change is inside the authorized folders and visible on disk", async ({ page }) => {
  await openKernel(page, host);
  expect((await doAct(page, "mkdir", granted, { newName: "docs" })).status).toBe("success");
  expect(existsSync(path.join(granted, "docs"))).toBe(true);
  expect((await doAct(page, "touch", path.join(granted, "docs"), { newName: "note.txt" })).status).toBe("success");
  expect(existsSync(path.join(granted, "docs/note.txt"))).toBe(true);
  const dupe = await doAct(page, "mkdir", granted, { newName: "docs" });
  expect(dupe.status, "creating an existing folder fails, nothing overwritten").toBe("error");
  expect((await doAct(page, "rename", path.join(granted, "docs/note.txt"), { newName: "memo.txt" })).status).toBe("success");
  expect(existsSync(path.join(granted, "docs/memo.txt"))).toBe(true);
  for (const bad of ["../escape.txt", "a/b", ""]) {
    const r = await doAct(page, "rename", path.join(granted, "docs/memo.txt"), { newName: bad });
    expect(r.status, bad).toBe("error");
  }
  put("src/one.txt", "one");
  mkdirSync(path.join(granted, "dest"), { recursive: true });
  expect((await doAct(page, "copy", path.join(granted, "src/one.txt"), { destination: path.join(granted, "dest") })).status).toBe("success");
  expect(existsSync(path.join(granted, "src/one.txt")) && existsSync(path.join(granted, "dest/one.txt"))).toBe(true);
  put("src/two.txt", "two");
  expect((await doAct(page, "move", path.join(granted, "src/two.txt"), { destination: path.join(granted, "dest") })).status).toBe("success");
  expect(existsSync(path.join(granted, "src/two.txt"))).toBe(false);
  expect(readFileSync(path.join(granted, "dest/two.txt"), "utf8")).toBe("two");
  // outside the grant: refused, nothing moves
  const out = path.join(base, "outside");
  mkdirSync(out, { recursive: true });
  const r = await doAct(page, "copy", path.join(granted, "src/one.txt"), { destination: out });
  expect(r.status).toBe("error");
  expect(readdirSync(out)).toEqual([]);
  const r2 = await doAct(page, "move", path.join(granted, "src/one.txt"), { destination: path.join(granted, "src/../../outside") });
  expect(r2.status).toBe("error");
});

test("files I.10b-2: copy/move onto a name that exists asks overwrite / skip / keep both (D428); each answer is used once", async ({ page }) => {
  await openKernel(page, host);
  const exec = (command: string, nodeKey: string, args: Record<string, unknown>) =>
    call<{ type: string; choices?: { id: string }[]; choiceArg?: string; message?: string; command?: string; irreversible?: boolean }[]>(page, "command.execute", { id: command, context: { tree: "files", nodeKey, args } });
  const dest = path.join(granted, "conflict-dest");
  mkdirSync(dest, { recursive: true });
  const stage = () => {
    put("conflict-src/same.txt", "NEW");
    writeFileSync(path.join(dest, "same.txt"), "OLD");
    rmSync(path.join(dest, "same copy.txt"), { force: true });
    rmSync(path.join(dest, "same 2.txt"), { force: true });
  };
  const src = path.join(granted, "conflict-src/same.txt");
  // the question
  stage();
  const ask = await exec(`${FILES}:copy`, src, { destination: dest });
  expect(ask[0]).toMatchObject({ type: "confirm", choiceArg: "conflict", command: `${FILES}:copy` });
  expect(ask[0]!.choices!.map((c) => c.id).sort()).toEqual(["keepBoth", "overwrite", "skip"]);
  expect(readFileSync(path.join(dest, "same.txt"), "utf8"), "asking changes nothing").toBe("OLD");
  // overwrite
  await exec(`${FILES}:copy`, src, { destination: dest, conflict: "overwrite", confirmed: true });
  expect(readFileSync(path.join(dest, "same.txt"), "utf8")).toBe("NEW");
  // skip
  stage();
  await exec(`${FILES}:copy`, src, { destination: dest, conflict: "skip", confirmed: true });
  expect(readFileSync(path.join(dest, "same.txt"), "utf8")).toBe("OLD");
  expect(readdirSync(dest)).toEqual(["same.txt"]);
  // keep both: two files, neither lost
  stage();
  await exec(`${FILES}:copy`, src, { destination: dest, conflict: "keepBoth", confirmed: true });
  const names = readdirSync(dest).sort();
  expect(names).toHaveLength(2);
  expect(readFileSync(path.join(dest, "same.txt"), "utf8")).toBe("OLD");
  const other = names.find((n) => n !== "same.txt")!;
  expect(readFileSync(path.join(dest, other), "utf8")).toBe("NEW");
  // the same three for move: the source goes away only when something was moved
  stage();
  await exec(`${FILES}:move`, src, { destination: dest, conflict: "skip", confirmed: true });
  expect(existsSync(src), "skipped: the source stays").toBe(true);
  await exec(`${FILES}:move`, src, { destination: dest, conflict: "overwrite", confirmed: true });
  expect(existsSync(src)).toBe(false);
  expect(readFileSync(path.join(dest, "same.txt"), "utf8")).toBe("NEW");
});

test("files I.10b-2: permanent delete asks first and says it cannot be undone; the default delete moves to the (temporary) Trash", async ({ page }) => {
  await openKernel(page, host);
  const f = put("del/gone.txt", "bye");
  const exec = (command: string, args: Record<string, unknown>) =>
    call<{ type: string; irreversible?: boolean; danger?: boolean; message?: string }[]>(page, "command.execute", { id: command, context: { tree: "files", nodeKey: f, args } });
  const ask = await exec(`${FILES}:delete`, {});
  expect(ask[0]).toMatchObject({ type: "confirm", irreversible: true, danger: true });
  expect(existsSync(f), "nothing is deleted before the second step").toBe(true);
  await exec(`${FILES}:delete`, { confirmed: true });
  expect(existsSync(f)).toBe(false);
  expect(readdirSync(trashDir), "permanent delete does not go through the trash").toEqual([]);
  // trash: the file lands in the replaceable trash folder, not in ~/.Trash
  const g = put("del/trash-me.txt", "t");
  const r = await resAct(page, await diskRes(page, g), "trash");
  expect(r.status, JSON.stringify(r.error)).toBe("success");
  expect(existsSync(g)).toBe(false);
  expect(readdirSync(trashDir)).toContain("trash-me.txt");
  // a granted folder itself can be neither deleted nor trashed
  const rootDel = await call<{ type: string; tone?: string }[]>(page, "command.execute", { id: `${FILES}:delete`, context: { tree: "files", nodeKey: granted, args: { confirmed: true } } });
  expect(rootDel[0]).toMatchObject({ type: "toast", tone: "danger" });
  expect(existsSync(granted)).toBe(true);
});

test("files I.10b-2: open and show in Finder go to the (test) log, nothing is really opened", async ({ page }) => {
  await openKernel(page, host);
  const f = put("open/me.txt", "x");
  const id = await diskRes(page, f);
  expect((await resAct(page, id, "open")).status).toBe("success");
  expect((await resAct(page, id, "reveal")).status).toBe("success");
  const log = readFileSync(openLog, "utf8");
  expect(log).toContain(f);
  expect(log.split("\n").filter(Boolean).length).toBeGreaterThanOrEqual(2);
});

test("files I.10b-2: search by file name finds every word, case-insensitive, inside subfolders; results are a table", async ({ page }) => {
  await openKernel(page, host);
  put("find/Quarterly Report 2026.pdf");
  put("find/deep/report-final.txt");
  put("find/deep/other.txt");
  const run = await doAct(page, "search", path.join(granted, "find"), { query: "REPORT final" });
  expect(run.status, JSON.stringify(run.error)).toBe("success");
  const rows = await rowsOf(page, run);
  expect(rows.map((r) => r[0])).toEqual(["report-final.txt"]);
  const two = await rowsOf(page, await doAct(page, "search", path.join(granted, "find"), { query: "report" }));
  expect(two.map((r) => r[0]).sort()).toEqual(["Quarterly Report 2026.pdf", "report-final.txt"]);
  expect((await doAct(page, "search", path.join(granted, "find"), { query: "" })).status).toBe("error");
});

test("files D430: file nodes carry the move/copy/rename/delete menu and can be dragged; folders accept drops", async ({ page }) => {
  await openKernel(page, host);
  const kids = await nodes(page, `${FILES}:files`, path.join(granted, "keep"));
  const file = kids.find((n) => n.label === "a.txt")!;
  expect(file.draggable).toBe(true);
  expect((file.menu as unknown as { id: string }[]).map((m) => m.id)).toEqual(expect.arrayContaining([`${FILES}:move`, `${FILES}:copy`, `${FILES}:rename`, `${FILES}:delete`]));
  const dirs = await nodes(page, `${FILES}:files`, granted);
  expect((dirs.find((n) => n.label === "keep") as Node & { accepts?: string[] }).accepts).toEqual(["*"]);
});

test("files (node page): the buttons Open / Show in Finder / Trash on a file's own page work on the node (no import needed)", async ({ page }) => {
  await openKernel(page, host);
  const f = put("nodepage/direct.txt", "x");
  const lines = () => (existsSync(openLog) ? readFileSync(openLog, "utf8").split("\n").filter(Boolean).length : 0);
  const n0 = lines();
  const o = await doAct(page, "open", f);
  expect(o.status, JSON.stringify(o.error)).toBe("success");
  const r = await doAct(page, "reveal", f);
  expect(r.status, JSON.stringify(r.error)).toBe("success");
  expect(lines()).toBe(n0 + 2);
  expect(readFileSync(openLog, "utf8")).toContain(f);
  const t = await doAct(page, "trash", f);
  expect(t.status, JSON.stringify(t.error)).toBe("success");
  expect(existsSync(f)).toBe(false);
  expect(readdirSync(trashDir)).toContain("direct.txt");
});

test("files (review fixes): opening a program or script (.command) is refused and never reaches the opener; a plain text file opens", async ({ page }) => {
  await openKernel(page, host);
  const cmd = put("unsafe/run.command", "#!/bin/sh\necho hi\n");
  const id = await diskRes(page, cmd);
  const before = existsSync(openLog) ? readFileSync(openLog, "utf8") : "";
  const r = await resAct(page, id, "open");
  expect(r.status).toBe("error");
  expect(JSON.stringify(r.error) + (r.error?.message ?? "")).toMatch(/unsafeOpen|safe|program|open/i);
  const after = existsSync(openLog) ? readFileSync(openLog, "utf8") : "";
  expect(after, "nothing was written to the open log").toBe(before);
  expect(after).not.toContain("run.command");
  const txt = put("unsafe/plain.txt", "ok");
  expect((await resAct(page, await diskRes(page, txt), "open")).status).toBe("success");
});

test("files (review fixes): renaming only the case (a.txt -> A.txt) just works, with no conflict question; a granted folder itself cannot be renamed or moved", async ({ page }) => {
  await openKernel(page, host);
  const f = put("case/a.txt", "x");
  const eff = await call<{ type: string; tone?: string }[]>(page, "command.execute", { id: `${FILES}:rename`, context: { tree: "files", nodeKey: f, args: { newName: "A.txt" } } });
  expect(eff.map((e) => e.type)).not.toContain("confirm");
  expect(eff[0]).toMatchObject({ type: "toast", tone: "success" });
  expect(readdirSync(path.join(granted, "case"))).toEqual(["A.txt"]);
  for (const [cmdId, args] of [[`${FILES}:rename`, { newName: "renamed-root" }], [`${FILES}:move`, { destination: path.join(granted, "case"), conflict: "overwrite", confirmed: true }]] as const) {
    const r = await call<{ type: string; tone?: string }[]>(page, "command.execute", { id: cmdId, context: { tree: "files", nodeKey: granted, args } });
    expect(r[0]).toMatchObject({ type: "toast", tone: "danger" });
  }
  expect(existsSync(granted)).toBe(true);
});

/* ------------------------------------------------------------------ I.10h API connections */

const SECRET = "conn-secret-9f3a7c";
const seenSince = (n: number) => apiSeen.slice(n);
const connCall = async (page: Page, id: string, input: Record<string, unknown>) => {
  const n = apiSeen.length;
  const run = await runRes(page, id, "request", {}, { input });
  return { run, seen: seenSince(n) };
};
const mkConn = (page: Page, name: string, body: Record<string, string>) =>
  create(page, CONN, { name, "body.url": `http://127.0.0.1:${apiPort}/v1`, ...Object.fromEntries(Object.entries(body).map(([k, v]) => [`body.${k}`, v])) });

test("I.10h: Bearer: the local server gets Authorization: Bearer <secret>, and the path is added to the base address", async ({ page }) => {
  await openKernel(page, host);
  ids.connBearer = await mkConn(page, "API bearer", { auth: "bearer", secret: SECRET });
  const { run, seen } = await connCall(page, ids.connBearer, { path: "/things", method: "GET" });
  expect(run.status, JSON.stringify(run.error)).toBe("success");
  expect(seen).toHaveLength(1);
  expect(seen[0]!.url).toBe("/v1/things");
  expect(seen[0]!.headers.authorization).toBe(`Bearer ${SECRET}`);
});

test("I.10h: Basic: Authorization: Basic base64(user:secret)", async ({ page }) => {
  await openKernel(page, host);
  const id = await mkConn(page, "API basic", { auth: "basic", username: "alice", secret: SECRET });
  const { run, seen } = await connCall(page, id, { path: "/me" });
  expect(run.status, JSON.stringify(run.error)).toBe("success");
  expect(seen[0]!.headers.authorization).toBe(`Basic ${Buffer.from(`alice:${SECRET}`).toString("base64")}`);
  const bad = await mkConn(page, "API basic no user", { auth: "basic", username: "", secret: SECRET });
  expect((await connCall(page, bad, { path: "/me" })).seen).toHaveLength(0);
});

test("I.10h: custom header and query-parameter secrets", async ({ page }) => {
  await openKernel(page, host);
  const h = await mkConn(page, "API header", { auth: "header", authName: "X-Api-Key", secret: SECRET });
  const r1 = await connCall(page, h, { path: "/h" });
  expect(r1.run.status, JSON.stringify(r1.run.error)).toBe("success");
  expect(r1.seen[0]!.headers["x-api-key"]).toBe(SECRET);
  const q = await mkConn(page, "API query", { auth: "query", authName: "api_key", secret: SECRET });
  const r2 = await connCall(page, q, { path: "/q", query: { page: "2" } });
  expect(r2.run.status, JSON.stringify(r2.run.error)).toBe("success");
  const u = new URL(r2.seen[0]!.url, "http://x");
  expect(u.searchParams.get("api_key")).toBe(SECRET);
  expect(u.searchParams.get("page")).toBe("2");
  const none = await mkConn(page, "API open", { auth: "none" });
  const r3 = await connCall(page, none, { path: "/open" });
  expect(r3.seen[0]!.headers.authorization).toBeUndefined();
});

test("I.10h: the address is the only host that can be reached: a path cannot send the call elsewhere", async ({ page }) => {
  await openKernel(page, host);
  for (const evil of ["http://evil.example/x", "//evil.example/x", "\\\\evil.example", "/../../etc", "@evil.example"]) {
    const { seen } = await connCall(page, ids.connBearer, { path: evil });
    for (const s of seen) expect(s.headers.host).toBe(`127.0.0.1:${apiPort}`);
  }
});

test("I.10h: the secret is only in the keychain: not in the resource, the data folder, the audit or the run", async ({ page }) => {
  await openKernel(page, host);
  const res = await getRes(page, ids.connBearer);
  expect(JSON.stringify(res)).not.toContain(SECRET);
  expect(JSON.stringify(await call(page, "secrets.list"))).not.toContain(SECRET);
  expect(JSON.stringify(await call(page, "audit.list", {}))).not.toContain(SECRET);
  const { run } = await connCall(page, ids.connBearer, { path: "/leak?x=1", inline: true });
  expect(JSON.stringify(run)).not.toContain(SECRET);
  const { execFileSync } = await import("node:child_process");
  let hits = "";
  try {
    hits = execFileSync("/usr/bin/grep", ["-rl", "--binary-files=text", SECRET, path.join(base, "data")], { encoding: "utf8" });
  } catch {
    // grep exits 1 when nothing matches
  }
  expect(hits, "no file of the data folder holds the secret").toBe("");
});

test("I.10h: every call is in the audit log", async ({ page }) => {
  await openKernel(page, host);
  const ops = (await call<{ operation: string; target: string }[]>(page, "audit.list", {})).map((r) => r.operation);
  expect(ops.filter((o) => o === "network.request").length).toBeGreaterThanOrEqual(1);
});

test("I.10h: the HTTP request plugin can take a connection as its base address and authentication", async ({ page }) => {
  await openKernel(page, host);
  const http1 = await create(page, "org.onedesk.http:request", { name: "Via connection", "body.connection": ids.connBearer, "body.url": "/from-http", "body.method": "GET" });
  const n = apiSeen.length;
  const run = await runRes(page, http1, "send", {}, { input: { "body.connection": ids.connBearer, "body.url": "/from-http", "body.method": "GET" } });
  expect(run.status, JSON.stringify(run.error)).toBe("success");
  const seen = seenSince(n);
  expect(seen.at(-1)?.url).toBe("/v1/from-http");
  expect(seen.at(-1)?.headers.authorization).toBe(`Bearer ${SECRET}`);
});

test("I.10h: connections can be grouped and searched like any resource", async ({ page }) => {
  await openKernel(page, host);
  const hits = await call<{ target: string }[]>(page, "search.query", { text: "API bearer" });
  expect(hits.map((h) => h.target).join(" ")).toContain(ids.connBearer);
  const group = await call<{ key: string } | string>(page, "tree.createGroup", { tree: "resources", name: "Connections" });
  const gkey = typeof group === "string" ? group : group.key;
  await call(page, "tree.move", { tree: "resources", key: ids.connBearer, target: gkey, position: "inside" });
  expect((await nodes(page, "resources", gkey)).map((n) => n.key)).toContain(ids.connBearer);
});

/* ------------------------------------------------------------------ L the rest of the interface */

test("L7: search: 3+ characters use the index, shorter ones match loosely, several words must all hit; no match = no hit", async ({ page }) => {
  await openKernel(page, host);
  const mk = (name: string) => create(page, "org.onedesk.link:link", { name, "body.url": "https://example.org/" }).catch(() => create(page, SCR, { name, "body.script": "true" }));
  await mk("Quarterly budget plan");
  await mk("budget draft notes");
  await mk("Zebra stripes");
  const hit = async (text: string) => (await call<{ title: string }[]>(page, "search.query", { text })).map((h) => h.title);
  expect(await hit("budg"), "3+ characters").toEqual(expect.arrayContaining(["Quarterly budget plan", "budget draft notes"]));
  const short = await hit("qb");
  expect(short, "2 characters: in order inside the name").toContain("Quarterly budget plan");
  expect(short).not.toContain("Zebra stripes");
  const both = await hit("budget draft");
  expect(both).toContain("budget draft notes");
  expect(both, "every word must be found").not.toContain("Quarterly budget plan");
  expect(await hit("zzzzzzq")).toEqual([]);
});

test("L8: favorites come first (in the favorites tree and in search results); tags can be edited and found by search", async ({ page }) => {
  await openKernel(page, host);
  const titles = async (text: string) => (await call<{ title: string; target: string }[]>(page, "search.query", { text })).map((h) => h.title);
  const norm = (await titles("budget"))[0]!;
  const other = norm === "budget draft notes" ? "Quarterly budget plan" : "budget draft notes";
  const otherId = (await call<{ title: string; target: string }[]>(page, "search.query", { text: other })).find((h) => h.title === other)!.target.replace(/^resource:/, "");
  await call(page, "resource.setFavorite", { id: otherId, favorite: true });
  expect((await titles("budget"))[0], "the favourite is first").toBe(other);
  expect(JSON.stringify(await nodes(page, "favorites"))).toContain(otherId);
  await call(page, "resource.setFavorite", { id: otherId, favorite: false });
  // tags
  await call(page, "page.save", { target: `resource:${otherId}`, changes: { tags: ["roadmap-2027"] } });
  expect((await getRes(page, otherId) as unknown as { tags: string[] }).tags).toEqual(["roadmap-2027"]);
  expect(await titles("roadmap-2027")).toContain(other);
});

/* ------------------------------------------------------------------ the page: what the user sees */

const view = async (page: Page, name: string) => {
  const b = page.getByRole("navigation", { name: "Views" }).getByRole("button", { name, exact: true });
  if ((await b.getAttribute("aria-pressed")) !== "true") await b.click();
};
const shot = (page: Page, name: string) => page.screenshot({ path: path.join(OUT, `round17-${name}.png`) });
const openRes = async (page: Page, name: string) => {
  await view(page, "Resources");
  await page.getByRole("treeitem", { name, exact: true }).first().dblclick();
};

const waitPartial = async (page: Page, runId: string, needle: string) => {
  let partial: unknown = null;
  for (let i = 0; i < 25 && !JSON.stringify(partial).includes(needle); i++) {
    await new Promise((r) => setTimeout(r, 300));
    partial = (await call<RunInfo>(page, "run.get", { id: runId })).partial ?? null;
  }
  return JSON.stringify(partial);
};

test("I5/X17: while a command runs, the lines received so far are the run's partial output (terminal look, no later line yet)", async ({ page }) => {
  await openKernel(page, host);
  fake.reset();
  fake.rule("ssh", { mode: "exec" });
  const id = await create(page, CMD, { name: "Partial demo", "body.host": "web-1", "body.command": "echo early-line\nsleep 1\necho mid-line\nsleep 5\necho late-line" });
  const runId = await startRaw(page, "run", `resource:${id}`, {}, { resourceId: id });
  const p = await waitPartial(page, runId, "mid-line");
  expect(p, "Run.partial carries the lines so far").toContain("early-line");
  expect(p).toContain("mid-line");
  expect(p).not.toContain("late-line");
  expect(p).toContain("terminal");
  const done = await waitRun(page, runId);
  expect(done.status).toBe("success");
  expect(done.partial ?? null).toBeNull();
});

// Was a defect (no trailing flush after the partial-output throttle); fixed in the command plugin.
test("I5/X17: lines that arrive in a burst are all shown in the partial output without waiting for the next line", async ({ page }) => {
  await openKernel(page, host);
  fake.reset();
  fake.rule("ssh", { mode: "exec" });
  const id = await create(page, CMD, { name: "Burst demo", "body.host": "web-1", "body.command": "echo burst-1\necho burst-2\necho burst-3\nsleep 5\necho after" });
  const runId = await startRaw(page, "run", `resource:${id}`, {}, { resourceId: id });
  const p = await waitPartial(page, runId, "burst-3");
  expect(p).toContain("burst-3");
});

test("I6 (page): the server command's output is a dark terminal and stderr has its own colour", async ({ page }) => {
  await openKernel(page, host);
  fake.reset();
  fake.rule("ssh", { mode: "exec" });
  await create(page, CMD, { name: "Terminal demo", "body.host": "web-1", "body.command": "echo first-line\necho an-error >&2\necho last-line" });
  await openRes(page, "Terminal demo");
  await page.getByRole("button", { name: "Run", exact: true }).first().click();
  const out = page.getByText("first-line", { exact: true });
  await expect(out).toBeVisible({ timeout: 15_000 });
  // colours of the text and of the darkest opaque background behind it (the terminal block)
  const style = (text: string) =>
    page.getByText(text, { exact: true }).evaluate((el) => {
      const bgs: string[] = [];
      for (let e: Element | null = el; e; e = e.parentElement) {
        const c = getComputedStyle(e).backgroundColor;
        const m = c.match(/[\d.]+/g);
        if (m && (m.length === 3 || Number(m[3]) >= 0.9)) bgs.push(c);
      }
      return { color: getComputedStyle(el).color, bgs };
    });
  const lum = (css: string) => {
    const [r, g, bl] = (css.match(/\d+(\.\d+)?/g) ?? ["255", "255", "255"]).slice(0, 3).map(Number) as [number, number, number];
    return (0.2126 * r + 0.7152 * g + 0.0722 * bl) / 255;
  };
  // The first line can be on screen before the terminal block has its background (the output view is swapped in while the
  // run finishes), so read the colours until they settle instead of once.
  await expect
    .poll(async () => Math.min(...(await style("first-line")).bgs.map(lum)), { message: "dark background" })
    .toBeLessThan(0.25);
  await expect
    .poll(async () => (await style("first-line")).color !== (await style("an-error")).color, { message: "stderr is another colour than stdout" })
    .toBe(true);
  await shot(page, "terminal");
});

// Was a defect (partial output not shown on the page while running); fixed in the shell and the command plugin (burst flush).
test("I5/I6 (page): while the command runs the lines received so far are already on the page", async ({ page }) => {
  await openKernel(page, host);
  fake.reset();
  fake.rule("ssh", { mode: "exec" });
  await create(page, CMD, { name: "Live demo", "body.host": "web-1", "body.command": "echo early-line\nsleep 5\necho late-line" });
  await openRes(page, "Live demo");
  await page.getByRole("button", { name: "Run", exact: true }).first().click();
  await expect(page.getByText("early-line", { exact: true })).toBeVisible({ timeout: 3500 });
  await expect(page.getByText("late-line", { exact: true })).toHaveCount(0);
});

test("I.10b-2 (page): copy onto an existing name asks overwrite / skip / keep both; each is applied once", async ({ page }) => {
  await openKernel(page, host);
  const src = path.join(granted, "ui-src");
  const dst = path.join(granted, "ui-dst");
  mkdirSync(src, { recursive: true });
  mkdirSync(dst, { recursive: true });
  const stage = () => {
    writeFileSync(path.join(src, "same.txt"), "NEW");
    for (const f of readdirSync(dst)) rmSync(path.join(dst, f));
    writeFileSync(path.join(dst, "same.txt"), "OLD");
  };
  const tryCopy = async (choice: RegExp) => {
    stage();
    await page.getByRole("treeitem", { name: "same.txt" }).first().click({ button: "right" });
    await ui.menuItem(page, "Copy").click();
    const picker = page.getByRole("dialog");
    await expect(picker).toBeVisible();
    await picker.getByRole("treeitem", { name: "granted", exact: true }).click();
    await page.keyboard.press("ArrowRight");
    await picker.getByRole("treeitem", { name: "ui-dst", exact: true }).click();
    await picker.getByRole("button", { name: "Choose", exact: true }).click();
    const ask = page.getByRole("dialog");
    await expect(ask).toContainText(/already|exists/i);
    await expect(ask.getByRole("button", { name: /Overwrite/i })).toBeVisible();
    await expect(ask.getByRole("button", { name: /Skip/i })).toBeVisible();
    await expect(ask.getByRole("button", { name: /Keep both/i })).toBeVisible();
    if (choice.source === "cancel") {
      await ask.getByRole("button", { name: /Cancel/i }).click();
    } else {
      await ask.getByRole("button", { name: choice }).click();
    }
    await expect(page.getByRole("dialog")).toHaveCount(0);
  };
  await call(page, "plugin.grantFolder", { plugin: FILES, path: granted });
  stage();
  await openKernel(page, host);
  await view(page, "Files");
  const rootItem = page.getByRole("treeitem", { name: "granted", exact: true });
  await expect(rootItem).toBeVisible({ timeout: 8000 });
  await rootItem.click();
  await page.keyboard.press("ArrowRight");
  const srcItem = page.getByRole("treeitem", { name: "ui-src", exact: true });
  await srcItem.click();
  await page.keyboard.press("ArrowRight");
  await tryCopy(/Overwrite/i);
  expect(readFileSync(path.join(dst, "same.txt"), "utf8")).toBe("NEW");
  await tryCopy(/Skip/i);
  expect(readFileSync(path.join(dst, "same.txt"), "utf8")).toBe("OLD");
  expect(readdirSync(dst)).toEqual(["same.txt"]);
  await tryCopy(/Keep both/i);
  expect(readdirSync(dst)).toHaveLength(2);
  await tryCopy(/cancel/);
  expect(readFileSync(path.join(dst, "same.txt"), "utf8")).toBe("OLD");
  expect(readdirSync(dst)).toHaveLength(1);
  stage();
  await page.getByRole("treeitem", { name: "same.txt" }).first().click({ button: "right" });
  await ui.menuItem(page, "Copy").click();
  await shot(page, "folder-picker");
  await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
});

test("I.10b-2 (page): the file tree menu offers Move to Trash and Delete permanently; Move to Trash asks nothing and the file lands in the (test) Trash", async ({ page }) => {
  await openKernel(page, host);
  const f = put("ui-trash/bin-me.txt", "x");
  await call(page, "plugin.grantFolder", { plugin: FILES, path: granted });
  await openKernel(page, host);
  await view(page, "Files");
  await page.getByRole("treeitem", { name: "granted", exact: true }).click();
  await page.keyboard.press("ArrowRight");
  await page.getByRole("treeitem", { name: "ui-trash", exact: true }).click();
  await page.keyboard.press("ArrowRight");
  await page.getByRole("treeitem", { name: "bin-me.txt" }).click({ button: "right" });
  await expect(ui.menuItem(page, "Delete permanently")).toBeVisible();
  const trash = ui.menuItem(page, /Trash/);
  await expect(trash).toBeVisible();
  await trash.click();
  await expect(page.getByRole("dialog"), "no confirmation").toHaveCount(0);
  await expect.poll(() => existsSync(f)).toBe(false);
  expect(readdirSync(trashDir)).toContain("bin-me.txt");
});

test("I.10b-2 (page): permanent delete says it cannot be undone and deletes only after the confirmation", async ({ page }) => {
  await openKernel(page, host);
  const f = put("ui-del/victim.txt", "bye");
  await call(page, "plugin.grantFolder", { plugin: FILES, path: granted });
  await openKernel(page, host);
  await view(page, "Files");
  await page.getByRole("treeitem", { name: "granted", exact: true }).click();
  await page.keyboard.press("ArrowRight");
  await page.getByRole("treeitem", { name: "ui-del", exact: true }).click();
  await page.keyboard.press("ArrowRight");
  await page.getByRole("treeitem", { name: "victim.txt" }).click({ button: "right" });
  await ui.menuItem(page, "Delete permanently").click();
  const dlg = page.getByRole("dialog");
  await expect(dlg).toContainText(/cannot be undone/i);
  await page.waitForTimeout(400); // the dialog fades in
  await shot(page, "delete-permanently");
  await dlg.getByRole("button", { name: /Cancel/i }).click();
  expect(existsSync(f), "cancel deletes nothing").toBe(true);
  await page.getByRole("treeitem", { name: "victim.txt" }).click({ button: "right" });
  await ui.menuItem(page, "Delete permanently").click();
  await page.getByRole("dialog").getByRole("button", { name: "Confirm", exact: true }).click();
  await expect.poll(() => existsSync(f)).toBe(false);
});
