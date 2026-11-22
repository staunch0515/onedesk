import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
// @ts-ignore plain JS module, no types
import plugin, { bashSpec, fileNameFor, fileText, maskLine, renderShell } from "./main.js";
import { hostError, onlyKeys, registry } from "../_testing/view-check";

const load = (f: string) => JSON.parse(readFileSync(new URL(`./locales/${f}.json`, import.meta.url), "utf8")) as Record<string, string>;
const EN = load("en-US");
const ZH = load("zh-CN");
const JA = load("ja-JP");
const t = (key: string) => ({ "en-US": EN[key], "zh-CN": ZH[key], "ja-JP": JA[key] });

type Host = Record<string, any>;
type Line = { stream: string; text: string };
const ROOT = { path: "/Users/me/Scripts", name: "Scripts" };
const S1 = { id: "s1", kind: "org.onedesk.script:script", name: "Disk usage", body: { script: "du -sh :folder", timeoutSec: "", maxLines: "" } };
const S2 = { id: "s2", kind: "org.onedesk.script:script", name: "Backup/../etc", body: { script: "#!/bin/zsh\necho hi", timeoutSec: "", maxLines: "" } };
const S3 = { id: "s3", kind: "org.onedesk.script:script", name: "disk usage", body: { script: "", timeoutSec: "", maxLines: "" } };

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

const OWN = "/ws/plugin-data/org.onedesk.script";
// files.*: a relative path is the plugin's own folder; `existing` paths are on disk already. `writeText` answers as
// the kernel does for `conflict` (keepBoth → "name 2.sh", skip → skipped, fail → conflict/exists).
function filesHost(existing: string[] = [], roots = [ROOT]) {
  const abs = (p: string) => (p.startsWith("/") ? p : `${OWN}/${p}`);
  return {
    roots: vi.fn(async () => roots),
    stat: vi.fn(async (p: string) => {
      if (existing.includes(abs(p))) return { path: abs(p) };
      throw hostError("notFound", { what: "path" });
    }),
    writeText: vi.fn(async (p: string, _text: string, o: any = {}) => {
      const path = abs(p);
      if (existing.includes(path)) {
        if (o.conflict === "fail") throw hostError("conflict", { reason: "exists" });
        if (o.conflict === "skip") return { skipped: true };
        if (o.conflict === "keepBoth") return { basis: "b", path: path.replace(/\.sh$/, " 2.sh"), skipped: false };
      }
      return { basis: "b", path, skipped: false };
    }),
    remove: vi.fn(async () => null),
  };
}

function fakeHost(over: Host = {}): Host {
  return {
    params: { get: vi.fn(async () => ({ found: false, value: "", sourceName: "" })) },
    process: { run: program([out("4.0K\t.")]) },
    runs: { partial: vi.fn(async () => null) },
    files: filesHost(),
    resources: { list: vi.fn(async () => [S1, S2, S3]) },
    ...over,
  };
}
const ctxOf = (host: Host, extra: Record<string, unknown> = {}) => ({ target: "resource:s1", locale: "en-US", host, t, params: {}, progress: vi.fn(), cancelled: () => false, ...extra });
const input = (over: Record<string, string> = {}) => ({ "body.script": "echo hi", "body.timeoutSec": "", "body.maxLines": "", ...over });

describe("script: shared shell helpers", () => {
  it("the shell helper block is the same text as in the server command plugin", () => {
    const block = (p: string) => {
      const s = readFileSync(new URL(`../${p}/main.js`, import.meta.url), "utf8");
      return s.slice(s.indexOf("/* ---- shell helpers"), s.indexOf("/* ---- end of shell helpers ---- */"));
    };
    expect(block("org.onedesk.script").length).toBeGreaterThan(1000);
    expect(block("org.onedesk.script")).toBe(block("org.onedesk.command"));
  });
});

describe("script: running", () => {
  it("writes the script (values as quoted assignments) to a file in its own tmp/, runs it with bash with no stdin, removes it", async () => {
    expect(bashSpec("/x/run.sh", 9)).toEqual({ program: "bash", args: ["--noprofile", "--norc", "/x/run.sh"], timeoutMs: 9000 });
    const { actions } = registry(plugin);
    const host = fakeHost();
    const res = await actions.run(ctxOf(host, { params: { folder: "~/x; rm -rf ~" } }), input({ "body.script": S1.body.script }));
    const [tmp, text] = host.files.writeText.mock.calls[0]!;
    expect(tmp).toMatch(/^tmp\/run-\d+-\d+\.sh$/);
    expect(text).toBe("OD_P_folder='~/x; rm -rf ~'\ndu -sh \"${OD_P_folder}\"\n");
    const spec = host.process.run.mock.calls[0]![0];
    expect(spec).toMatchObject({ program: "bash", args: ["--noprofile", "--norc", `${OWN}/${tmp}`], lines: true });
    expect(spec.stdin).toBeUndefined();
    expect(host.files.remove).toHaveBeenCalledWith(`${OWN}/${tmp}`);
    expect(onlyKeys(res.output, ["type", "columns", "rows", "total", "appearance", "toneColumn", "lineColumn"])).toEqual([]);
    expect(res.output).toMatchObject({ appearance: "terminal", toneColumn: "stream", rows: [["stdout", "4.0K\t."]] });
    expect(res.summary.message).toBe("1 lines · exit code 0");
    expect(res.failed).toBeUndefined();
  });

  it("timeout, line limit and script: the run's input first, else the resource's saved body (e2e C)", async () => {
    const { actions } = registry(plugin);
    const saved = { ...S1, body: { script: "echo saved", timeoutSec: "8", maxLines: "2" } };
    const fromBody = fakeHost();
    await actions.run(ctxOf(fromBody, { resource: saved }), {});
    expect(fromBody.process.run.mock.calls[0]![0]).toMatchObject({ timeoutMs: 8000, maxLines: 2 });
    expect(fromBody.files.writeText.mock.calls[0]![1]).toBe("echo saved\n");
    const fromInput = fakeHost();
    await actions.run(ctxOf(fromInput, { resource: saved }), input({ "body.timeoutSec": "11" }));
    expect(fromInput.process.run.mock.calls[0]![0]).toMatchObject({ timeoutMs: 11000 });
    expect(fromInput.files.writeText.mock.calls[0]![1]).toBe("echo hi\n");
  });

  it("the temporary file is removed when the program fails or the run is cancelled too", async () => {
    const { actions } = registry(plugin);
    const host = fakeHost({ process: { run: vi.fn(async () => { throw hostError("denied", { reason: "cancelled" }); }) } });
    await expect(actions.run(ctxOf(host), input())).rejects.toMatchObject({ params: { reason: "cancelled" } });
    expect(host.files.remove).toHaveBeenCalledTimes(1);
  });

  it("uses the timeout and line limit of the script; refuses bad ones before bash starts", async () => {
    const { actions } = registry(plugin);
    const run = program([out("a"), out("b"), out("c"), err("d")]);
    const res = await actions.run(ctxOf(fakeHost({ process: { run } })), input({ "body.timeoutSec": "120", "body.maxLines": "2" }));
    expect(run.mock.calls[0]![0]).toMatchObject({ timeoutMs: 120000, lines: true, maxLines: 2 });
    expect(res.output.rows).toEqual([["stdout", "a"], ["stdout", "b"]]);
    expect(res.summary.message).toBe("2 lines · stopped at the line limit");
    expect(res.failed).toEqual({ message: "Stopped at the line limit (2 lines)." });
    const host = fakeHost();
    await expect(actions.run(ctxOf(host), input({ "body.timeoutSec": "0" }))).rejects.toThrow("1 to 7200");
    await expect(actions.run(ctxOf(host), input({ "body.maxLines": "abc" }))).rejects.toThrow("1 to 10000");
    await expect(actions.run(ctxOf(host), input({ "body.script": "" }))).rejects.toThrow("no script");
    await expect(actions.run(ctxOf(host), input({ "body.script": "# @param x required\necho :x" }))).rejects.toThrow("“x” needs a value");
    expect(host.process.run).not.toHaveBeenCalled();
  });

  it("keeps the lines so far on a timeout, masks secrets, colours stderr through the stream column", async () => {
    const { actions } = registry(plugin);
    const run = program([err("export PGPASSWORD=hunter2")], { stopped: "timeout", code: null });
    const res = await actions.run(ctxOf(fakeHost({ process: { run } })), input({ "body.timeoutSec": "3" }));
    expect(res.output.rows).toEqual([["stderr", "export PGPASSWORD=***"]]);
    expect(res.summary.message).toBe("1 lines · stopped after 3 s (timeout)");
    expect(res.failed).toEqual({ message: "Stopped after 3 s: the timeout was reached." });
    // review of acceptance (D435): `exit 3` at the end is a failed run, its output kept
    const three = await actions.run(ctxOf(fakeHost({ process: { run: program([out("partial work"), err("oops")], { code: 3 }) } })), input({ "body.script": "echo partial work; echo oops >&2; exit 3" }));
    expect(three.failed).toEqual({ message: "The program exited with code 3." });
    expect(three.output.rows).toEqual([["stdout", "partial work"], ["stderr", "oops"]]);
    expect(three.summary.message).toBe("2 lines · exit code 3");
    expect(maskLine("token=abc")).toBe("token=***");
    expect(renderShell("echo :a", { a: "'" }).split("\n")).toEqual(["OD_P_a=''\\'''", 'echo "${OD_P_a}"']);
  });

  it("a missing bash names the program", async () => {
    const { actions } = registry(plugin);
    const missing = vi.fn(async () => {
      throw hostError("notFound", { what: "program", program: "bash" });
    });
    await expect(actions.run(ctxOf(fakeHost({ process: { run: missing } })), input())).rejects.toThrow("Cannot run the program bash (notFound)");
  });
});

describe("script: export all", () => {
  it("file names are safe, never hidden or outside the folder, and unique ignoring case", () => {
    const taken = new Set<string>();
    expect(fileNameFor("Disk usage", taken)).toBe("Disk-usage.sh");
    expect(fileNameFor("disk usage", taken)).toBe("disk-usage-2.sh");
    expect(fileNameFor("../../etc/passwd", taken)).toBe("etc-passwd.sh");
    expect(fileNameFor(".hidden", taken)).toBe("hidden.sh");
    expect(fileNameFor("", taken)).toBe("script.sh");
    expect(fileNameFor("備份 脚本.sh", taken)).toBe("備份-脚本.sh");
    expect(fileText("echo 1")).toBe("#!/usr/bin/env bash\necho 1\n");
    expect(fileText("#!/bin/zsh\necho 1\n")).toBe("#!/bin/zsh\necho 1\n");
  });

  it("writes every saved script as an executable .sh in the chosen granted folder and lists them", async () => {
    const { actions } = registry(plugin);
    const host = fakeHost();
    const res = await actions.exportAll(ctxOf(host, { resource: S1, params: { exportFolder: ROOT.path } }), {});
    expect(host.resources.list).toHaveBeenCalledWith({ kind: "script" });
    const writes = host.files.writeText.mock.calls.map((c: any[]) => [c[0], c[1], c[2]]);
    const opts = { executable: true, conflict: "fail" };
    expect(writes).toEqual([
      ["/Users/me/Scripts/Backup-..-etc.sh", "#!/bin/zsh\necho hi\n", opts],
      ["/Users/me/Scripts/Disk-usage.sh", "#!/usr/bin/env bash\ndu -sh :folder\n", opts],
      ["/Users/me/Scripts/disk-usage-2.sh", "#!/usr/bin/env bash\n", opts],
    ]);
    for (const [path] of writes) expect(path.startsWith(`${ROOT.path}/`) && !path.slice(ROOT.path.length + 1).includes("/")).toBe(true);
    expect(res.output.rows).toEqual([
      ["Backup/../etc", "Backup-..-etc.sh", "written"],
      ["Disk usage", "Disk-usage.sh", "written"],
      ["disk usage", "disk-usage-2.sh", "written"],
    ]);
    expect(res.summary.message).toBe("Exported 3 scripts to Scripts.");
  });

  it("files that exist: without a choice nothing is written; replace, skip and keep both do what the user chose", async () => {
    const { actions } = registry(plugin);
    const there = [`${ROOT.path}/Disk-usage.sh`];
    const ask = fakeHost({ files: filesHost(there) });
    await expect(actions.exportAll(ctxOf(ask), {})).rejects.toThrow("These files already exist: Disk-usage.sh. Choose what to do in “If a file exists”");
    expect(ask.files.writeText).not.toHaveBeenCalled();

    const rows = async (conflict: string) => {
      const h = fakeHost({ files: filesHost(there) });
      const r = await actions.exportAll(ctxOf(h, { params: { exportConflict: conflict } }), {});
      for (const c of h.files.writeText.mock.calls) expect(c[2]).toEqual({ executable: true, conflict });
      return { rows: r.output.rows.map((x: string[]) => `${x[1]}:${x[2]}`), message: r.summary.message };
    };
    expect(await rows("overwrite")).toEqual({ rows: ["Backup-..-etc.sh:written", "Disk-usage.sh:written", "disk-usage-2.sh:written"], message: "Exported 3 scripts to Scripts." });
    expect(await rows("skip")).toEqual({ rows: ["Backup-..-etc.sh:written", "Disk-usage.sh:skipped (exists)", "disk-usage-2.sh:written"], message: "Exported 2 scripts to Scripts." });
    expect((await rows("keepBoth")).rows).toEqual(["Backup-..-etc.sh:written", "Disk-usage 2.sh:written under a new name", "disk-usage-2.sh:written"]);
    await expect(actions.exportAll(ctxOf(fakeHost(), { params: { exportConflict: "delete" } }), {})).rejects.toThrow("not known");

    // a file that appeared after the check is not replaced either (`fail`): the export stops there
    const race = fakeHost({ files: filesHost() });
    race.files.writeText = vi.fn(async (p: string) => {
      if (p.endsWith("/Disk-usage.sh")) throw hostError("conflict", { reason: "exists" });
      return { basis: "b", path: p, skipped: false };
    });
    await expect(actions.exportAll(ctxOf(race), {})).rejects.toMatchObject({ code: "conflict" });
  });

  it("with one granted folder it is used without a choice; with none, several or a revoked one it stops before writing", async () => {
    const { actions } = registry(plugin);
    const one = fakeHost();
    await actions.exportAll(ctxOf(one, { params: {} }), {});
    expect(one.files.writeText).toHaveBeenCalledTimes(3);
    const none = fakeHost({ files: filesHost([], []) });
    await expect(actions.exportAll(ctxOf(none), {})).rejects.toThrow("No folder is granted");
    const two = fakeHost({ files: filesHost([], [ROOT, { path: "/tmp/b", name: "b" }]) });
    await expect(actions.exportAll(ctxOf(two), {})).rejects.toThrow("Choose the folder");
    await expect(actions.exportAll(ctxOf(two, { params: { exportFolder: "/etc" } }), {})).rejects.toThrow("no longer granted");
    const empty = fakeHost({ resources: { list: vi.fn(async () => []) } });
    await expect(actions.exportAll(ctxOf(empty), {})).rejects.toThrow("no saved scripts");
    expect(two.files.writeText).not.toHaveBeenCalled();
  });
});

describe("script: page", () => {
  it("registers the page and both actions", () => {
    const r = registry(plugin);
    expect(Object.keys(r.pages)).toEqual(["editor"]);
    expect(Object.keys(r.actions).sort()).toEqual(["exportAll", "run"]);
  });

  it("render: limits, parameters, editor and the export folder choice (or how to get one)", async () => {
    const { pages } = registry(plugin);
    const out = await pages.editor.render(ctxOf(fakeHost(), { resource: S1 }));
    expect(out.view.map((n: any) => n.id)).toEqual(["limits", "params", "editor", "export"]);
    expect(out.view[3].fields[0]).toMatchObject({ name: "exportFolder", kind: "enum", param: true, options: [{ value: ROOT.path, label: "Scripts" }] });
    expect(out.view[3].fields[1]).toMatchObject({ name: "exportConflict", kind: "enum", param: true });
    expect(out.view[3].fields[1].options.map((o: any) => o.value)).toEqual(["overwrite", "skip", "keepBoth"]);
    const unsure = await pages.editor.render(ctxOf(fakeHost(), { resource: { ...S1, body: { ...S1.body, script: "echo `echo :x`" } } }));
    expect(unsure.view.find((n: any) => n.id === "templateProblem")).toMatchObject({ tone: "danger" });
    const none = await pages.editor.render(ctxOf(fakeHost({ files: { roots: vi.fn(async () => []) } }), { resource: S1 }));
    expect(none.view[3]).toMatchObject({ type: "text", tone: "muted" });
    const run = await pages.editor.render(ctxOf(fakeHost(), { resource: S1, run: { id: "r", input: { "body.script": "echo :x" }, params: { x: "1" } } }));
    expect(run.view.map((n: any) => n.id)).toEqual(["limits", "params", "editor"]);
    for (const n of run.view) for (const f of n.fields ?? []) expect(f.readOnly).toBe(true);
  });
});

describe("script: manifest", () => {
  const m = JSON.parse(readFileSync(new URL("./manifest.json", import.meta.url), "utf8"));
  it("declares the system's bash and granted folders, no network", () => {
    expect(m.requires.programs).toEqual([{ name: "bash", source: "system" }]);
    expect(m.requires.files).toBe(true);
    expect(m.requires.network).toBeUndefined();
  });
  it("every action the plugin handles is declared", () => {
    expect(m.contributes.actions.map((a: any) => `${a.id}:${a.output}`)).toEqual(["run:table", "exportAll:table"]);
  });
  it("D436: only Export all (it uses no script parameter) skips the required check", () => {
    const skip = m.contributes.pages.flatMap((p: any) => p.actions).filter((a: any) => a.ignoreRequired === true).map((a: any) => a.id);
    expect(skip).toEqual(["export-all"]);
  });
  it("every label key the manifest uses exists in English", () => {
    const keys = JSON.stringify(m.contributes).match(/"(?:kind|action|tab)\.[A-Za-z.]+"/g) ?? [];
    for (const k of keys) expect(EN[JSON.parse(k)], k).toBeDefined();
  });
});
