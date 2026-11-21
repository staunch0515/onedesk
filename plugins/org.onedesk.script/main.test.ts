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
type Chunk = { stream: string; text: string };
const ROOT = { path: "/Users/me/Scripts", name: "Scripts" };
const S1 = { id: "s1", kind: "org.onedesk.script:script", name: "Disk usage", body: { script: "du -sh :folder", timeoutSec: "", maxLines: "" } };
const S2 = { id: "s2", kind: "org.onedesk.script:script", name: "Backup/../etc", body: { script: "#!/bin/zsh\necho hi", timeoutSec: "", maxLines: "" } };
const S3 = { id: "s3", kind: "org.onedesk.script:script", name: "disk usage", body: { script: "", timeoutSec: "", maxLines: "" } };

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
    process: { run: program([{ stream: "stdout", text: "4.0K\t.\n" }]) },
    runs: { partial: vi.fn(async () => null) },
    files: { roots: vi.fn(async () => [ROOT]), writeText: vi.fn(async () => ({ basis: "b" })) },
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
  it("runs bash without startup files, with the script (values quoted) on stdin", async () => {
    expect(bashSpec("echo 1", 9)).toEqual({ program: "bash", args: ["--noprofile", "--norc", "-s"], stdin: "echo 1\n", timeoutMs: 9000 });
    const { actions } = registry(plugin);
    const host = fakeHost();
    const res = await actions.run(ctxOf(host, { params: { folder: "~/x; rm -rf ~" } }), input({ "body.script": S1.body.script }));
    const spec = host.process.run.mock.calls[0]![0];
    expect(spec.program).toBe("bash");
    expect(spec.stdin).toBe("du -sh '~/x; rm -rf ~'\n");
    expect(spec.args).not.toContain(S1.body.script);
    expect(onlyKeys(res.output, ["type", "columns", "rows", "total", "appearance", "toneColumn", "lineColumn"])).toEqual([]);
    expect(res.output).toMatchObject({ appearance: "terminal", toneColumn: "stream", rows: [["stdout", "4.0K\t."]] });
    expect(res.summary.message).toBe("1 lines · exit code 0");
  });

  it("uses the timeout and line limit of the script; refuses bad ones before bash starts", async () => {
    const { actions } = registry(plugin);
    const run = program([{ stream: "stdout", text: "a\nb\nc\n" }, { stream: "stderr", text: "d\n" }]);
    const res = await actions.run(ctxOf(fakeHost({ process: { run } })), input({ "body.timeoutSec": "120", "body.maxLines": "2" }));
    expect(run.mock.calls[0]![0].timeoutMs).toBe(120000);
    expect(res.output.rows).toEqual([["stdout", "a"], ["stdout", "b"]]);
    expect(res.summary.message).toBe("2 lines · stopped at the line limit");
    const host = fakeHost();
    await expect(actions.run(ctxOf(host), input({ "body.timeoutSec": "0" }))).rejects.toThrow("1 to 600");
    await expect(actions.run(ctxOf(host), input({ "body.maxLines": "abc" }))).rejects.toThrow("1 to 10000");
    await expect(actions.run(ctxOf(host), input({ "body.script": "" }))).rejects.toThrow("no script");
    await expect(actions.run(ctxOf(host), input({ "body.script": "# @param x required\necho :x" }))).rejects.toThrow("“x” needs a value");
    expect(host.process.run).not.toHaveBeenCalled();
  });

  it("keeps the lines so far on a timeout, masks secrets, colours stderr through the stream column", async () => {
    const { actions } = registry(plugin);
    const run = program([{ stream: "stderr", text: "export PGPASSWORD=hunter2\n" }], {}, hostError("invalid", { reason: "timeout" }));
    const res = await actions.run(ctxOf(fakeHost({ process: { run } })), input({ "body.timeoutSec": "3" }));
    expect(res.output.rows).toEqual([["stderr", "export PGPASSWORD=***"]]);
    expect(res.summary.message).toBe("1 lines · stopped after 3 s (timeout)");
    expect(maskLine("token=abc")).toBe("token=***");
    expect(renderShell("echo :a", { a: "'" })).toBe("echo ''\\'''");
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

  it("writes every saved script as a .sh file in the chosen granted folder and lists them", async () => {
    const { actions } = registry(plugin);
    const host = fakeHost();
    const res = await actions.exportAll(ctxOf(host, { resource: S1, params: { exportFolder: ROOT.path } }), {});
    expect(host.resources.list).toHaveBeenCalledWith({ kind: "script" });
    const writes = host.files.writeText.mock.calls.map((c: any[]) => [c[0], c[1]]);
    expect(writes).toEqual([
      ["/Users/me/Scripts/Backup-..-etc.sh", "#!/bin/zsh\necho hi\n"],
      ["/Users/me/Scripts/Disk-usage.sh", "#!/usr/bin/env bash\ndu -sh :folder\n"],
      ["/Users/me/Scripts/disk-usage-2.sh", "#!/usr/bin/env bash\n"],
    ]);
    for (const [path] of writes) expect(path.startsWith(`${ROOT.path}/`) && !path.slice(ROOT.path.length + 1).includes("/")).toBe(true);
    expect(res.output.rows).toEqual([["Backup/../etc", "Backup-..-etc.sh"], ["Disk usage", "Disk-usage.sh"], ["disk usage", "disk-usage-2.sh"]]);
    expect(res.summary.message).toBe("Exported 3 scripts to Scripts.");
  });

  it("with one granted folder it is used without a choice; with none, several or a revoked one it stops before writing", async () => {
    const { actions } = registry(plugin);
    const one = fakeHost();
    await actions.exportAll(ctxOf(one, { params: {} }), {});
    expect(one.files.writeText).toHaveBeenCalledTimes(3);
    const none = fakeHost({ files: { roots: vi.fn(async () => []), writeText: vi.fn() } });
    await expect(actions.exportAll(ctxOf(none), {})).rejects.toThrow("No folder is granted");
    const two = fakeHost({ files: { roots: vi.fn(async () => [ROOT, { path: "/tmp/b", name: "b" }]), writeText: vi.fn() } });
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
  it("every label key the manifest uses exists in English", () => {
    const keys = JSON.stringify(m.contributes).match(/"(?:kind|action|tab)\.[A-Za-z.]+"/g) ?? [];
    for (const k of keys) expect(EN[JSON.parse(k)], k).toBeDefined();
  });
});
