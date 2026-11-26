import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
// @ts-ignore plain JS module, no types
import plugin, { REMOTE_RUNNER, checkValue, cleanLine, declarations, intIn, lineRow, maskLine, paramNames, paramValues, renderShell, safeHost, scanShell, shellQuote, sshSpec, templateProblem } from "./main.js";
import { hostError, onlyKeys, registry } from "../../plugins/_testing/view-check";

const load = (f: string) => JSON.parse(readFileSync(new URL(`./locales/${f}.json`, import.meta.url), "utf8")) as Record<string, string>;
const EN = load("en-US");
const ZH = load("zh-CN");
const JA = load("ja-JP");
const t = (key: string) => ({ "en-US": EN[key], "zh-CN": ZH[key], "ja-JP": JA[key] });

type Host = Record<string, any>;
type Line = { stream: string; text: string };
const CMD = { id: "c1", kind: "org.onedesk.command:command", name: "Logs", body: { host: "staging", command: "docker logs --tail :lines :app", timeoutSec: "", maxLines: "" } };

// Plays the lines to `onOutput` the way the kernel does with `lines: true` (one whole line per call, at most
// `maxLines`, then the program is ended), then answers with `lines` and `stopped`.
function program(lines: Line[], result: Record<string, unknown> = {}) {
  return vi.fn(async (opts: any) => {
    const max = opts.maxLines ?? 100000;
    const got = lines.slice(0, max);
    for (const l of got) if (opts.onOutput) await opts.onOutput(l);
    const stopped = result.stopped ?? (lines.length > max ? "maxLines" : null);
    return { code: stopped ? null : 0, signal: null, stdout: "", stderr: "", truncated: stopped === "maxLines", lines: got, stopped, ...result };
  });
}
const out = (text: string): Line => ({ stream: "stdout", text });
const err = (text: string): Line => ({ stream: "stderr", text });

function fakeHost(over: Host = {}): Host {
  return {
    params: { get: vi.fn(async () => ({ found: false, value: "", sourceName: "" })) },
    process: { run: program([out("hello")]) },
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

  it("finds :name where bash expands text, with its context; never in '…', $'…', comments or quoted here-documents", () => {
    const ctxs = (t: string) => scanShell(t).pieces.filter((p: any) => p.param).map((p: any) => `${p.param}:${p.ctx}`);
    expect(paramNames("tail -n :lines :file")).toEqual(["lines", "file"]);
    expect(paramNames("echo :a :a :b")).toEqual(["a", "b"]);
    expect(paramNames("tail /var/log/:file.log")).toEqual([]); // inside a path: part of the word
    // part of a word: paths, URLs, user:group, ${x:-y}, ${x:1}, ::
    expect(paramNames("chown app:app /srv && curl http://h:8080/x && echo ${X:-y} ${X:1} a::b ~:x")).toEqual([]);
    expect(paramNames("echo ':a' $':b' \\:c # :d\necho :e")).toEqual(["e"]);
    expect(ctxs('echo ":a" ${X:-x :b} $(echo :c) $((1 + :d)) "$(echo ":e")"')).toEqual(["a:dq", "b:brace", "c:word", "d:arith", "e:dq"]);
    // review #4: the quotes inside "${…}" are nested quotes, so :x is inside "…" (a parameter in "…")
    expect(ctxs('echo "${a:-":x"}"')).toEqual(["x:dq"]);
  });

  it("here-documents: `<<` ends only at the exact line, `<<-` also after tabs; a quoted delimiter keeps the body raw", () => {
    const ctxs = (t: string) => scanShell(t).pieces.filter((p: any) => p.param).map((p: any) => `${p.param}:${p.ctx}`);
    expect(ctxs("cat <<EOF\n:in\nEOF\necho :after")).toEqual(["in:dq", "after:word"]);
    // review #4: with `<<` a line "\tEOF" does not end the body
    expect(ctxs("cat <<EOF\n\tEOF\n:still\nEOF\necho :after")).toEqual(["still:dq", "after:word"]);
    expect(ctxs("cat <<-EOF\n\t:in\n\tEOF\necho :after")).toEqual(["in:dq", "after:word"]);
    expect(ctxs("cat <<'EOF'\n:raw $(x)\nEOF\necho :after")).toEqual(["after:word"]);
    expect(ctxs('cat <<E"O"F\n:raw\nEOF\necho :after')).toEqual(["after:word"]);
    expect(ctxs("cat <<A <<'B'\n:a\nA\n:b\nB\necho :c")).toEqual(["a:dq", "c:word"]);
    expect(ctxs("cat <<< :here")).toEqual(["here:word"]);
    // review #4: `<<` inside arithmetic is a shift, not a here-document
    expect(ctxs("echo $((1<<2)) :x\necho :y")).toEqual(["x:word", "y:word"]);
    expect(ctxs("(( n = 1 << :k ))\necho :y")).toEqual(["k:arith", "y:word"]);
    expect(templateProblem("cat <<EOF\n:x\n")).toBe("openHeredoc");
  });

  it("refuses a template with parameters wherever it cannot be sure how bash reads it; without parameters it runs as written", () => {
    expect(templateProblem("echo `echo :x`")).toBe("backtick");
    expect(templateProblem("echo $(case $a in x) echo :p;; esac)")).toBe("caseInSubst");
    expect(templateProblem("echo $[1 + :n]")).toBe("oldArith");
    expect(templateProblem("echo \"${a:-':x'}\"")).toBe("quoteInBrace");
    expect(templateProblem("echo 'open :x")).toBe("openQuote");
    expect(templateProblem("echo $(echo :x")).toBe("openSubst");
    expect(paramNames("echo `echo :x`")).toEqual([]);
    for (const ok of ["echo `date`", "echo $(case $a in x) echo hi;; esac)", "echo 'open"]) expect(templateProblem(ok), ok).toBeNull();
    expect(templateProblem("echo :a $(echo :b) \"${c:-\"d\"}\"")).toBeNull();
  });

  it("renders values as quoted assignments at the top and expansions in the text, so a value is data wherever it stands", () => {
    const sent = renderShell("grep :pattern /var/log/app.log | tail -n :n\necho \":pattern\" $((:n + 1))", { pattern: "x'; rm -rf / #", n: "3" });
    expect(sent).toBe("OD_P_pattern='x'\\''; rm -rf / #'\nOD_P_n='3'\ngrep \"${OD_P_pattern}\" /var/log/app.log | tail -n \"${OD_P_n}\"\necho \"${OD_P_pattern}\" $((${OD_P_n} + 1))");
    expect(unquote(sent.split("\n")[0]!.slice("OD_P_pattern=".length))).toBe("x'; rm -rf / #");
    expect(renderShell("echo :missing", {})).toBe("OD_P_missing=''\necho \"${OD_P_missing}\"");
    expect(renderShell("uptime", {})).toBe("uptime");
    expect(renderShell("echo ':x' # :x\necho :x", { x: "v" })).toBe("OD_P_x='v'\necho ':x' # :x\necho \"${OD_P_x}\"");
  });

  it("refuses values bash could still run: non-numbers in arithmetic, array indexes with a command in them", async () => {
    const ctx = ctxOf(fakeHost());
    await expect(paramValues({ ...ctx, params: { n: "a[$(id)]" } }, "echo :n")).rejects.toThrow("array index with a command");
    await expect(paramValues({ ...ctx, params: { n: "x" } }, "echo $((:n + 1))")).rejects.toThrow("must be a whole number");
    expect(await paramValues({ ...ctx, params: { n: "-4" } }, "echo $((:n + 1))")).toEqual({ n: "-4" });
    await expect(paramValues({ ...ctx, params: { x: "1" } }, "echo `echo :x`")).rejects.toThrow("inside backticks");
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

  it("runs ssh without a terminal, never asking; the server only sees `exec bash -s`, the command comes after the runner on stdin", () => {
    expect(sshSpec("staging", "echo 'x'", 30)).toEqual({
      program: "ssh",
      args: ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "--", "staging", "exec bash -s"],
      stdin: `${REMOTE_RUNNER}echo 'x'\n`,
      timeoutMs: 30000,
    });
    // the runner is one { … } group, so bash has read all of it before `cat` takes the rest
    expect(REMOTE_RUNNER.startsWith("{\n") && REMOTE_RUNNER.endsWith("\n}\n")).toBe(true);
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
  it("each line becomes a row [stream, line], masked and without colour codes", () => {
    expect(lineRow(out("ok"))).toEqual(["stdout", "ok"]);
    expect(lineRow(err("\x1b[33mwarn\x1b[0m: PASSWORD=x"))).toEqual(["stderr", "warn: PASSWORD=***"]);
    expect(lineRow({ stream: "weird", text: "x" } as any)).toEqual(["stdout", "x"]);
  });
});

describe("command: running", () => {
  it("runs the rendered command over ssh and returns (stream, line) rows drawn as a terminal", async () => {
    const { actions } = registry(plugin);
    const run = program([out("line 1"), out("line 2"), err("oops")]);
    const host = fakeHost({ process: { run } });
    const res = await actions.run(ctxOf(host, { params: { lines: "50", app: "web; reboot" } }), input({ "body.command": CMD.body.command }));
    const spec = run.mock.calls[0]![0];
    expect(spec.program).toBe("ssh");
    expect(spec.args).toContain("BatchMode=yes");
    expect(spec.args).not.toContain(CMD.body.command);
    expect(spec.stdin).toBe(`${REMOTE_RUNNER}OD_P_lines='50'\nOD_P_app='web; reboot'\ndocker logs --tail "\${OD_P_lines}" "\${OD_P_app}"\n`);
    expect(spec.timeoutMs).toBe(60000);
    // X17: the kernel splits the lines and ends the program at the limit or the timeout
    expect(spec).toMatchObject({ lines: true, maxLines: 5000 });
    expect(onlyKeys(res, ["output", "summary", "data"])).toEqual([]);
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

  it("timeout, line limit, server and command: the run's input first, else the resource's saved body (e2e C)", async () => {
    const { actions } = registry(plugin);
    const saved = { ...CMD, body: { host: "saved-host", command: "uptime", timeoutSec: "7", maxLines: "3" } };
    const fromBody = fakeHost();
    await actions.run(ctxOf(fromBody, { resource: saved }), {});
    expect(fromBody.process.run.mock.calls[0]![0]).toMatchObject({ timeoutMs: 7000, maxLines: 3 });
    expect(fromBody.process.run.mock.calls[0]![0].args).toContain("saved-host");
    expect(fromBody.process.run.mock.calls[0]![0].stdin.endsWith("uptime\n")).toBe(true);
    const fromInput = fakeHost();
    await actions.run(ctxOf(fromInput, { resource: saved }), input({ "body.timeoutSec": "9", "body.maxLines": "4" }));
    expect(fromInput.process.run.mock.calls[0]![0]).toMatchObject({ timeoutMs: 9000, maxLines: 4 });
    expect(fromInput.process.run.mock.calls[0]![0].args).toContain("staging");
    // an empty field on the page means the default, not the saved value
    const empty = fakeHost();
    await actions.run(ctxOf(empty, { resource: saved }), input());
    expect(empty.process.run.mock.calls[0]![0]).toMatchObject({ timeoutMs: 60000, maxLines: 5000 });
    await expect(actions.run(ctxOf(fakeHost(), { resource: { ...saved, body: { ...saved.body, timeoutSec: "0" } } }), {})).rejects.toThrow("1 to 7200");
  });

  it("takes parameter values from the environment when none is typed, and refuses a bad one before ssh starts", async () => {
    const { actions } = registry(plugin);
    const host = fakeHost({ params: { get: vi.fn(async (n: string) => (n === "app" ? { found: true, value: "api", sourceName: "Prod" } : { found: false, value: "", sourceName: "" })) } });
    await actions.run(ctxOf(host, { params: { lines: "5" } }), input({ "body.command": CMD.body.command }));
    expect(host.process.run.mock.calls[0]![0].stdin).toBe(`${REMOTE_RUNNER}OD_P_lines='5'\nOD_P_app='api'\ndocker logs --tail "\${OD_P_lines}" "\${OD_P_app}"\n`);

    const strict = fakeHost();
    const cmd = "# @param n type=number required\ntail -n :n x";
    await expect(actions.run(ctxOf(strict, { params: {} }), input({ "body.command": cmd }))).rejects.toThrow("“n” needs a value");
    await expect(actions.run(ctxOf(strict, { params: { n: "1; reboot" } }), input({ "body.command": cmd }))).rejects.toThrow("must be a number");
    await expect(actions.run(ctxOf(strict), input({ "body.host": "-oProxyCommand=x" }))).rejects.toThrow("ssh alias");
    await expect(actions.run(ctxOf(strict), input({ "body.command": "  " }))).rejects.toThrow("no command");
    await expect(actions.run(ctxOf(strict), input({ "body.timeoutSec": "7201" }))).rejects.toThrow("1 to 7200");
    await expect(actions.run(ctxOf(strict), input({ "body.maxLines": "0" }))).rejects.toThrow("1 to 10000");
    expect(strict.process.run).not.toHaveBeenCalled();
  });

  it("masks secret-looking values in the output before it leaves the plugin, partial output included", async () => {
    const { actions } = registry(plugin);
    const host = fakeHost({ process: { run: program([out("DB_PASSWORD=hunter2"), out("API_TOKEN: abc")]) } });
    const res = await actions.run(ctxOf(host), input());
    expect(JSON.stringify(res)).not.toContain("hunter2");
    expect(JSON.stringify(res)).not.toContain("abc");
    for (const call of host.runs.partial.mock.calls) expect(JSON.stringify(call)).not.toContain("hunter2");
  });

  it("hands the lines so far to the shell while the program runs (runs.partial), drawn the same way", async () => {
    const { actions } = registry(plugin);
    // at most one partial output per 300 ms; what came in the window goes out before the run ends
    const quick = fakeHost({ process: { run: program([out("a"), out("b")]) } });
    await actions.run(ctxOf(quick), input());
    expect(quick.runs.partial.mock.calls.map((c: any[]) => c[0].rows)).toEqual([[["stdout", "a"]], [["stdout", "a"], ["stdout", "b"]]]);
    let clock = 0;
    const now = vi.spyOn(Date, "now").mockImplementation(() => (clock += 1000));
    const host = fakeHost({ process: { run: program([out("a"), out("b")]) } });
    await actions.run(ctxOf(host), input());
    now.mockRestore();
    const calls = host.runs.partial.mock.calls;
    expect(calls.length).toBe(2);
    expect(calls[1]![0]).toMatchObject({ type: "table", appearance: "terminal", toneColumn: "stream", rows: [["stdout", "a"], ["stdout", "b"]] });
    // without the capability the run still works
    const old = fakeHost({ runs: undefined });
    expect((await actions.run(ctxOf(old), input())).output.rows).toEqual([["stdout", "hello"]]);
  });

  it("a burst within the throttle window is sent when the window ends, not held until the next line (e2e B)", async () => {
    const { actions } = registry(plugin);
    const sent: string[][] = [];
    let release: () => void = () => {};
    const slept: number[] = [];
    const now = vi.spyOn(Date, "now").mockImplementation(() => 1000); // every line inside one window
    // the program writes a, b, c, then is silent until the trailing send has happened
    const run = vi.fn(async (opts: any) => {
      for (const t of ["a", "b", "c"]) opts.onOutput(out(t));
      await new Promise<void>((r) => (release = r));
      return { code: 0, signal: null, stdout: "", stderr: "", truncated: false, lines: [out("a"), out("b"), out("c")], stopped: null };
    });
    const host = fakeHost({
      process: { run },
      runs: { partial: vi.fn(async (o: any) => sent.push(o.rows.map((r: string[]) => r[1]))) },
      util: {
        sleep: vi.fn(async (ms: number) => {
          slept.push(ms);
          await Promise.resolve();
        }),
      },
    });
    const done = actions.run(ctxOf(host), input());
    await new Promise((r) => setTimeout(r, 0));
    // first line at once; b and c in the window: one sleep for the rest of it, then one send with all three
    expect(slept).toEqual([300]);
    expect(sent).toEqual([["a"], ["a", "b", "c"]]);
    release();
    await done;
    now.mockRestore();
    expect(sent.length).toBe(2); // nothing new at the end: no extra send
  });

  it("partial output carries only the last 500 lines (review #12), with the count so far as its total", async () => {
    const { actions } = registry(plugin);
    let clock = 0;
    const now = vi.spyOn(Date, "now").mockImplementation(() => (clock += 1000));
    const many = Array.from({ length: 1200 }, (_, n) => out(`l${n}`));
    const host = fakeHost({ process: { run: program(many) } });
    const res = await actions.run(ctxOf(host), input());
    now.mockRestore();
    const calls = host.runs.partial.mock.calls.map((c: any[]) => c[0]);
    expect(Math.max(...calls.map((o: any) => o.rows.length))).toBe(500);
    const lastCall = calls[calls.length - 1];
    expect(lastCall.rows[0]).toEqual(["stdout", "l700"]);
    expect(lastCall.rows[499]).toEqual(["stdout", "l1199"]);
    expect(lastCall.total).toBe(1200);
    expect(res.output.rows.length).toBe(1200); // the result itself is complete
  });

  it("stops the program at the line limit and says so", async () => {
    const { actions } = registry(plugin);
    const run = program([out("1"), out("2"), out("3"), out("4")]);
    const res = await actions.run(ctxOf(fakeHost({ process: { run } })), input({ "body.maxLines": "2" }));
    expect(run.mock.calls[0]![0].maxLines).toBe(2);
    expect(res.output.rows).toEqual([["stdout", "1"], ["stdout", "2"]]);
    expect(res.output.total).toBe(3);
    expect(res.summary.message).toBe("2 lines · stopped at the line limit");
    // D435: a failed run that keeps its output
    expect(res.failed).toEqual({ message: "Stopped at the line limit (2 lines)." });
  });

  it("a timeout and a non-zero exit fail the run (D435) and keep the lines so far; exit 0 does not", async () => {
    const { actions } = registry(plugin);
    const slow = program([out("started")], { stopped: "timeout", code: null });
    const res = await actions.run(ctxOf(fakeHost({ process: { run: slow } })), input({ "body.timeoutSec": "5" }));
    expect(slow.mock.calls[0]![0].timeoutMs).toBe(5000);
    expect(res.output.rows).toEqual([["stdout", "started"]]);
    expect(res.summary.message).toBe("1 lines · stopped after 5 s (timeout)");
    expect(res.failed).toEqual({ message: "Stopped after 5 s: the timeout was reached." });
    const failing = program([err("grep: x: No such file")], { code: 2 });
    const r2 = await actions.run(ctxOf(fakeHost({ process: { run: failing } })), input());
    expect(r2.summary.message).toBe("1 lines · exit code 2");
    expect(r2.output.rows).toEqual([["stderr", "grep: x: No such file"]]);
    expect(r2.failed).toEqual({ message: "The program exited with code 2." });
    const killed = await actions.run(ctxOf(fakeHost({ process: { run: program([out("x")], { code: null, signal: "SIGTERM" }) } })), input());
    expect(killed.failed).toEqual({ message: "The program was ended by SIGTERM." });
    const fine = await actions.run(ctxOf(fakeHost()), input());
    expect(fine.failed).toBeUndefined();
    expect(onlyKeys(fine, ["output", "summary", "data"])).toEqual([]);
    expect(onlyKeys(r2, ["output", "summary", "failed", "data"])).toEqual([]);
  });

  it("ssh's own failure (255, nothing on stdout) fails the run with what ssh said", async () => {
    const { actions } = registry(plugin);
    const refused = program([err("staging: Permission denied (publickey).")], { code: 255 });
    const res = await actions.run(ctxOf(fakeHost({ process: { run: refused } })), input());
    expect(res.failed).toEqual({ message: "ssh could not run the command on staging: staging: Permission denied (publickey)." });
    expect(res.output.rows).toEqual([["stderr", "staging: Permission denied (publickey)."]]);
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
    expect(view[1].text).toBe("OD_P_q='select 1'\nPGPASSWORD=*** psql -c \"${OD_P_q}\"");
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
  it("D436: no page action skips the required check (run and save & run use the parameters; copy is an event)", () => {
    expect(m.contributes.pages.flatMap((p: any) => p.actions).some((a: any) => "ignoreRequired" in a)).toBe(false);
  });
  it("every label key the manifest uses exists in English", () => {
    const keys = JSON.stringify(m.contributes).match(/"(?:kind|action|tab)\.[A-Za-z.]+"/g) ?? [];
    for (const k of keys) expect(EN[JSON.parse(k)], k).toBeDefined();
  });
});

describe("command: data for a step in a book (D487 §25)", () => {
  it("gives the exit code, the output and the errors, also by their words", async () => {
    // @ts-ignore plain JS module
    const { runResult } = await import("./main.js");
    const ctx = { t: (k: string) => ({ "en-US": { "data.exitCode": "exitCode", "data.stdout": "output", "data.stderr": "errors" }[k] ?? k, "zh-CN": { "data.exitCode": "退出码", "data.stdout": "输出", "data.stderr": "错误输出" }[k] ?? k }), locale: "zh-CN" };
    const r = runResult(ctx, { code: 0, rows: [["stdout", "2.3.1"], ["stderr", "warn"]], truncated: false, timedOut: false }, 30);
    expect(r.data).toMatchObject({ exitCode: 0, 退出码: 0, stdout: "2.3.1", 输出: "2.3.1", stderr: "warn", 错误输出: "warn" });
  });
});
