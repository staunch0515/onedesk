/** Round 20 parity batch 3: rows I1–I9, J1–J4, L1–L10 (real devhost, real PostgreSQL, browser shell). */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { DEVHOST, openKernel, rpc, startHost, stopHost, type Host, allPlugins } from "../kernel-host";
import { DB1, pgBinOrNull, startPg, type Pg } from "../pg-fixture";
import { FakeTools } from "../fake-tools";
import { mkBase, oracle, row, seedParity, shot, unverified } from "./support";
import { existsSync } from "node:fs";

test.use({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
test.describe.configure({ mode: "serial" });
test.setTimeout(180_000);

let host: Host;
let base: string;
let pg: Pg;
let catalog: string;
let fake: FakeTools;

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
  base = mkBase("p3");
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
  fake = new FakeTools(path.join(base, "fake"), pgBinOrNull);
  fake.remoteDockerShim();
  const plugins = fake.preparePlugins(allPlugins(), path.join(base, "plugins"), path.join(base, "data"));
  host = await startHost(path.join(base, "data"), {}, plugins);
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
const sqlText = (s: string) => JSON.parse(s) as string;
void sqlText;


const pgEnv = () => ({ PGHOST: path.join(pg.dir, "sock"), PGPORT: String(pg.port) });
const DSK = "org.onedesk.datasource:source";
const CMD = "org.onedesk.command:command";
const SCR = "org.onedesk.script:script";
const writeShim = () => writeFileSync(path.join(base, "fake/remote-bin/docker"), '#!/bin/sh\nshift\nwhile [ $# -gt 0 ]; do case "$1" in -e|-u|-w) shift 2 ;; -i|-t) shift ;; *) break ;; esac; done\nshift\nexec "$@"\n', { mode: 0o755 });
const view = async (page: Page, name: string) => {
  const b = page.getByRole("navigation", { name: "Views" }).getByRole("button", { name, exact: true });
  if ((await b.getAttribute("aria-pressed")) !== "true") await b.click();
};
const runRes = (page: Page, id: string, action: string, params: Record<string, string> = {}, extra: Record<string, unknown> = {}) => startRun(page, action, `resource:${id}`, params, { resourceId: id, ...extra });

test("I1–I9: server commands and local scripts", async ({ page }) => {
  await openKernel(page, host);
  fake.reset();
  fake.rule("ssh", { mode: "exec" });
  let cmd = "";
  await row("I1", async () => {
    const g = (await call<{ key: string }>(page, "tree.createGroup", { tree: "resources", name: "Servers" })).key;
    cmd = await create(page, CMD, { name: "Say hello", "body.host": "web-1", "body.command": "echo \"hello :who\"\necho err-line >&2" });
    await call(page, "tree.move", { tree: "resources", key: cmd, target: g, position: "inside" });
    expect((await nodes(page, "resources", g)).map((n) => n.label)).toEqual(["Say hello"]);
    await call(page, "page.save", { target: `resource:${cmd}`, changes: { "body.command": "echo \"hello :who\"\necho err-line >&2\necho :n" } });
    await page.reload();
    await view(page, "Resources");
    await page.getByRole("treeitem", { name: "Servers" }).click();
    await page.getByRole("button", { name: /Expand all/i }).click({ timeout: 3000 }).catch(() => null);
    await page.getByRole("treeitem", { name: "Say hello" }).first().dblclick({ timeout: 8000 });
    await expect(page.getByLabel("who", { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByLabel("n", { exact: true })).toBeVisible();
    await shot(page, "I1-command-page.png");
    return "命令可新建、放进分组、改正文；页面按 :who、:n 生成参数输入框（I1-command-page.png）";
  }, page);
  await row("I2", async () => {
    const marker = path.join(base, "injected");
    const id = await create(page, CMD, { name: "Echo it", "body.host": "web-1", "body.command": "printf '%s\\n' :msg" });
    const evils = [`x'; touch ${marker}; echo '`, `$(touch ${marker})`, `\`touch ${marker}\``, `a b; touch ${marker}`, `"; touch ${marker}; "`, "line1\nline2", `\\'; touch ${marker}; #`];
    for (const evil of evils) {
      const r = await runRes(page, id, "run", { msg: evil });
      expect(r.status, JSON.stringify(r.error)).toBe("success");
      const out = (await rowsOf(page, r)).filter((x) => x[0] === "stdout").map((x) => x[1]).join("\n");
      expect(out).toBe(evil);
    }
    expect(existsSync(marker)).toBe(false);
    return `${evils.length} 种注入式取值（引号逃逸、$()、反引号、分号、换行、反斜杠）在真 bash 里都只是原样的一个词，注入文件未生成`;
  }, page);
  await row("I3", async () => {
    const r = await runRes(page, cmd, "run", { who: "x", n: "1" });
    expect(r.status, JSON.stringify(r.error)).toBe("success");
    const a = fake.calls("ssh").pop()!.args;
    expect(a).toContain("web-1");
    const bad = await create(page, CMD, { name: "Bad host", "body.host": "-oProxyCommand=touch /tmp/x", "body.command": "true" });
    const rb = await runRes(page, bad, "run");
    expect(rb.status).toBe("error");
    return "资源字段“host”指定 ssh 别名（web-1 出现在 ssh 参数里）；以 - 开头、可被读成选项的主机名在 ssh 启动前被拒绝";
  }, page);
  await row("I5", async () => {
    const r = await runRes(page, cmd, "run", { who: "ann", n: "7" });
    const rows = await rowsOf(page, r);
    expect(rows).toEqual(expect.arrayContaining([["stdout", "hello ann"], ["stderr", "err-line"], ["stdout", "7"]]));
    const info = await call<any>(page, "run.get", { id: r.id });
    expect(info.output.columns.map((c: any) => String(c.label).toLowerCase())).toEqual(["stream", "line"]);
    const csv = path.join(base, "cmd.csv");
    await call(page, "run.export", { run: r.id, path: csv, format: "csv" });
    expect(readFileSync(csv, "utf8")).toMatch(/stdout,hello ann/);
    await call(page, "run.setKept", { id: r.id, kept: true, name: "Cmd out" });
    expect((await nodes(page, "runs", "@runs:saved")).some((n) => n.key === r.id)).toBe(true);
    expect(JSON.stringify(await call(page, "run.listFor", { id: cmd }))).toContain(r.id);
    return "输出是“流、行”两列的表（stdout/stderr 分行），可导出 CSV、可保留、在该命令的历史里";
  }, page);
  await row("I6", async () => {
    await page.reload();
    await view(page, "Resources");
    await page.getByRole("treeitem", { name: "Servers" }).click();
    await page.getByRole("button", { name: /Expand all/i }).click({ timeout: 3000 }).catch(() => null);
    await page.getByRole("treeitem", { name: "Say hello" }).first().dblclick({ timeout: 8000 });
    await page.getByLabel("who", { exact: true }).fill("tty");
    await page.getByLabel("n", { exact: true }).fill("3");
    await page.getByRole("button", { name: "Run", exact: true }).click();
    await expect(page.getByText("hello tty").first()).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(500);
    await shot(page, "I6-terminal.png");
    const style = await page.evaluate(() => {
      const find = (t: string) => Array.from(document.querySelectorAll("*")).find((e) => e.children.length === 0 && e.textContent?.trim() === t) as HTMLElement | undefined;
      const out = find("hello tty");
      const err = find("err-line");
      let bgEl: HTMLElement | null = out ?? null;
      let bg = "";
      while (bgEl) {
        bg = getComputedStyle(bgEl).backgroundColor;
        if (bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") break;
        bgEl = bgEl.parentElement;
      }
      return { bg, outColor: out ? getComputedStyle(out).color : "", errColor: err ? getComputedStyle(err).color : "" };
    });
    const lum = (c: string) => {
      const m = c.match(/\d+/g)!.map(Number);
      return 0.2126 * m[0]! + 0.7152 * m[1]! + 0.0722 * m[2]!;
    };
    expect(lum(style.bg)).toBeLessThan(80);
    expect(style.errColor).not.toBe(style.outColor);
    return `终端样式：深色底（${style.bg}），stdout 颜色 ${style.outColor}，stderr 颜色 ${style.errColor}，两者不同（I6-terminal.png）`;
  }, page);
  await row("I7", async () => {
    const id = await create(page, CMD, { name: "Env dump", "body.host": "web-1", "body.command": "echo DB_PASSWORD=hunter2\necho API_TOKEN: s3cr3t-token\necho secret_key=abc123\necho HOME_DIR=/home/x\necho 'Authorization: Bearer abc.def'" });
    const r = await runRes(page, id, "run");
    const lines = (await rowsOf(page, r)).map((x) => x[1]).join("\n");
    for (const leak of ["hunter2", "s3cr3t-token", "abc123", "abc.def"]) expect(lines).not.toContain(leak);
    expect(lines).toContain("HOME_DIR=/home/x");
    expect(lines).toContain("***");
    return "DB_PASSWORD/API_TOKEN/secret_key/Authorization: Bearer 的值被打码为 ***，普通变量 HOME_DIR 原样";
  }, page);
  let script = "";
  await row("I8", async () => {
    script = await create(page, SCR, { name: "Greeter", "body.script": "printf 'hi %s\\n' :who\necho oops >&2" });
    const r = await runRes(page, script, "run", { who: "there; echo injected" });
    expect(r.status, JSON.stringify(r.error)).toBe("success");
    expect(await rowsOf(page, r)).toEqual(expect.arrayContaining([["stdout", "hi there; echo injected"], ["stderr", "oops"]]));
    const slow = await create(page, SCR, { name: "Slow script", "body.script": "echo first\nsleep 30", "body.timeoutSec": "2" });
    const t0 = Date.now();
    const r2 = await runRes(page, slow, "run", {}, { input: { "body.timeoutSec": "2" } });
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect((await rowsOf(page, r2)).map((x) => x[1])).toContain("first");
    const many = await create(page, SCR, { name: "Many lines", "body.script": "for i in 1 2 3 4 5 6 7 8 9 10; do echo l$i; done", "body.maxLines": "3" });
    expect(await rowsOf(page, await runRes(page, many, "run", {}, { input: { "body.maxLines": "3" } }))).toHaveLength(3);
    const bad = await create(page, SCR, { name: "Exit 3", "body.script": "echo partial\nexit 3" });
    const rb = await runRes(page, bad, "run");
    expect(rb.status).toBe("error");
    return "本机 bash 脚本：保存、:who 参数（注入取值只是字符串）、超时 2s 后保留已收到的行、行数上限 3、非零退出算失败且保留输出";
  }, page);
  await row("I9", async () => {
    const out = path.join(base, "scripts-out");
    mkdirSync(out, { recursive: true });
    await call(page, "plugin.grantFolder", { plugin: "org.onedesk.script", path: out });
    const r = await runRes(page, script, "exportAll", { folder: out });
    expect(r.status, JSON.stringify(r.error)).toBe("success");
    const files = readdirSync(out).sort();
    expect(files).toEqual(expect.arrayContaining(["Greeter.sh"]));
    for (const f of files) execFileSync("/bin/bash", ["-n", path.join(out, f)]); // every exported file parses as bash
    const elsewhere = path.join(base, "not-granted");
    mkdirSync(elsewhere, { recursive: true });
    const refused = await runRes(page, script, "exportAll", { folder: elsewhere });
    expect(refused.status).toBe("error");
    expect(readdirSync(elsewhere)).toEqual([]);
    return `全部脚本导出为 ${files.length} 个 .sh（${files.join("、")}），都通过 bash -n 语法检查；未授权的文件夹拒绝写入`;
  }, page);
  await row("I4", async () => {
    // the real ssh: the program that the kernel starts is /usr/bin/ssh, BatchMode, never asks for a password
    const h2 = await startHost(path.join(base, "data-real"));
    try {
      const c = <T = unknown>(m: string, p: unknown = null) => rpc<T>(page, h2, m, p);
      const id = (await c<{ page: { resourceId: string } }>("page.save", { target: `new:${CMD}`, changes: { name: "Real ssh", "body.host": "e2e-no-such-host.invalid", "body.command": "true" } })).page.resourceId;
      const rid = await c<string>("run.start", { action: "run", target: `resource:${id}`, resourceId: id, tabId: "p", input: {}, params: {}, locale: "en-US" });
      let info: any = { status: "running" };
      const t0 = Date.now();
      for (let i = 0; i < 100 && info.status === "running"; i++) {
        await new Promise((r) => setTimeout(r, 300));
        info = await c("run.get", { id: rid });
      }
      expect(info.status).toBe("error");
      expect(JSON.stringify(info)).toMatch(/Could not resolve hostname|nodename nor servname/i);
      expect(Date.now() - t0).toBeLessThan(25_000);
      return unverified(`真 /usr/bin/ssh 被启动、不问密码（BatchMode）：不存在的主机立即返回 ssh 自己的“Could not resolve hostname”。读取 ~/.ssh/config 的别名、成功登录这两点没有验证——本机没有可登录的服务器，也不允许改 ~/.ssh；e2e 的假 ssh 记录到的参数含 BatchMode=yes、-- 分隔`);
    } finally {
      await stopHost(h2);
    }
  }, page);
});

const backupRules = () => {
  fake.reset();
  fake.remoteDockerShim();
  writeShim();
  fake.rule("ssh", { mode: "exec", env: pgEnv() });
  fake.rule("docker", { match: "^cp ", mode: "docker-cp" });
  fake.rule("docker", { match: "^exec ", mode: "docker-exec", env: pgEnv() });
};
const backupDir = () => path.join(base, "data/workspaces/default/plugin-data/org.onedesk.datasource/backups");

test("J1–J4: backup to this Mac", async ({ page }) => {
  await openKernel(page, host);
  const sshSrc = await create(page, DSK, { name: "Prod over ssh", "body.mode": "ssh", "body.sshHost": "backup-host", "body.container": "server-pg", "body.database": DB1, "body.user": "postgres" });
  const backup = (over: Record<string, string> = {}) => runRes(page, sshSrc, "backup", { backupName: "shop_copy", backupContainer: "local-pg", backupPort: "5432", backupUser: "postgres", ...over });
  await row("J1", async () => {
    backupRules();
    const run = await backup();
    expect(run.status, JSON.stringify(run.error)).toBe("success");
    const log = fake.calls().map((c) => `${c.tool}:${c.args.join(" ")}`);
    expect(log.findIndex((l) => /^ssh:.*pg_dump -Fc/.test(l))).toBeGreaterThan(-1);
    expect(log.findIndex((l) => l.includes("createdb"))).toBeLessThan(log.findIndex((l) => l.includes("pg_restore")));
    expect(oracle(pg, "shop_copy", "SELECT count(*) FROM orders")).toEqual([["4"]]);
    const made = (await nodes(page, "resources")).find((n) => n.label.includes("shop_copy"));
    expect(made).toBeTruthy();
    expect((await getRes(page, made!.key)).body).toMatchObject({ mode: "direct", database: "shop_copy" });
    return unverified("一键流程（服务器 pg_dump → 下载 → 拷进本机容器 → 新建库 → pg_restore → 新建直连数据源）逐步执行：新库 shop_copy 有 4 行 orders，新数据源已建。但 ssh/docker 是 e2e 的假程序（pg_dump/pg_restore 是真的、对着临时 PostgreSQL），没有连真服务器和真 Docker 容器——本机没有 docker");
  }, page);
  await row("J4", async () => {
    const dumps = readdirSync(backupDir()).filter((f) => f.endsWith(".dump"));
    expect(dumps).toHaveLength(1);
    expect(readFileSync(path.join(backupDir(), dumps[0]!)).subarray(0, 5).toString()).toBe("PGDMP");
    return `转储文件 ${dumps[0]} 保存在应用自己的备份文件夹（plugin-data/…/backups），文件头 PGDMP`;
  }, page);
  await row("J3", async () => {
    pg.psql("shop_copy", "INSERT INTO orders VALUES (99,'keep',1,now(),'untouched')", "postgres");
    const before = readdirSync(backupDir()).length;
    backupRules();
    const again = await backup();
    expect(again.status).toBe("error");
    expect(readdirSync(backupDir()).length).toBe(before);
    expect(oracle(pg, "shop_copy", "SELECT note FROM orders WHERE id=99")).toEqual([["untouched"]]);
    const all = fake.calls().map((c) => c.args.join(" ")).join("\n");
    expect(all).not.toMatch(/dropdb|DROP DATABASE|--clean|--create/i);
    for (const [k, v] of [["backupName", "x; DROP DATABASE shop"], ["backupName", "a b"], ["backupContainer", "c;rm -rf /"], ["backupPort", "5432; id"], ["backupUser", "u'x"]] as const) {
      const r = await backup({ [k]: v });
      expect(r.status, `${k}=${v}`).toBe("error");
    }
    expect(oracle(pg, "postgres", "SELECT count(*) FROM pg_database WHERE datname = 'shop'")).toEqual([["1"]]);
    return "已存在的库（shop_copy，含手工加的一行）再次备份被拒绝，数据原样、没有 drop/--clean；库名/容器/端口/用户里的不安全字符全部拒绝";
  }, page);
  await row("J2", async () => {
    // a real (non-fake) host: docker is not installed here; the run must say so, naming the places looked in. PATH is not read:
    // a docker placed on PATH is still not found.
    const bin = path.join(base, "pathbin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(path.join(bin, "docker"), "#!/bin/sh\necho FAKE-FROM-PATH\n", { mode: 0o755 });
    const h2 = await startHost(path.join(base, "data-real2"), { PATH: `${bin}:/usr/bin:/bin` });
    try {
      const c = <T = unknown>(m: string, p: unknown = null) => rpc<T>(page, h2, m, p);
      const id = (await c<{ page: { resourceId: string } }>("page.save", { target: `new:${DSK}`, changes: { name: "Prod ssh", "body.mode": "ssh", "body.sshHost": "backup-host", "body.container": "server-pg", "body.database": DB1, "body.user": "postgres" } })).page.resourceId;
      const rid = await c<string>("run.start", { action: "backup", target: `resource:${id}`, resourceId: id, tabId: "p", input: {}, params: { backupName: "never_made", backupContainer: "local-pg", backupPort: "5432", backupUser: "postgres" }, locale: "en-US" });
      let info: any = { status: "running" };
      for (let i = 0; i < 80 && info.status === "running"; i++) {
        await new Promise((r) => setTimeout(r, 300));
        info = await c("run.get", { id: rid });
      }
      const text = JSON.stringify(info);
      expect(info.status).toBe("error");
      expect(text).not.toContain("FAKE-FROM-PATH");
      expect(text).toMatch(/docker/i);
      return `真内核、本机没装 docker：运行失败并点名 docker（${text.slice(text.indexOf("message"), text.indexOf("message") + 160)}）；PATH 里放一个 docker 也不被使用（固定位置查找，不读 PATH）。docker 装在固定位置时能找到这一半没有验证（本机没有 docker，也不往系统目录放文件）`;
    } finally {
      await stopHost(h2);
    }
  }, page);
});
