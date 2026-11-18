import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
// @ts-ignore plain JS module, no types
import plugin, { captureReadonly, checkConnection, connectionOf, errorText, hasSeveralStatements, parseConnectionUrl, parseCsv, processSpec, readonlyScript, runReadonly, safePart } from "./main.js";
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
    expect(readonlyScript("SELECT 1;", 5000)).toBe("BEGIN READ ONLY;\nSET LOCAL statement_timeout = 5000;\nSELECT 1\n;\nROLLBACK;\n");
    expect(readonlyScript("SELECT 1 -- note", 1000)).toContain("SELECT 1 -- note\n;\nROLLBACK;");
  });

  it("tells one statement from several, ignoring strings, comments and quoted names", () => {
    expect(hasSeveralStatements("SELECT 1")).toBe(false);
    expect(hasSeveralStatements("SELECT 1;")).toBe(false);
    expect(hasSeveralStatements("SELECT 1; -- done\n")).toBe(false);
    expect(hasSeveralStatements("SELECT ';' , \"a;b\", $$x;y$$ /* ; */")).toBe(false);
    expect(hasSeveralStatements("SELECT 1; SELECT 2")).toBe(true);
    expect(hasSeveralStatements("SELECT 1; COMMIT")).toBe(true);
    expect(hasSeveralStatements("SELECT 1;\n'x'")).toBe(true);
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
    expect(parseConnectionUrl("ssh://h/c?db=d").connection.user).toBe("postgres");
    for (const bad of ["", "mysql://u@h/d", "postgres://h/d", "postgres://u:p@h/", "ssh://h/c", "ssh://h/c?db=d&x=1", "ssh://-oProxyCommand=x/c?db=d", "ssh://h/c?db=d; rm"]) {
      expect(parseConnectionUrl(bad), bad).toEqual({ error: "badUrl" });
    }
  });

  it("builds the program call: psql with the password only as a {{secret:…}} in the environment; ssh without a shell for the arguments", () => {
    const direct = processSpec(connectionOf(SOURCE.body), "SCRIPT", 30000);
    expect(direct).toEqual({
      program: "psql",
      args: ["-X", "-q", "--csv", "-w", "-v", "ON_ERROR_STOP=1", "-h", "localhost", "-p", "5433", "-U", "app", "-d", "shop", "-f", "-"],
      env: { PGCONNECT_TIMEOUT: "10", PGPASSWORD: "{{secret:pw-s1}}" },
      stdin: "SCRIPT",
      timeoutMs: 45000,
    });
    expect(JSON.stringify(direct.args)).not.toContain("pw-s1");
    const noPw = processSpec(connectionOf({ ...SOURCE.body, password: undefined }), "S", 1000);
    expect(noPw.env).toEqual({ PGCONNECT_TIMEOUT: "10" });
    expect(processSpec(connectionOf(SSH.body), "S", 1000)).toEqual({
      program: "ssh",
      args: ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "staging", "docker exec -i postgres psql -X -q --csv -v ON_ERROR_STOP=1 -U postgres -d shop -f -"],
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
    expect(call.stdin).toContain("BEGIN READ ONLY;\nSET LOCAL statement_timeout = 30000;\nSELECT a, b FROM t\n;\nROLLBACK;");
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
    expect(call.stdin).toContain("BEGIN READ ONLY;\nSET LOCAL statement_timeout = 30000;\nSELECT n FROM t\n;\nROLLBACK;");
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
    expect(Object.keys(r.actions).sort()).toEqual(["query", "test"]);
  });

  it("render: direct shows host, port, database, user and the secret password; ssh shows ssh host and container and no password", async () => {
    const { pages } = registry(plugin);
    const direct = await pages.editor.render(ctxOf(fakeHost(), { resource: SOURCE }));
    expect(checkView(direct.view)).toEqual([]);
    expect(onlyKeys(direct, RENDER_KEYS)).toEqual([]);
    expect(direct.view.map((n: any) => n.id)).toEqual(["mode", "server", "database", "auth", "import"]);
    expect(direct.view[3].fields[0]).toMatchObject({ kind: "secret", bind: "body.password" });
    expect(direct.view[1].fields.map((f: any) => f.name)).toEqual(["host", "port"]);
    expect(direct.view[1].fields.every((f: any) => f.required === true)).toBe(true);
    expect(direct.view[1].fields[1].maxLength).toBe(5);

    const ssh = await pages.editor.render(ctxOf(fakeHost(), { resource: SSH }));
    expect(checkView(ssh.view)).toEqual([]);
    expect(ssh.view.map((n: any) => n.id)).toEqual(["mode", "server", "database", "sshNote", "import"]);
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
    await expect(actions.query(ctxOf(host, { resource: SOURCE }), { sql: "" })).rejects.toThrow();
  });
});

describe("datasource: manifest", () => {
  const m = JSON.parse(readFileSync(new URL("./manifest.json", import.meta.url), "utf8"));
  it("declares both programs as the system's (psql also looked for where PostgreSQL installers put it), the password as a secret field and no network access", () => {
    expect(m.requires.programs.map((p: any) => `${p.name}:${p.source}`)).toEqual(["psql:system", "ssh:system"]);
    expect(m.requires.programs[0].searchPaths).toContain("/Library/PostgreSQL/*/bin");
    expect(m.exports.actions).toEqual(["query"]);
    expect(m.requires.network).toBeUndefined();
    expect(m.contributes.kinds[0].fields.password).toEqual({ type: "secret" });
  });
  it("every action the plugin handles is declared", () => {
    expect(m.contributes.actions.map((a: any) => a.id).sort()).toEqual(["query", "test"]);
  });
});
