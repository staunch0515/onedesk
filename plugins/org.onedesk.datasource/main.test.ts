import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
// @ts-ignore plain JS module, no types
import plugin, { BACKUP_STEPS, backupPlanOf, backupToLocal, checkBackup, dockerArgs, dumpSpec, safeContainer, safeDbName, stampOf, suggestDbName, captureReadonly, checkConnection, connectionOf, errorText, parseConnectionUrl, parseCsv, positiveInt, processSpec, readonlyScript, refuse, scanSql, runReadonly, safePart } from "./main.js";
import { RENDER_KEYS, checkActionResult, checkView, hostError, onlyKeys, registry } from "../_testing/view-check";

const load = (f: string) => JSON.parse(readFileSync(new URL(`./locales/${f}.json`, import.meta.url), "utf8")) as Record<string, string>;
const EN = load("en-US");
const ZH = load("zh-CN");
const JA = load("ja-JP");
const t = (key: string) => ({ "en-US": EN[key], "zh-CN": ZH[key], "ja-JP": JA[key] });

type Host = Record<string, any>;
const SOURCE = { id: "s1", kind: "org.onedesk.datasource:source", name: "Local", body: { mode: "direct", host: "localhost", port: "5433", database: "shop", user: "app", password: { secret: "pw-s1" } } };
const SSH = { id: "s2", kind: "org.onedesk.datasource:source", name: "Staging", body: { mode: "ssh", sshHost: "staging", container: "postgres", database: "shop", user: "postgres" } };
const csv = (text: string, extra: Record<string, unknown> = {}) => ({ code: 0, signal: "", stdout: text, stderr: "", truncated: false, ...extra });

function fakeHost(over: Host = {}): Host {
  const sources: Record<string, any> = { s1: SOURCE, s2: SSH };
  return {
    params: { get: vi.fn(async () => ({ found: false, value: "", sourceName: "" })) },
    settings: { get: vi.fn(async () => null) },
    resources: { get: vi.fn(async (id: string) => sources[id] ?? null), list: vi.fn(async () => [SOURCE, SSH]) },
    process: { run: vi.fn(async () => csv("a,b\n1,x\n2,\n")) },
    transfer: { capture: vi.fn(async () => ({ code: 0, signal: "", stderr: "", truncated: false, bytes: 10, path: "x" })) },
    ...over,
  };
}
const ctxOf = (host: Host, extra: Record<string, unknown> = {}) => ({ target: "resource:s1", locale: "en-US", host, t, params: {}, progress: vi.fn(), cancelled: () => false, ...extra });

describe("datasource: helpers", () => {
  it("accepts only safe parts for host, container, database and user", () => {
    for (const ok of ["localhost", "db.example.com", "app_user", "a@b", "h:1"]) expect(safePart(ok)).toBe(true);
    for (const bad of ["", "-oProxyCommand=x", "a b", "a;b", "a$(x)", "a`b`", "x".repeat(129), undefined]) expect(safePart(bad as any)).toBe(false);
  });

  it("checks the connection fields in order and names the first bad one", () => {
    const direct = connectionOf({ mode: "direct", host: "h", port: "5432", database: "d", user: "u" });
    expect(checkConnection(direct)).toBe("");
    expect(checkConnection({ ...direct, port: "0" })).toBe("port");
    expect(checkConnection({ ...direct, port: "70000" })).toBe("port");
    expect(checkConnection({ ...direct, host: "" })).toBe("host");
    expect(checkConnection({ ...direct, user: "-x" })).toBe("user");
    const ssh = connectionOf({ mode: "ssh", sshHost: "s", container: "c", database: "d", user: "u" });
    expect(checkConnection(ssh)).toBe("");
    expect(checkConnection({ ...ssh, container: "c; rm" })).toBe("container");
  });

  it("wraps a statement in a read-only transaction that is rolled back; a trailing comment cannot swallow the end", () => {
    expect(readonlyScript("SELECT 1;", 5000)).toBe("BEGIN READ ONLY;\nSET LOCAL statement_timeout = 5000;\nSET LOCAL standard_conforming_strings = on;\nSELECT 1\n;\nROLLBACK;\n");
    expect(readonlyScript("SELECT 1 -- note", 1000)).toContain("SELECT 1 -- note\n;\nROLLBACK;");
  });

  it("reads the text the way PostgreSQL does: one statement, strings, E'' escapes, nested comments, dollar quotes only where they can start", () => {
    const n = (sql: string) => scanSql(sql).statements;
    expect(n("SELECT 1")).toBe(1);
    expect(n("SELECT 1;")).toBe(1);
    expect(n("SELECT 1; -- done\n")).toBe(1);
    expect(n("")).toBe(0);
    expect(n("SELECT ';' , \"a;b\", $$x;y$$ /* ; */")).toBe(1);
    expect(n("SELECT 1; SELECT 2")).toBe(2);
    expect(n("SELECT 1; COMMIT")).toBe(2);
    expect(n("SELECT 1;\n'x'")).toBe(2);
    // E'' : the backslash escapes the quote, so the string goes on and the ; is inside it
    expect(n("SELECT E'a\\'b; COMMIT; DELETE FROM t; --'")).toBe(1);
    // the same text with a plain string: the quote closes, the rest is real statements
    expect(n("SELECT 'a\\'b; COMMIT; DELETE FROM t; --'")).toBeGreaterThan(1);
    // a `$` inside a name is not a dollar quote: here `a$b$` is one name and `; COMMIT` is a second statement
    expect(n("SELECT a$b$ FROM t; COMMIT; $$ x")).toBe(3);
    expect(n("SELECT $a$ ; $a$, $$ ; $$")).toBe(1);
    // block comments nest in PostgreSQL
    expect(n("SELECT 1 /* a /* b */ ; COMMIT */")).toBe(1);
    expect(n("SELECT 1 /* a */ ; COMMIT")).toBe(2);
    expect(scanSql("  (SELECT 1) UNION (SELECT 2)").first).toBe("SELECT");
    expect(scanSql("-- c\n/* c */ with x as (select 1) select * from x").first).toBe("WITH");
  });

  it("a backslash outside strings, quoted names and comments is a psql command and is refused; inside them it is data", () => {
    for (const bad of ["SELECT 1\n\\gexec", "SELECT 1 \\g", "SELECT 1\n\\! id", "SELECT 1\n\\o /tmp/x", "\\c other", "SELECT 1\\;", "SELECT 'x'\\gexec"]) {
      expect(refuse(bad), bad).toBe("backslash");
    }
    for (const ok of ["SELECT 'a\\b'", "SELECT E'a\\nb'", 'SELECT "a\\b"', "SELECT 1 -- \\! id", "SELECT 1 /* \\gexec */", "SELECT $$\\gexec$$"]) {
      expect(refuse(ok), ok).toBeNull();
    }
  });

  it("only reading statements run: SELECT, WITH, VALUES, TABLE, EXPLAIN, SHOW; several statements, COPY, CALL, DO, writes are refused", () => {
    for (const ok of ["SELECT 1", "with x as (select 1) select * from x", "VALUES (1)", "TABLE orders", "EXPLAIN SELECT 1", "SHOW server_version", "(SELECT 1) UNION (SELECT 2)", "-- c\nSELECT 1;"]) expect(refuse(ok), ok).toBeNull();
    for (const bad of ["COPY (SELECT 1) TO PROGRAM 'id'", "DO $$ BEGIN END $$", "CALL p()", "UPDATE t SET a = 1", "DELETE FROM t", "COMMIT", "SELECT 1; SELECT 2", "SELECT E'\\''; COMMIT; DELETE FROM t"]) expect(refuse(bad), bad).not.toBeNull();
    expect(refuse("COPY (SELECT 1) TO PROGRAM 'id'")).toBe("notRead");
    expect(refuse("SELECT 1; SELECT 2")).toBe("severalStatements");
  });

  it("positive whole numbers only for the timeout and the row limit", () => {
    expect(positiveInt(5000, 10000)).toBe(5000);
    for (const bad of [0, -1, 1.5, NaN, Infinity, "5", "5; DROP", null, undefined, 20000]) expect(positiveInt(bad, 10000), String(bad)).toBeNull();
  });

  it("parses CSV as psql writes it: unquoted empty = NULL, \"\" = empty string, quotes, commas and line breaks inside", () => {
    expect(parseCsv('a,b,c\n1,,""\n"x,y","he said ""hi""","l1\nl2"\n')).toEqual([
      ["a", "b", "c"],
      ["1", null, ""],
      ["x,y", 'he said "hi"', "l1\nl2"],
    ]);
    expect(parseCsv("a\r\n1\r\n")).toEqual([["a"], ["1"]]);
    expect(parseCsv("")).toEqual([]);
    expect(parseCsv("a,b")).toEqual([["a", "b"]]);
  });

  it("imports postgres:// and ssh:// strings; a password in the string is reported, not kept", () => {
    expect(parseConnectionUrl("postgres://app%40x:p%23w@db.example:6543/shop?sslmode=require")).toEqual({
      connection: { mode: "direct", host: "db.example", port: "6543", database: "shop", user: "app@x", sshHost: "", container: "" },
      hadPassword: true,
    });
    expect(parseConnectionUrl("postgresql://u@h/d")).toMatchObject({ connection: { port: "5432", user: "u" }, hadPassword: false });
    expect(parseConnectionUrl("ssh://quizbuks-staging/postgres?user=app&db=shop")).toEqual({
      connection: { mode: "ssh", sshHost: "quizbuks-staging", container: "postgres", user: "app", database: "shop", host: "", port: "5432" },
      hadPassword: false,
    });
    expect(parseConnectionUrl("ssh://h/c?db=d")).toEqual({ error: "badUrl" }); // the user is required, there is no default
    for (const bad of ["", "mysql://u@h/d", "postgres://h/d", "postgres://u:p@h/", "ssh://h/c", "ssh://h/c?db=d&x=1", "ssh://-oProxyCommand=x/c?db=d", "ssh://h/c?db=d; rm"]) {
      expect(parseConnectionUrl(bad), bad).toEqual({ error: "badUrl" });
    }
  });

  it("builds the program call: psql with the password only as a {{secret:…}} in the environment; ssh without a shell for the arguments", () => {
    const direct = processSpec(connectionOf(SOURCE.body), "SCRIPT", 30000);
    expect(direct).toEqual({
      program: "psql",
      args: ["-X", "-q", "--csv", "-w", "-v", "ON_ERROR_STOP=1", "-h", "localhost", "-p", "5433", "-U", "app", "-d", "shop", "-f", "-"],
      env: { PGCONNECT_TIMEOUT: "10", PGOPTIONS: "-c default_transaction_read_only=on -c statement_timeout=30000", PGPASSWORD: "{{secret:pw-s1}}" },
      stdin: "SCRIPT",
      timeoutMs: 45000,
    });
    expect(JSON.stringify(direct.args)).not.toContain("pw-s1");
    const noPw = processSpec(connectionOf({ ...SOURCE.body, password: undefined }), "S", 1000);
    expect(noPw.env).toEqual({ PGCONNECT_TIMEOUT: "10", PGOPTIONS: "-c default_transaction_read_only=on -c statement_timeout=1000" });
    expect(processSpec(connectionOf(SSH.body), "S", 1000)).toEqual({
      program: "ssh",
      args: ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "staging", "docker exec -i -e 'PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=1000' postgres psql -X -q --csv -v ON_ERROR_STOP=1 -U postgres -d shop -f -"],
      stdin: "S",
      timeoutMs: 16000,
    });
  });

  it("shortens psql's complaint to its first lines without the program prefix", () => {
    expect(errorText({ code: 1, stderr: "psql: error: connection to server at \"h\" failed: refused\n\tIs the server running?\n" })).toContain("connection to server");
    expect(errorText({ code: 1, stderr: "psql:<stdin>:3: ERROR:  cannot execute CREATE TABLE in a read-only transaction\n" })).toBe("ERROR:  cannot execute CREATE TABLE in a read-only transaction");
    expect(errorText({ code: 255, stderr: "" })).toBe("exit 255");
    expect(errorText({ code: 0, signal: "SIGKILL", stderr: "" })).toBe("signal SIGKILL");
  });
});

describe("datasource: running", () => {
  const conn = connectionOf(SOURCE.body);

  it("returns the header, the rows with NULL as null, and the elapsed time", async () => {
    const host = fakeHost();
    const r = await runReadonly(ctxOf(host), conn, "SELECT a, b FROM t");
    expect(r).toMatchObject({ columns: ["a", "b"], rows: [["1", "x"], ["2", null]], total: 2, truncated: false });
    const call = host.process.run.mock.calls[0]![0];
    expect(call.stdin).toContain("BEGIN READ ONLY;\nSET LOCAL statement_timeout = 30000;\nSET LOCAL standard_conforming_strings = on;\nSELECT a, b FROM t\n;\nROLLBACK;");
  });

  it("cuts at the row limit (the call's own; the in-memory path is only for the connection test) and says it was truncated", async () => {
    const host = fakeHost({ process: { run: vi.fn(async () => csv("n\n1\n2\n3\n4\n")) } });
    const r = await runReadonly(ctxOf(host), conn, "SELECT n", { maxRows: 2 });
    expect(r.rows).toEqual([["1"], ["2"]]);
    expect(r).toMatchObject({ truncated: true, total: 3 });
    const r1 = await runReadonly(ctxOf(host), conn, "SELECT n", { maxRows: 3 });
    expect(r1.rows.length).toBe(3);
    const cut = fakeHost({ process: { run: vi.fn(async () => csv("n\n1\n", { truncated: true })) } });
    expect((await runReadonly(ctxOf(cut), conn, "SELECT n")).truncated).toBe(true);
  });

  it("uses the statement timeout setting, and a bad setting falls back to 30 s", async () => {
    const host = fakeHost({ settings: { get: vi.fn(async (k: string) => (k === "statementTimeoutMs" ? "5000" : null)) } });
    await runReadonly(ctxOf(host), conn, "SELECT 1");
    expect(host.process.run.mock.calls[0]![0].stdin).toContain("statement_timeout = 5000");
    const bad = fakeHost({ settings: { get: vi.fn(async () => "abc") } });
    await runReadonly(ctxOf(bad), conn, "SELECT 1");
    expect(bad.process.run.mock.calls[0]![0].stdin).toContain("statement_timeout = 30000");
  });

  it("refuses an empty statement, several statements and unusable settings before any program starts", async () => {
    const host = fakeHost();
    await expect(runReadonly(ctxOf(host), conn, "  ")).rejects.toThrow("nothing to run");
    await expect(runReadonly(ctxOf(host), conn, "SELECT 1; DROP TABLE x")).rejects.toThrow("one statement");
    await expect(runReadonly(ctxOf(host), conn, "SELECT 1\n\\gexec")).rejects.toThrow("backslash");
    await expect(runReadonly(ctxOf(host), conn, "COPY (SELECT 1) TO PROGRAM 'id'")).rejects.toThrow("Only SELECT");
    await expect(runReadonly(ctxOf(host), conn, "SELECT 1", { timeoutMs: "1; DROP" as any })).rejects.toThrow("positive whole number");
    await expect(captureReadonly(ctxOf(host), conn, "SELECT 1", { timeoutMs: -5 })).rejects.toThrow("positive whole number");
    await expect(runReadonly(ctxOf(host), { ...conn, host: "-bad" }, "SELECT 1")).rejects.toThrow("“host”");
    expect(host.process.run).not.toHaveBeenCalled();
  });

  it("a failing program becomes an error with psql's own message; a refused program names the program", async () => {
    const failing = fakeHost({ process: { run: vi.fn(async () => csv("", { code: 1, stderr: "psql:<stdin>:3: ERROR:  syntax error at or near \"FROM\"\n" })) } });
    await expect(runReadonly(ctxOf(failing), conn, "SELECT FROM")).rejects.toThrow('syntax error at or near "FROM"');
    const missing = fakeHost({ process: { run: vi.fn(async () => { throw hostError("notFound", { what: "program", program: "psql" }); }) } });
    await expect(runReadonly(ctxOf(missing), conn, "SELECT 1")).rejects.toThrow("Cannot run the program psql (notFound)");
  });
});

describe("datasource: capturing to a file", () => {
  const conn = connectionOf(SOURCE.body);
  it("psql writes its CSV into a file in the plugin's own folder; the path is returned, the script is the same read-only one", async () => {
    const host = fakeHost();
    const file = await captureReadonly(ctxOf(host), conn, "SELECT n FROM t");
    expect(file).toMatch(/^tmp\/q-\d+-\d+\.csv$/);
    const call = host.transfer.capture.mock.calls[0]![0];
    expect(call).toMatchObject({ program: "psql", to: file, overwrite: true });
    expect(call.stdin).toContain("BEGIN READ ONLY;\nSET LOCAL statement_timeout = 30000;\nSET LOCAL standard_conforming_strings = on;\nSELECT n FROM t\n;\nROLLBACK;");
    expect(host.process.run).not.toHaveBeenCalled();
  });
  it("refuses the same things before any program starts, and turns a failing psql into the error", async () => {
    const host = fakeHost();
    await expect(captureReadonly(ctxOf(host), conn, "")).rejects.toThrow("nothing to run");
    await expect(captureReadonly(ctxOf(host), conn, "SELECT 1; SELECT 2")).rejects.toThrow("one statement");
    expect(host.transfer.capture).not.toHaveBeenCalled();
    const failing = fakeHost({ transfer: { capture: vi.fn(async () => ({ code: 1, signal: "", stderr: "psql:<stdin>:3: ERROR:  relation \"x\" does not exist\n", truncated: false })) } });
    await expect(captureReadonly(ctxOf(failing), conn, "SELECT * FROM x")).rejects.toThrow('relation "x" does not exist');
    const missing = fakeHost({ transfer: { capture: vi.fn(async () => { throw hostError("notFound", { what: "program", program: "psql" }); }) } });
    await expect(captureReadonly(ctxOf(missing), conn, "SELECT 1")).rejects.toThrow("Cannot run the program psql (notFound)");
  });
});

describe("datasource: page and actions", () => {
  it("registers what the manifest declares", () => {
    const r = registry(plugin);
    expect(Object.keys(r.pages)).toEqual(["editor"]);
    expect(Object.keys(r.actions).sort()).toEqual(["backup", "query", "test"]);
  });

  it("query with inline: true returns the rows themselves (capped by maxRows) and writes no data file", async () => {
    const { actions } = registry(plugin);
    const host = fakeHost({ process: { run: vi.fn(async () => csv("n\n1\n2\n3\n")) } });
    const r = await actions.query(ctxOf(host, { resource: SOURCE }), { sql: "SELECT n FROM t", inline: true, maxRows: 2 });
    expect(r.output.type).toBe("table");
    expect(r.output.file).toBeUndefined();
    expect(r.output.rows).toEqual([["1"], ["2"]]);
    expect(host.transfer.capture).not.toHaveBeenCalled();
    const plain = await actions.query(ctxOf(fakeHost(), { resource: SOURCE }), { sql: "SELECT 1" });
    expect(plain.output.file).toMatch(/^tmp\//);
  });

  it("render: direct shows host, port, database, user and the secret password; ssh shows ssh host and container and no password", async () => {
    const { pages } = registry(plugin);
    const direct = await pages.editor.render(ctxOf(fakeHost(), { resource: SOURCE }));
    expect(checkView(direct.view)).toEqual([]);
    expect(onlyKeys(direct, RENDER_KEYS)).toEqual([]);
    expect(direct.view.map((n: any) => n.id)).toEqual(["mode", "server", "database", "auth", "readonly", "import"]);
    expect(direct.view[3].fields[0]).toMatchObject({ kind: "secret", bind: "body.password" });
    expect(direct.view[1].fields.map((f: any) => f.name)).toEqual(["host", "port"]);
    expect(direct.view[1].fields.every((f: any) => f.required === true)).toBe(true);
    expect(direct.view[1].fields[1].maxLength).toBe(5);

    const ssh = await pages.editor.render(ctxOf(fakeHost(), { resource: SSH }));
    expect(checkView(ssh.view)).toEqual([]);
    expect(ssh.view.map((n: any) => n.id)).toEqual(["mode", "server", "database", "sshNote", "readonly", "backup", "backupNote", "import"]);
    expect(ssh.view[1].fields.map((f: any) => f.name)).toEqual(["sshHost", "container"]);
    expect(JSON.stringify(ssh.view)).not.toContain('"secret"');

    // the unsaved choice of the mode switches the form before it is saved
    const draft = await pages.editor.render(ctxOf(fakeHost(), { resource: SOURCE, draft: { "body.mode": "ssh" } }));
    expect(draft.view[1].fields[0].name).toBe("sshHost");
  });

  it("render: a run page is read only and has no import box", async () => {
    const { pages } = registry(plugin);
    const out = await pages.editor.render(ctxOf(fakeHost(), { resource: SOURCE, run: { id: "r", resourceId: "s1", input: {}, params: {} } }));
    expect(out.view.some((n: any) => n.id === "import")).toBe(false);
    for (const n of out.view) for (const f of n.fields ?? []) expect(f.readOnly).toBe(true);
  });

  it("import event fills the form fields from a connection string and never claims a password was saved", async () => {
    const { pages } = registry(plugin);
    const res = await pages.editor.onEvent(ctxOf(fakeHost(), { params: { importUrl: "postgres://app:secret@db:6000/shop" } }), "import");
    expect(onlyKeys(res, ["changes", "params", "message"])).toEqual([]);
    expect(res.changes).toMatchObject({ "body.mode": "direct", "body.host": "db", "body.port": "6000", "body.database": "shop", "body.user": "app" });
    expect(JSON.stringify(res)).not.toContain("secret@");
    expect(res.message).toContain("without the password");
    const bad = await pages.editor.onEvent(ctxOf(fakeHost(), { params: { importUrl: "nope" } }), "import");
    expect(bad).toEqual({ message: "This is not a connection string OneDesk understands." });
    await expect(pages.editor.onEvent(ctxOf(fakeHost()), "other")).rejects.toThrow();
  });

  it("test action: connects with the form's values (unsaved ones win) and reports the server version", async () => {
    const { actions } = registry(plugin);
    const host = fakeHost({ process: { run: vi.fn(async () => csv("version\nPostgreSQL 15.4 on arm\n")) } });
    const res = await actions.test(ctxOf(host, { resource: SOURCE }), { "body.port": "5999" });
    expect(checkActionResult(res)).toEqual([]);
    expect(res.output.text).toMatch(/^Connected\. PostgreSQL 15\.4 on arm · \d+ ms$/);
    expect(host.process.run.mock.calls[0]![0].args).toContain("5999");
    expect(host.process.run.mock.calls[0]![0].stdin).toContain("SELECT version() AS version");
  });

  it("test action: a refused connection is the run's error", async () => {
    const { actions } = registry(plugin);
    const host = fakeHost({ process: { run: vi.fn(async () => csv("", { code: 2, stderr: "psql: error: connection to server at \"localhost\" failed: Connection refused\n" })) } });
    await expect(actions.test(ctxOf(host, { resource: SOURCE }), {})).rejects.toThrow("Connection refused");
  });

  it("query action: runs on the resource it is given and returns the table as a data file (header on)", async () => {
    const { actions } = registry(plugin);
    const host = fakeHost();
    const res = await actions.query(ctxOf(host, { resource: SSH }), { sql: "SELECT n" });
    expect(checkActionResult(res)).toEqual([]);
    expect(res.output).toEqual({ type: "table", file: expect.stringMatching(/^tmp\/q-/), header: true });
    expect(res.summary.message).toMatch(/^Ran in \d+ ms$/);
    expect(host.transfer.capture.mock.calls[0]![0]).toMatchObject({ program: "ssh" });
    await expect(actions.query(ctxOf(host), { sql: "SELECT 1" })).rejects.toThrow("No data source");
    // a failure is returned as text: across plugins the thrown message would be lost
    expect(await actions.query(ctxOf(host, { resource: SOURCE }), { sql: "" })).toEqual({ error: "There is nothing to run." });
    const failing = fakeHost({ transfer: { capture: vi.fn(async () => ({ code: 1, signal: "", stderr: "psql:<stdin>:3: ERROR:  cannot execute DELETE in a read-only transaction\n", truncated: false })) } });
    expect(await actions.query(ctxOf(failing, { resource: SOURCE }), { sql: "WITH g AS (DELETE FROM t RETURNING 1) SELECT * FROM g" })).toEqual({ error: "ERROR:  cannot execute DELETE in a read-only transaction" });
  });
});

describe("datasource: manifest", () => {
  const m = JSON.parse(readFileSync(new URL("./manifest.json", import.meta.url), "utf8"));
  it("declares the programs as the system's (psql and docker also looked for where their installers put them), the password as a secret field and no network access", () => {
    expect(m.requires.programs.map((p: any) => `${p.name}:${p.source}`)).toEqual(["psql:system", "ssh:system", "docker:system"]);
    expect(m.requires.programs[2].searchPaths).toContain("/Applications/Docker.app/Contents/Resources/bin");
    expect(m.requires.programs[0].searchPaths).toContain("/Library/PostgreSQL/*/bin");
    expect(m.exports.actions).toEqual(["query"]);
    expect(m.requires.network).toBeUndefined();
    expect(m.contributes.kinds[0].fields.password).toEqual({ type: "secret" });
  });
  it("every action the plugin handles is declared", () => {
    expect(m.contributes.actions.map((a: any) => a.id).sort()).toEqual(["backup", "query", "test"]);
    expect(m.contributes.actions.find((a: any) => a.id === "backup")).toMatchObject({ kinds: ["source"], output: "link", saveFirst: true });
    expect(m.contributes.pages[0].actions.find((a: any) => a.id === "backup")).toMatchObject({ role: "run", action: "backup" });
    // The action bar shows the first four; the rest go under "More actions". Import stays a button (e2e round15 F6).
    expect(m.contributes.pages[0].actions.map((a: any) => a.id).slice(0, 4)).toEqual(["test", "save", "save-test", "import"]);
  });
});

/* ---------------------------------------------------------------- backup to this Mac (J1–J4) */

type Res = { code: number | null; signal?: string | null; stdout?: string; stderr?: string };
const res = (r: Partial<Res> = {}) => ({ code: 0, signal: null, stdout: "", stderr: "", truncated: false, ...r });
const PLAN = { backupName: "shop_copy", backupContainer: "pg-local", backupPort: "5544", backupUser: "postgres" };
const DATA = "/ws/plugin-data/org.onedesk.datasource";

// A fake host for the backup: `docker` answers by step (what a test overrides), `ssh` only through
// `transfer.capture`; every call is logged in order. Nothing real runs.
function backupHost(o: { docker?: Record<string, Res>; dump?: Partial<Res> & { bytes?: number }; ready?: any; mkdir?: () => Promise<unknown> } = {}) {
  const log: string[] = [];
  const stepOf = (args: string[]) => (args[0] === "cp" ? "copy" : args[2] === "psql" ? "check" : args[2] === "createdb" ? "create" : args[2] === "pg_restore" ? "restore" : args[2] === "rm" ? "cleanup" : "?");
  const host: Host = fakeHost({
    process: {
      ready: vi.fn(async (name: string) => (log.push(`ready ${name}`), o.ready ?? { ready: true })),
      run: vi.fn(async (spec: any) => {
        const step = stepOf(spec.args);
        log.push(`${spec.program} ${step}`);
        return res(o.docker?.[step] ?? {});
      }),
    },
    transfer: {
      capture: vi.fn(async (spec: any) => {
        log.push(`${spec.program} dump`);
        spec.onProgress?.({ bytes: 3 * 1024 * 1024 });
        const d = { bytes: 3 * 1024 * 1024, ...(o.dump ?? {}) };
        return { ...res(d), bytes: d.bytes, path: `${DATA}/${spec.to}` };
      }),
    },
    files: { mkdir: vi.fn(o.mkdir ?? (async () => (log.push("mkdir"), null))) },
    resources: { create: vi.fn(async (spec: any) => (log.push("create source"), { id: "s9", name: spec.name, kind: spec.kind, body: spec.body })) },
  });
  return { host, log };
}
const ALL_STEPS = ["ready docker", "docker check", "mkdir", "ssh dump", "docker copy", "docker create", "docker restore", "docker cleanup", "create source"];

describe("datasource: backup helpers", () => {
  it("database and container names accept only safe characters", () => {
    for (const ok of ["shop", "shop_copy", "_x", "a1", "x".repeat(63)]) expect(safeDbName(ok), ok).toBe(true);
    for (const bad of ["", "Shop", "1shop", "shop-copy", "shop;drop", "a b", "x".repeat(64), "shop'", undefined]) expect(safeDbName(bad as any), String(bad)).toBe(false);
    for (const ok of ["pg", "pg-local", "my_pg.1"]) expect(safeContainer(ok), ok).toBe(true);
    for (const bad of ["", "-pg", ".pg", "pg local", "pg;rm", "$(x)"]) expect(safeContainer(bad), bad).toBe(false);
  });

  it("reads the page's fields with defaults and names the first bad one", () => {
    expect(backupPlanOf({ backupName: " shop_copy ", backupContainer: "pg" })).toEqual({ name: "shop_copy", container: "pg", port: "5432", user: "postgres" });
    const ok = backupPlanOf(PLAN);
    expect(checkBackup(ok)).toBe("");
    expect(checkBackup({ ...ok, name: "Shop" })).toBe("backupName");
    expect(checkBackup({ ...ok, container: "-x" })).toBe("backupContainer");
    expect(checkBackup({ ...ok, port: "99999" })).toBe("backupPort");
    expect(checkBackup({ ...ok, user: "-U" })).toBe("backupUser");
    expect(suggestDbName("Shop-Prod")).toBe("shop_prod_copy");
    expect(suggestDbName("")).toBe("db_copy");
    expect(stampOf(new Date(Date.UTC(2026, 10, 21, 9, 5, 7)))).toBe("20261121-090507");
  });

  it("pg_dump runs on the server over ssh (never asking), in custom format, into a file that must not exist yet", () => {
    expect(dumpSpec(connectionOf(SSH.body), "backups/shop-x.dump")).toEqual({
      program: "ssh",
      args: ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "staging", "docker exec postgres pg_dump -Fc --no-password -U postgres -d shop"],
      to: "backups/shop-x.dump",
      overwrite: false,
      timeoutMs: 7200000,
    });
  });

  it("the local docker calls: look up, copy, createdb, pg_restore, remove our copy — nothing that drops or overwrites", () => {
    const plan = backupPlanOf(PLAN);
    const x = { file: "/d/backups/f.dump", inContainer: "/tmp/onedesk-restore-1.dump" };
    expect(dockerArgs("check", plan)).toEqual(["exec", "pg-local", "psql", "-X", "-q", "-tA", "-U", "postgres", "-d", "postgres", "-c", "SELECT 1 FROM pg_database WHERE datname = 'shop_copy'"]);
    expect(dockerArgs("copy", plan, x)).toEqual(["cp", "/d/backups/f.dump", "pg-local:/tmp/onedesk-restore-1.dump"]);
    expect(dockerArgs("create", plan)).toEqual(["exec", "pg-local", "createdb", "-U", "postgres", "shop_copy"]);
    expect(dockerArgs("restore", plan, x)).toEqual(["exec", "pg-local", "pg_restore", "--no-owner", "--no-acl", "-U", "postgres", "-d", "shop_copy", "/tmp/onedesk-restore-1.dump"]);
    expect(dockerArgs("cleanup", plan, x)).toEqual(["exec", "pg-local", "rm", "-f", "/tmp/onedesk-restore-1.dump"]);
    const all = JSON.stringify(["check", "copy", "create", "restore", "cleanup"].map((s) => dockerArgs(s, plan, x)));
    expect(all).not.toMatch(/dropdb|DROP|--clean|--create|-c\b.*DROP/);
    expect(BACKUP_STEPS).toEqual(["check", "dump", "copy", "create", "restore", "source"]);
  });
});

describe("datasource: backup to this Mac", () => {
  const plan = backupPlanOf(PLAN);

  it("runs every step in order with progress, saves the dump in the backup folder and makes a direct data source", async () => {
    const { host, log } = backupHost();
    const ctx = ctxOf(host, { resource: SSH });
    const r = await backupToLocal(ctx, SSH, plan);
    expect(log).toEqual(ALL_STEPS);
    expect(host.files.mkdir).toHaveBeenCalledWith("backups");
    const cap = host.transfer.capture.mock.calls[0]![0];
    expect(cap.to).toMatch(/^backups\/shop-\d{8}-\d{6}\.dump$/);
    expect(cap.overwrite).toBe(false);
    expect(r.file).toBe(`${DATA}/${cap.to}`);
    const cp = host.process.run.mock.calls.find((c: any[]) => c[0].args[0] === "cp")![0];
    expect(cp.args[1]).toBe(r.file);
    expect(host.resources.create).toHaveBeenCalledWith({
      kind: "source",
      name: "Staging → shop_copy (local)",
      body: { mode: "direct", host: "localhost", port: "5544", database: "shop_copy", user: "postgres", sshHost: "", container: "" },
    });
    const progress = ctx.progress.mock.calls.map((c: any[]) => c[1]);
    expect(progress).toEqual([
      "Step 1 of 6: checking the local container",
      "Step 2 of 6: running pg_dump on staging and downloading",
      "Step 2 of 6: running pg_dump on staging and downloading (3.0 MB)",
      "Step 3 of 6: copying the dump into pg-local",
      "Step 4 of 6: creating the database shop_copy",
      "Step 5 of 6: restoring into shop_copy",
      "Step 6 of 6: adding the data source",
      "Backup restored.",
    ]);
    const fractions = ctx.progress.mock.calls.map((c: any[]) => c[0]);
    expect(fractions[0]).toBe(0);
    expect(fractions[fractions.length - 1]).toBe(1);
  });

  it("refuses before anything runs: not an ssh source, bad names, a bad source", async () => {
    for (const [source, p, msg] of [
      [SOURCE, plan, "needs a data source reached over ssh"],
      [SSH, { ...plan, name: "shop; DROP DATABASE shop" }, "lower-case letters"],
      [SSH, { ...plan, name: "Shop" }, "lower-case letters"],
      [SSH, { ...plan, container: "pg;rm -rf" }, "docker container name"],
      [SSH, { ...plan, port: "0" }, "1 to 65535"],
      [{ ...SSH, body: { ...SSH.body, container: "x;y" } }, plan, "“container”"],
    ] as const) {
      const { host, log } = backupHost();
      await expect(backupToLocal(ctxOf(host), source, p), msg).rejects.toThrow(msg);
      expect(log, msg).toEqual([]);
    }
  });

  it("stops before the server is touched when docker is missing, the container does not answer, or the database exists", async () => {
    const missing = backupHost({ ready: { ready: false, reason: "notFound" } });
    await expect(backupToLocal(ctxOf(missing.host), SSH, plan)).rejects.toThrow("docker was not found on this Mac (notFound)");
    expect(missing.log).toEqual(["ready docker"]);

    const down = backupHost({ docker: { check: { code: 1, stderr: "Error response from daemon: container pg-local is not running\n" } } });
    await expect(backupToLocal(ctxOf(down.host), SSH, plan)).rejects.toThrow("The backup stopped while checking the local container: Error response from daemon: container pg-local is not running");
    expect(down.log).toEqual(["ready docker", "docker check"]);

    const exists = backupHost({ docker: { check: { code: 0, stdout: "1\n" } } });
    await expect(backupToLocal(ctxOf(exists.host), SSH, plan)).rejects.toThrow("The database “shop_copy” already exists in pg-local. It is left as it is");
    expect(exists.log).toEqual(["ready docker", "docker check"]);
    expect(exists.host.transfer.capture).not.toHaveBeenCalled();
  });

  it("a failing or empty pg_dump stops the run and says where the partial file is", async () => {
    const failing = backupHost({ dump: { code: 1, stderr: 'pg_dump: error: connection to server failed: FATAL:  role "postgres" does not exist\n', bytes: 12 } });
    await expect(backupToLocal(ctxOf(failing.host), SSH, plan)).rejects.toThrow(/stopped while running pg_dump on staging and downloading: pg_dump: error: .*role "postgres" does not exist \(what arrived is kept in \/ws\/plugin-data\/org\.onedesk\.datasource\/backups\/shop-/);
    expect(failing.log).toEqual(["ready docker", "docker check", "mkdir", "ssh dump"]);
    const empty = backupHost({ dump: { bytes: 0 } });
    await expect(backupToLocal(ctxOf(empty.host), SSH, plan)).rejects.toThrow("pg_dump wrote nothing");
    expect(empty.log).toEqual(["ready docker", "docker check", "mkdir", "ssh dump"]);
    const refused = backupHost();
    refused.host.transfer.capture = vi.fn(async () => {
      throw hostError("denied", { reason: "blockedByPolicy", program: "ssh" });
    });
    await expect(backupToLocal(ctxOf(refused.host), SSH, plan)).rejects.toThrow("Cannot run the program ssh (denied/blockedByPolicy)");
  });

  it("a backup folder that already exists is fine; another folder error stops", async () => {
    const exists = backupHost({ mkdir: async () => { throw hostError("conflict", { reason: "exists" }); } });
    await backupToLocal(ctxOf(exists.host), SSH, plan);
    expect(exists.host.resources.create).toHaveBeenCalled();
    const denied = backupHost({ mkdir: async () => { throw hostError("denied", { reason: "outsideGrant" }); } });
    await expect(backupToLocal(ctxOf(denied.host), SSH, plan)).rejects.toThrow("(denied/outsideGrant)");
    expect(denied.host.transfer.capture).not.toHaveBeenCalled();
  });

  it("a failing copy into the container stops before a database is made", async () => {
    const { host, log } = backupHost({ docker: { copy: { code: 1, stderr: "Error: No such container: pg-local\n" } } });
    await expect(backupToLocal(ctxOf(host), SSH, plan)).rejects.toThrow("stopped while copying the dump into pg-local: Error: No such container: pg-local");
    expect(log).toEqual(["ready docker", "docker check", "mkdir", "ssh dump", "docker copy"]);
  });

  it("createdb refusing (a database that appeared meanwhile) stops: nothing restored, our copy removed, no data source", async () => {
    const { host, log } = backupHost({ docker: { create: { code: 1, stderr: 'createdb: error: database creation failed: ERROR:  database "shop_copy" already exists\n' } } });
    await expect(backupToLocal(ctxOf(host), SSH, plan)).rejects.toThrow('stopped while creating the database shop_copy: createdb: error: database creation failed: ERROR:  database "shop_copy" already exists');
    expect(log).toEqual(["ready docker", "docker check", "mkdir", "ssh dump", "docker copy", "docker create", "docker cleanup"]);
    expect(host.resources.create).not.toHaveBeenCalled();
  });

  it("a failing pg_restore stops: our copy removed, no data source, the new database left as it is", async () => {
    const failing = backupHost({ docker: { restore: { code: 1, stderr: "pg_restore: error: input file does not appear to be a valid archive\n" } } });
    await expect(backupToLocal(ctxOf(failing.host), SSH, plan)).rejects.toThrow("stopped while restoring into shop_copy: pg_restore: error: input file does not appear to be a valid archive (the new database shop_copy in pg-local is left as it is)");
    expect(failing.log).toEqual(["ready docker", "docker check", "mkdir", "ssh dump", "docker copy", "docker create", "docker restore", "docker cleanup"]);
    expect(failing.host.resources.create).not.toHaveBeenCalled();
    const killed = backupHost({ docker: { restore: { code: null, signal: "SIGKILL", stderr: "pg_restore: warning: errors ignored on restore: 1\n" } } });
    await expect(backupToLocal(ctxOf(killed.host), SSH, plan)).rejects.toThrow("stopped while restoring");
    expect(killed.host.resources.create).not.toHaveBeenCalled();
  });

  it("only errors pg_restore ignored let it go on (D435): the data source is made, the summary warns with the count and the first error", async () => {
    const stderr = 'pg_restore: error: could not execute query: ERROR:  role "shop_owner" does not exist\nCommand was: ALTER TABLE x OWNER TO shop_owner;\npg_restore: error: could not execute query: ERROR:  role "reader" does not exist\npg_restore: warning: errors ignored on restore: 2\n';
    const warned = backupHost({ docker: { restore: { code: 1, stderr } } });
    const r = await backupToLocal(ctxOf(warned.host), SSH, plan);
    expect(warned.log).toEqual(ALL_STEPS);
    expect(r.warning).toEqual({ count: 2, first: 'could not execute query: ERROR:  role "shop_owner" does not exist' });
    const { actions } = registry(plugin);
    const again = backupHost({ docker: { restore: { code: 1, stderr } } });
    const out = await actions.backup(ctxOf(again.host, { resource: SSH, params: PLAN }), {});
    expect(out.summary.message).toMatch(/ Warning: pg_restore ignored 2 errors \(often roles of the server missing here\)\. The first: could not execute query: ERROR:  role "shop_owner" does not exist$/);
    expect(out.output.type).toBe("link");
  });

  it("never asks the server or the local container to drop, clean or overwrite anything", async () => {
    const { host } = backupHost();
    await backupToLocal(ctxOf(host), SSH, plan);
    const sent = JSON.stringify([...host.process.run.mock.calls, ...host.transfer.capture.mock.calls]);
    expect(sent).not.toMatch(/dropdb|DROP |--clean|--if-exists|"overwrite":true/);
  });
});

describe("datasource: backup action and page", () => {
  it("the action takes the page's fields and links to the new data source", async () => {
    const { actions } = registry(plugin);
    const { host } = backupHost();
    const out = await actions.backup(ctxOf(host, { resource: SSH, params: PLAN }), {});
    expect(checkActionResult(out)).toEqual([]);
    expect(out.output).toEqual({ type: "link", label: "Staging → shop_copy (local)", target: "resource:s9" });
    expect(out.summary.message).toMatch(/^Restored into Staging → shop_copy \(local\)\. The dump \(3\.0 MB\) is saved in \/ws\/plugin-data\/org\.onedesk\.datasource\/backups\/shop-\d{8}-\d{6}\.dump\.$/);
    await expect(actions.backup(ctxOf(host, { params: PLAN }), {})).rejects.toThrow("No data source");
  });

  it("ssh sources show the backup fields (a safe name suggested); direct ones do not; a backup run shows its values read only", async () => {
    const { pages } = registry(plugin);
    const ssh = await pages.editor.render(ctxOf(fakeHost(), { resource: SSH }));
    expect(checkView(ssh.view)).toEqual([]);
    const form = ssh.view.find((n: any) => n.id === "backup");
    expect(form.fields.map((f: any) => f.name)).toEqual(["backupName", "backupContainer", "backupPort", "backupUser"]);
    expect(form.fields.every((f: any) => f.param === true)).toBe(true);
    expect(form.fields[0]).toMatchObject({ placeholder: "shop_copy", maxLength: 63 });
    // The shell refuses every run of the page while a required field is empty: the backup fields (empty unless
    // backing up) must not stop Test connection (e2e fake-tools / round15 F3).
    const required = ssh.view.flatMap((n: any) => (n.type === "form" ? n.fields : [])).filter((f: any) => f.required).map((f: any) => f.name);
    expect(required.every((name: string) => !name.startsWith("backup") && name !== "importUrl")).toBe(true);
    expect(form.fields.some((f: any) => f.required)).toBe(false);
    const direct = await pages.editor.render(ctxOf(fakeHost(), { resource: SOURCE }));
    expect(direct.view.some((n: any) => n.id === "backup")).toBe(false);
    const run = await pages.editor.render(ctxOf(fakeHost(), { resource: SSH, run: { id: "r", action: "backup", input: {}, params: PLAN } }));
    const rf = run.view.find((n: any) => n.id === "backup");
    expect(rf.fields[0]).toMatchObject({ readOnly: true, envValue: "shop_copy" });
    expect(run.view.some((n: any) => n.id === "backupNote")).toBe(false);
    const testRun = await pages.editor.render(ctxOf(fakeHost(), { resource: SSH, run: { id: "r", action: "test", input: {}, params: {} } }));
    expect(testRun.view.some((n: any) => n.id === "backup")).toBe(false);
  });
});
