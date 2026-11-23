// Runs what the server command and local script plugins build with the real /bin/bash (review #4, #7, #15), only
// inside a temporary folder. Nothing here connects anywhere: the "server" side of the runner is a local bash too.
// It lives here, not in the plugin packages, because plugin tests use only what the sandbox has.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
// @ts-ignore plain JS module, no types
import * as command from "../../plugins-external/org.onedesk.command/main.js";
// @ts-ignore plain JS module, no types
import * as script from "../../plugins-external/org.onedesk.script/main.js";

const { REMOTE_RUNNER } = command;
const PLUGINS = [
  ["command", command],
  ["script", script],
] as const;

const dir = mkdtempSync(join(process.env.TMPDIR || "/tmp", "od-bash-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const MARK = join(dir, "PWNED");

// Runs a script from a file (as the plugin does), with an empty stdin, in the temporary folder.
function bash(script: string) {
  const file = join(dir, "run.sh");
  writeFileSync(file, script);
  const r = spawnSync("/bin/bash", ["--noprofile", "--norc", file], { cwd: dir, encoding: "utf8", input: "", timeout: 10000 });
  return { out: r.stdout, err: r.stderr, code: r.status };
}

const HOSTILE = [
  "$(touch PWNED)",
  "`touch PWNED`",
  "'; touch PWNED; '",
  '"; touch PWNED; "',
  "$(touch PWNED)'\"",
  '"}; touch PWNED; {"',
  "EOF\ntouch PWNED",
  "\\",
  "-n",
  "*",
  "a b  c",
  "",
];

// template → what it prints for value v (the review's three bypasses included)
const TEMPLATES: [string, (v: string) => string][] = [
  ["printf '%s\\n' :x", (v) => `${v}\n`],
  ["printf '%s\\n' \":x\"", (v) => `${v}\n`],
  ['printf \'%s\\n\' "${a:-":x"}"', (v) => `${v}\n`],
  // unquoted ${…}: bash drops an empty quoted word there (a bash rule, not an escape)
  ["printf '[%s]\\n' ${a:-x :x}", (v) => (v === "" ? "[x]\n" : `[x]\n[${v}]\n`)],
  ["printf '%s\\n' \"$(printf '%s' :x)\"", (v) => `${v}\n`],
  ["cat <<EOF\n:x\nEOF", (v) => `${v}\n`],
  ["cat <<EOF\n\tEOF\n:x\nEOF", (v) => `\tEOF\n${v}\n`],
  ["cat <<-EOF\n\t:x\n\tEOF", (v) => `${v}\n`],
  ["printf '%s %s\\n' $((1<<2)) :x", (v) => `4 ${v}\n`],
  ["cat <<'EOF'\n:x $(touch PWNED)\nEOF\nprintf '%s\\n' :x", (v) => `:x $(touch PWNED)\n${v}\n`],
];

describe.each(PLUGINS)("%s: rendered scripts in real bash", (_name, plugin) => {
  it.each(TEMPLATES.map(([t, f], i) => [i, t, f] as const))("template %i: every value comes out as data, nothing runs", (_i, template, expected) => {
    expect(plugin.templateProblem(template)).toBeNull();
    for (const v of HOSTILE) {
      rmSync(MARK, { force: true });
      const r = bash(plugin.renderShell(template, { x: v }));
      expect(r.err, JSON.stringify(v)).toBe("");
      expect(r.out, JSON.stringify(v)).toBe(expected(v));
      expect(existsSync(MARK), JSON.stringify(v)).toBe(false);
    }
  });

  it("arithmetic gets whole numbers (others are refused before, see main.test.ts)", () => {
    expect(bash(plugin.renderShell("echo $(( :x * 2 ))\n(( y = :x + 1 )); echo $y", { x: "21" })).out).toBe("42\n22\n");
  });
});

describe("command: the server-side runner in real bash", () => {
  const runner = (script: string) => spawnSync("/bin/bash", ["-s"], { cwd: dir, encoding: "utf8", input: REMOTE_RUNNER + script, timeout: 10000 });

  it("runs the command from a temporary file with an empty stdin, keeps both streams and the exit code, removes the file", () => {
    const r = runner('echo out; echo err >&2; if read -r line; then echo "read:$line"; fi; cat; echo "$0" > where; exit 3\necho never\n');
    expect(r.stdout).toBe("out\n");
    expect(r.stderr).toBe("err\n");
    expect(r.status).toBe(3);
    const file = spawnSync("/bin/cat", [join(dir, "where")], { encoding: "utf8" }).stdout.trim();
    expect(file).toMatch(/onedesk\.\w+$/);
    expect(existsSync(file)).toBe(false);
  });

  it("a command that reads stdin cannot eat the lines after it (review #15)", () => {
    const r = runner("cat\nwc -l </dev/null >/dev/null\necho after\n");
    expect(r.stdout).toBe("after\n");
    expect(r.status).toBe(0);
  });

  it(
    "when its parent goes away (the ssh connection closed: cancel or timeout here), the command is ended too (review #7)",
    () => {
      const input = join(dir, "input");
      const late = join(dir, "LATE");
      rmSync(late, { force: true });
      writeFileSync(input, `${REMOTE_RUNNER}sleep 3; touch ${JSON.stringify(late)}\n`);
      // the runner's parent is this small shell; it leaves after one second, as sshd does when the connection drops
      const parent = spawnSync("/bin/bash", ["-c", `( exec /bin/bash -s < ${JSON.stringify(input)} > /dev/null 2>&1 ) & sleep 1; exit 0`], { timeout: 10000 });
      expect(parent.status).toBe(0);
      spawnSync("/bin/sleep", ["4"]);
      expect(existsSync(late)).toBe(false);
    },
    15000,
  );

  it("with its parent still there the command runs to the end", () => {
    const done = join(dir, "DONE");
    rmSync(done, { force: true });
    const r = runner(`sleep 1; touch ${JSON.stringify(done)}; echo ok\n`);
    expect(r.stdout).toBe("ok\n");
    expect(existsSync(done)).toBe(true);
  });
});
