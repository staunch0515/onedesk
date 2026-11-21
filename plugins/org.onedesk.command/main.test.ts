import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
// @ts-ignore plain JS module, no types
import plugin, { checkValue, cleanLine, declarations, intIn, lineCollector, maskLine, paramNames, renderShell, safeHost, shellQuote, sshSpec, tokenizeShell } from "./main.js";
import { hostError, onlyKeys, registry } from "../_testing/view-check";

const load = (f: string) => JSON.parse(readFileSync(new URL(`./locales/${f}.json`, import.meta.url), "utf8")) as Record<string, string>;
const EN = load("en-US");
const ZH = load("zh-CN");
const JA = load("ja-JP");
const t = (key: string) => ({ "en-US": EN[key], "zh-CN": ZH[key], "ja-JP": JA[key] });

type Host = Record<string, any>;
type Chunk = { stream: string; text: string };
const CMD = { id: "c1", kind: "org.onedesk.command:command", name: "Logs", body: { host: "staging", command: "docker logs --tail :lines :app", timeoutSec: "", maxLines: "" } };

// Plays the chunks to `onOutput` the way the sandbox does (an exception there stops the program and is what
// `process.run` throws), then answers `result` (or throws `error`).
function program(chunks: Chunk[], result: Record<string, unknown> = { code: 0, signal: null }, error?: Error) {
  return vi.fn(async (opts: any) => {
    for (const c of chunks) if (opts.onOutput) await opts.onOutput(c);
    if (error) throw error;
    return { stdout: "", stderr: "", truncated: false, ...result };
  });
}

function fakeHost(over: Host = {}): Host {
  return {
    params: { get: vi.fn(async () => ({ found: false, value: "", sourceName: "" })) },
    process: { run: program([{ stream: "stdout", text: "hello\n" }]) },
    runs: { partial: vi.fn(async () => null) },
    ui: { copy: vi.fn(async () => null) },
    ...over,
  };
}
const ctxOf = (host: Host, extra: Record<string, unknown> = {}) => ({ target: "resource:c1", locale: "en-US", host, t, params: {}, progress: vi.fn(), cancelled: () => false, ...extra });
const input = (over: Record<string, string> = {}) => ({ "body.host": "staging", "body.command": "echo hi", "body.timeoutSec": "", "body.maxLines": "", ...over });

// Reads back a word written by shellQuote the way sh does: '…' pieces joined by \' — and nothing else.
function unquote(word: string): string {
  expect(word).toMatch(/^'[^']*'(\\''[^']*')*$/);
  return word.slice(1, -1).split("'\\''").join("'");
}

describe("command: parameters and quoting", () => {
  it("quotes any value as one shell word that reads back as the same text", () => {
    const nasty = ["", "plain", "a b", "it's", "'", "''", "$(rm -rf ~)", "`id`", "a; rm -rf /", "x' ; touch /tmp/p ; echo '", "$HOME", "\\", "line1\nline2", "*", "!event", "-rf", "\"dq\"", "日本語"];
    for (const v of nasty) expect(unquote(shellQuote(v)), JSON.stringify(v)).toBe(v);
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });

  it("finds :name only where the shell reads unquoted text", () => {
    expect(paramNames("tail -n :lines :file")).toEqual(["lines", "file"]);
    expect(paramNames("tail /var/log/:file.log")).toEqual([]); // inside a path: part of the word
    expect(paramNames("echo :a :a :b")).toEqual(["a", "b"]);
    // quoted, escaped, commented: not parameters
    expect(paramNames("echo ':a' \":b\" \\:c # :d\necho :e")).toEqual(["e"]);
    // part of a word: paths, URLs, user:group, ${x:-y}, ${x:1}, ::, ports
    expect(paramNames("chown app:app /srv && curl http://h:8080/x && echo ${X:-y} ${X:1} a::b ~:x")).toEqual([]);
    // a here-document body is raw (the shell would expand $(…) there); after it parameters count again
    expect(paramNames("cat <<EOF\n:inside\nEOF\necho :after")).toEqual(["after"]);
    expect(paramNames("cat <<-'END' | wc\n\t:inside\n\tEND\necho :x")).toEqual(["x"]);
    expect(paramNames("cat <<< :here")).toEqual(["here"]);
  });

  it("renders values quoted so no value can add a command, even next to operators", () => {
    const sent = renderShell("grep :pattern /var/log/app.log | tail -n :n", { pattern: "x'; rm -rf / #", n: "$(reboot)" });
    expect(sent).toBe("grep 'x'\\''; rm -rf / #' /var/log/app.log | tail -n '$(reboot)'");
    // the pieces outside the quotes are exactly the text that was written
    const pieces = tokenizeShell("grep :pattern /var/log/app.log | tail -n :n");
    expect(pieces).toEqual([{ raw: "grep " }, { param: "pattern" }, { raw: " /var/log/app.log | tail -n " }, { param: "n" }]);
    expect(renderShell("echo :missing", {})).toBe("echo ''");
    // text in quotes and comments is never touched
    expect(renderShell("echo ':x' # :x\necho :x", { x: "v" })).toBe("echo ':x' # :x\necho 'v'");
  });

  it("reads `# @param` declarations and checks values against them", () => {
    const d = declarations("# @param env values=staging|prod required -- where\n# @param n type=number max=4\necho :env :n");
    expect(d.env).toMatchObject({ type: "enum", required: true, values: ["staging", "prod"], description: "where" });
    expect(d.n).toMatchObject({ type: "number", max: 4 });
    expect(checkValue(d.env, null)).toBe("required");
    expect(checkValue(d.env, "dev")).toBe("enum");
    expect(checkValue(d.n, "12a")).toBe("number");
    expect(checkValue(d.n, "12345")).toBe("tooLong");
    expect(checkValue(d.n, "12")).toBeNull();
    expect(checkValue({ type: "text", required: false, max: 0, values: [] }, "a\0b")).toBe("nul");
  });

  it("accepts only safe ssh hosts and whole numbers in range", () => {
    for (const ok of ["staging", "deploy@10.0.0.1", "db-1.example.com", "h:22"]) expect(safeHost(ok), ok).toBe(true);
    for (const bad of ["", "-oProxyCommand=touch /tmp/x", "a b", "a;b", "$(x)", undefined]) expect(safeHost(bad as any), String(bad)).toBe(false);
    expect(intIn("", 1, 10, 5)).toBe(5);
    expect(intIn(" 7 ", 1, 10, 5)).toBe(7);
    for (const bad of ["0", "11", "1.5", "-1", "1e2", "x"]) expect(intIn(bad, 1, 10, 5), bad).toBeNull();
  });

  it("runs ssh without a terminal, never asking, with the command on stdin, not as an argument", () => {
    expect(sshSpec("staging", "echo 'x'", 30)).toEqual({
      program: "ssh",
      args: ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "--", "staging", "bash -s"],
      stdin: "echo 'x'\n",
      timeoutMs: 30000,
    });
  });
});

describe("command: masking", () => {
  it("masks values of names that look like passwords, keys and tokens", () => {
    const cases: [string, string][] = [
      ["PGPASSWORD=hunter2", "PGPASSWORD=***"],
      ["export DB_PASS=s3cr3t other=1", "export DB_PASS=*** other=1"],
      ["MYSQL_PWD='a b c'", "MYSQL_PWD='***'"],
      ['{"password": "x\\"y", "user": "app"}', '{"password": "***", "user": "app"}'],
      ["api_key: abc123", "api_key: ***"],
      ["AWS_SECRET_ACCESS_KEY=AKIA/xyz+1", "AWS_SECRET_ACCESS_KEY=***"],
      ["--db-password=pw --verbose", "--db-password=*** --verbose"],
      ["GITHUB_TOKEN=ghp_1 SENTRY_DSN=ok", "GITHUB_TOKEN=*** SENTRY_DSN=ok"],
      ["Authorization: Bearer eyJhbGci.x.y", "Authorization: Bearer ***"],
      ["DATABASE_URL=postgres://app:pw@db:5432/shop", "DATABASE_URL=postgres://app:***@db:5432/shop"],
    ];
    for (const [line, want] of cases) expect(maskLine(line), line).toBe(want);
  });

  it("leaves ordinary lines and names alone", () => {
    for (const line of ["user=app host=db", "password incorrect", "Password:", "tokens: [", "secret: {", "passing tests: 12", "ok"]) {
      const out = maskLine(line);
      if (line === "passing tests: 12") expect(out).toBe(line); // `passing` is not `pass…=`
      else expect(out, line).toBe(line);
    }
  });

  it("drops terminal colour codes and the CR of CRLF", () => {
    expect(cleanLine("\x1b[31mred\x1b[0m\r")).toBe("red");
  });
});

describe("command: lines", () => {
  it("splits chunks into lines per stream, joins lines cut across chunks, keeps the order of arrival", () => {
    const c = lineCollector(100);
    c.push({ stream: "stdout", text: "one\ntw" });
    c.push({ stream: "stderr", text: "warn: PASSWORD=x\n" });
    c.push({ stream: "stdout", text: "o\nthree" });
    c.end();
    expect(c.rows).toEqual([
      ["stdout", "one"],
      ["stderr", "warn: PASSWORD=***"],
      ["stdout", "two"],
      ["stdout", "three"],
    ]);
    expect(c.truncated).toBe(false);
  });

  it("stops at the line limit", () => {
    const c = lineCollector(2);
    expect(c.push({ stream: "stdout", text: "a\nb\n" })).toBe(true);
    expect(c.push({ stream: "stdout", text: "c\n" })).toBe(false);
    expect(c.rows.length).toBe(2);
    expect(c.truncated).toBe(true);
  });
});

describe("command: running", () => {
  it("runs the rendered command over ssh and returns (stream, line) rows drawn as a terminal", async () => {
    const { actions } = registry(plugin);
    const run = program([
      { stream: "stdout", text: "line 1\nline 2\n" },
      { stream: "stderr", text: "oops\n" },
    ]);
    const host = fakeHost({ process: { run } });
    const res = await actions.run(ctxOf(host, { params: { lines: "50", app: "web; reboot" } }), input({ "body.command": CMD.body.command }));
    const spec = run.mock.calls[0]![0];
    expect(spec.program).toBe("ssh");
    expect(spec.args).toContain("BatchMode=yes");
    expect(spec.args).not.toContain(CMD.body.command);
    expect(spec.stdin).toBe("docker logs --tail '50' 'web; reboot'\n");
    expect(spec.timeoutMs).toBe(60000);
    expect(onlyKeys(res, ["output", "summary"])).toEqual([]);
    expect(onlyKeys(res.output, ["type", "columns", "rows", "total", "appearance", "toneColumn", "lineColumn"])).toEqual([]);
    expect(res.output).toMatchObject({ type: "table", appearance: "terminal", toneColumn: "stream", lineColumn: "line", total: 3 });
    expect(res.output.columns.map((c: any) => c.key)).toEqual(["stream", "line"]);
    expect(res.output.rows).toEqual([
      ["stdout", "line 1"],
      ["stdout", "line 2"],
      ["stderr", "oops"],
    ]);
    expect(res.summary).toEqual({ rows: 3, message: "3 lines · exit code 0" });
  });

  it("takes parameter values from the environment when none is typed, and refuses a bad one before ssh starts", async () => {
    const { actions } = registry(plugin);
    const host = fakeHost({ params: { get: vi.fn(async (n: string) => (n === "app" ? { found: true, value: "api", sourceName: "Prod" } : { found: false, value: "", sourceName: "" })) } });
    await actions.run(ctxOf(host, { params: { lines: "5" } }), input({ "body.command": CMD.body.command }));
    expect(host.process.run.mock.calls[0]![0].stdin).toBe("docker logs --tail '5' 'api'\n");

    const strict = fakeHost();
    const cmd = "# @param n type=number required\ntail -n :n x";
    await expect(actions.run(ctxOf(strict, { params: {} }), input({ "body.command": cmd }))).rejects.toThrow("“n” needs a value");
    await expect(actions.run(ctxOf(strict, { params: { n: "1; reboot" } }), input({ "body.command": cmd }))).rejects.toThrow("must be a number");
    await expect(actions.run(ctxOf(strict), input({ "body.host": "-oProxyCommand=x" }))).rejects.toThrow("ssh alias");
    await expect(actions.run(ctxOf(strict), input({ "body.command": "  " }))).rejects.toThrow("no command");
    await expect(actions.run(ctxOf(strict), input({ "body.timeoutSec": "601" }))).rejects.toThrow("1 to 600");
    await expect(actions.run(ctxOf(strict), input({ "body.maxLines": "0" }))).rejects.toThrow("1 to 10000");
    expect(strict.process.run).not.toHaveBeenCalled();
  });

  it("masks secret-looking values in the output before it leaves the plugin, partial output included", async () => {
    const { actions } = registry(plugin);
    const host = fakeHost({ process: { run: program([{ stream: "stdout", text: "DB_PASSWORD=hunter2\nAPI_TOKEN: abc\n" }]) } });
    const res = await actions.run(ctxOf(host), input());
    expect(JSON.stringify(res)).not.toContain("hunter2");
    expect(JSON.stringify(res)).not.toContain("abc");
    for (const call of host.runs.partial.mock.calls) expect(JSON.stringify(call)).not.toContain("hunter2");
  });

  it("hands the lines so far to the shell while the program runs (runs.partial), drawn the same way", async () => {
    const { actions } = registry(plugin);
    const host = fakeHost({ process: { run: program([{ stream: "stdout", text: "a\n" }, { stream: "stdout", text: "b\n" }]) } });
    await actions.run(ctxOf(host), input());
    const calls = host.runs.partial.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[calls.length - 1]![0]).toMatchObject({ type: "table", appearance: "terminal", rows: [["stdout", "a"], ["stdout", "b"]] });
    // without the capability the run still works
    const old = fakeHost({ runs: undefined });
    expect((await actions.run(ctxOf(old), input())).output.rows).toEqual([["stdout", "hello"]]);
  });

  it("stops the program at the line limit and says so", async () => {
    const { actions } = registry(plugin);
    const run = program([{ stream: "stdout", text: "1\n2\n3\n" }, { stream: "stdout", text: "4\n" }]);
    const res = await actions.run(ctxOf(fakeHost({ process: { run } })), input({ "body.maxLines": "2" }));
    expect(res.output.rows).toEqual([["stdout", "1"], ["stdout", "2"]]);
    expect(res.output.total).toBe(3);
    expect(res.summary.message).toBe("2 lines · stopped at the line limit");
  });

  it("a timeout keeps the lines so far; a non-zero exit is reported, not an error", async () => {
    const { actions } = registry(plugin);
    const slow = program([{ stream: "stdout", text: "started\n" }], {}, hostError("invalid", { reason: "timeout" }));
    const res = await actions.run(ctxOf(fakeHost({ process: { run: slow } })), input({ "body.timeoutSec": "5" }));
    expect(slow.mock.calls[0]![0].timeoutMs).toBe(5000);
    expect(res.output.rows).toEqual([["stdout", "started"]]);
    expect(res.summary.message).toBe("1 lines · stopped after 5 s (timeout)");
    const failing = program([{ stream: "stderr", text: "grep: x: No such file\n" }], { code: 2 });
    const r2 = await actions.run(ctxOf(fakeHost({ process: { run: failing } })), input());
    expect(r2.summary.message).toBe("1 lines · exit code 2");
    expect(r2.output.rows).toEqual([["stderr", "grep: x: No such file"]]);
  });

  it("ssh's own failure (255, nothing on stdout) fails the run with what ssh said", async () => {
    const { actions } = registry(plugin);
    const refused = program([{ stream: "stderr", text: "staging: Permission denied (publickey).\n" }], { code: 255 });
    await expect(actions.run(ctxOf(fakeHost({ process: { run: refused } })), input())).rejects.toThrow("ssh could not run the command on staging: staging: Permission denied (publickey).");
  });

  it("a missing ssh names the program; a cancelled run stays cancelled", async () => {
    const { actions } = registry(plugin);
    const missing = vi.fn(async () => {
      throw hostError("notFound", { what: "program", program: "ssh" });
    });
    await expect(actions.run(ctxOf(fakeHost({ process: { run: missing } })), input())).rejects.toThrow("Cannot run the program ssh (notFound)");
    const cancelled = vi.fn(async () => {
      throw hostError("denied", { reason: "cancelled" });
    });
    await expect(actions.run(ctxOf(fakeHost({ process: { run: cancelled } })), input())).rejects.toMatchObject({ code: "denied", params: { reason: "cancelled" } });
  });
});

describe("command: page", () => {
  it("registers the page and the action the manifest declares", () => {
    const r = registry(plugin);
    expect(Object.keys(r.pages)).toEqual(["editor"]);
    expect(Object.keys(r.actions)).toEqual(["run"]);
  });

  it("render: server, limits, a field per parameter (with the environment's value) and the editor", async () => {
    const { pages } = registry(plugin);
    const host = fakeHost({ params: { get: vi.fn(async (n: string) => (n === "lines" ? { found: true, value: "100", sourceName: "Dev" } : { found: false, value: "", sourceName: "" })) } });
    const out = await pages.editor.render(ctxOf(host, { resource: CMD }));
    expect(out.view.map((n: any) => n.id)).toEqual(["target", "params", "editor", "note"]);
    expect(out.view[0].fields.map((f: any) => f.bind)).toEqual(["body.host", "body.timeoutSec", "body.maxLines"]);
    expect(out.view[1].fields.map((f: any) => f.name)).toEqual(["lines", "app"]);
    expect(out.view[1].fields[0]).toMatchObject({ param: true, envValue: "100", envSource: "Dev" });
    expect(out.view[2].fields[0]).toMatchObject({ kind: "code", bind: "body.command", language: "shell" });
    const plain = await pages.editor.render(ctxOf(fakeHost(), { resource: { ...CMD, body: { ...CMD.body, command: "uptime" } } }));
    expect(plain.view.map((n: any) => n.id)).toEqual(["target", "editor", "note"]);
  });

  it("render: a run page is read only and shows the values of that run", async () => {
    const { pages } = registry(plugin);
    const run = { id: "r1", input: { "body.command": "echo :x", "body.host": "h" }, params: { x: "v" } };
    const out = await pages.editor.render(ctxOf(fakeHost(), { resource: CMD, run }));
    for (const n of out.view) for (const f of n.fields ?? []) expect(f.readOnly).toBe(true);
    expect(out.view[1].fields[0].envValue).toBe("v");
  });

  it("the sent tab shows the command as it went out, quoted, with secrets masked", async () => {
    const { pages } = registry(plugin);
    const run = { id: "r1", input: { "body.command": "PGPASSWORD=pw psql -c :q", "body.host": "db" }, params: { q: "select 1" } };
    const view = await pages.editor.renderResultTab(ctxOf(fakeHost(), { run }), "sent");
    expect(view[0].text).toBe("On db:");
    expect(view[1].text).toBe("PGPASSWORD=*** psql -c 'select 1'");
    await expect(pages.editor.renderResultTab(ctxOf(fakeHost(), { run }), "x")).rejects.toThrow();
  });

  it("copy puts the command on the clipboard", async () => {
    const { pages } = registry(plugin);
    const host = fakeHost();
    const res = await pages.editor.onEvent(ctxOf(host, { resource: CMD }), "copy");
    expect(host.ui.copy).toHaveBeenCalledWith(CMD.body.command);
    expect(res.message).toBe("Command copied.");
  });
});

describe("command: manifest", () => {
  const m = JSON.parse(readFileSync(new URL("./manifest.json", import.meta.url), "utf8"));
  it("declares only the system's ssh, no files, no network", () => {
    expect(m.requires.programs).toEqual([{ name: "ssh", source: "system" }]);
    expect(m.requires.files).toBe(false);
    expect(m.requires.network).toBeUndefined();
  });
  it("every action the plugin handles is declared, with a table output; kinds can be grouped in the resource tree", () => {
    expect(m.contributes.actions.map((a: any) => `${a.id}:${a.output}`)).toEqual(["run:table"]);
    expect(m.contributes.kinds[0]).toMatchObject({ id: "command", tree: "resources", draggable: true });
  });
  it("every label key the manifest uses exists in English", () => {
    const keys = JSON.stringify(m.contributes).match(/"(?:kind|action|tab)\.[A-Za-z.]+"/g) ?? [];
    for (const k of keys) expect(EN[JSON.parse(k)], k).toBeDefined();
  });
});
