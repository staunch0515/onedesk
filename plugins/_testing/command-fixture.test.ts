/** Checks of the example "command" plugin fixture (external programs + events), with a fake host. */
import { readFileSync, statSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
// @ts-ignore plain JS module, no types
import plugin, { parseArgs, parseEnv } from "../../e2e/fixtures/plugins/com.example.command/0.1.0/main.js";
import { checkActionResult, checkView, hostError } from "./view-check";

const base = "com.example.command/0.1.0";
const dir = (p: string) => new URL(`../../e2e/fixtures/plugins/${p}`, import.meta.url);
const json = (p: string) => JSON.parse(readFileSync(dir(p), "utf8"));
const locale = (l: string) => json(`${base}/locales/${l}.json`) as Record<string, string>;
const t = (key: string) => ({ "en-US": locale("en-US")[key], "zh-CN": locale("zh-CN")[key] });

function register() {
  const pages: Record<string, any> = {};
  const actions: Record<string, any> = {};
  const events: Record<string, any> = {};
  const kinds: Record<string, any> = {};
  plugin.activate({
    kinds: { handle: (id: string, h: unknown) => (kinds[id] = h) },
    pages: { handle: (id: string, h: unknown) => (pages[id] = h) },
    actions: { handle: (id: string, h: unknown) => (actions[id] = h) },
    events: { on: (name: string, h: unknown) => (events[name] = h) },
  });
  return { pages, actions, events, kinds };
}

function fakeHost(over: Record<string, unknown> = {}) {
  const store = new Map<string, string>();
  const host = {
    storage: { get: vi.fn(async (k: string) => store.get(k) ?? null), set: vi.fn(async (k: string, v: string) => void store.set(k, v)) },
    resources: { list: vi.fn(async () => [{}, {}, {}]) },
    process: { run: vi.fn(async () => ({ code: 0, stdout: "", stderr: "", truncated: false })) },
    ...over,
  };
  return { host, store };
}
const ctxOf = (host: unknown, extra: Record<string, unknown> = {}) => ({ locale: "en-US", t, host, progress: vi.fn(), ...extra }) as any;

describe("fixture: command manifest", () => {
  const m = json(`${base}/manifest.json`);
  it("declares system echo/sleep/sh and the packaged hello, and both events", () => {
    expect(m.requires.programs).toEqual([
      { name: "echo", source: "system" },
      { name: "sleep", source: "system" },
      { name: "sh", source: "system" },
      { name: "hello", source: "plugin", path: "bin/hello.sh" },
    ]);
    expect(m.contributes.events).toEqual(["resource.changed", "run.ended"]);
  });
  it("hello.sh is executable", () => {
    expect(statSync(dir(`${base}/bin/hello.sh`)).mode & 0o111).not.toBe(0);
  });
  it("the env field allows secrets", () => {
    expect(m.contributes.kinds[0].fields.env).toEqual({ type: "longtext", secrets: true });
  });
  it("has the same locale keys in both languages and the manifest keys are defined", () => {
    expect(Object.keys(locale("en-US")).sort()).toEqual(Object.keys(locale("zh-CN")).sort());
    for (const k of ["plugin.name", "plugin.description", "kind.command", "kind.command.new", "action.run", "action.save", "action.saveRun", "tab.result", "tab.history"]) expect(locale("en-US")[k]).toBeTruthy();
  });
});

describe("fixture: bad-programs", () => {
  it("is valid JSON naming a system program with a path", () => {
    const m = json("bad-programs/manifest.json");
    expect(m.requires.programs[0]).toMatchObject({ source: "system", path: expect.any(String) });
  });
});

describe("command: parsing", () => {
  it("splits arguments by line, dropping empty lines and \\r", () => {
    expect(parseArgs("a b\r\n\n$(x);y\n")).toEqual(["a b", "$(x);y"]);
    expect(parseArgs("")).toEqual([]);
    expect(parseArgs(undefined)).toEqual([]);
  });
  it("parses NAME=value lines: first '=' splits, comments and bad lines skipped", () => {
    expect(parseEnv("A=1\n# note\n\nB=x=y\n=bad\nnoequals\n C={{secret:k}}")).toEqual({ A: "1", B: "x=y", C: "{{secret:k}}" });
  });
});

describe("command: run action", () => {
  it("passes program, args and env to host.process.run and streams chunks via progress", async () => {
    const { actions } = register();
    const { host } = fakeHost({
      process: {
        run: vi.fn(async (opts: any) => {
          opts.onOutput({ stream: "stdout", text: "one\n" });
          opts.onOutput({ stream: "stderr", text: "oops\n" });
          return { code: 0, stdout: "one\n", stderr: "oops\n", truncated: false };
        }),
      },
    });
    const ctx = ctxOf(host);
    const res = await actions.run(ctx, { "body.program": "sh", "body.args": "-c\necho one", "body.env": "A=1" });
    expect((host.process.run as any).mock.calls[0][0]).toMatchObject({ program: "sh", args: ["-c", "echo one"], env: { A: "1" } });
    expect(ctx.progress.mock.calls.map((c: any[]) => c[1])).toEqual(["one\n", "oops\n"]);
    expect(checkActionResult(res)).toEqual([]);
    expect(res.output.text).toBe("one\n--- stderr ---\noops\n");
    expect(res.summary.message).toMatch(/^exit 0 · \d+ ms$/);
  });
  it("reports a non-zero exit code", async () => {
    const { actions } = register();
    const { host } = fakeHost({ process: { run: vi.fn(async () => ({ code: 3, stdout: "x", stderr: "", truncated: false })) } });
    const res = await actions.run(ctxOf(host), { "body.program": "echo" });
    expect(res.output.text).toBe("x");
    expect(res.summary.message).toMatch(/^exit 3 · /);
  });
  it("names the signal when the process was killed", async () => {
    const { actions } = register();
    const { host } = fakeHost({ process: { run: vi.fn(async () => ({ code: null, signal: "SIGTERM", stdout: "", stderr: "", truncated: false })) } });
    const res = await actions.run(ctxOf(host), { "body.program": "sleep", "body.args": "100" });
    expect(res.summary.message).toMatch(/^SIGTERM · \d+ ms$/);
  });
  it("lets host errors through unchanged (code and params kept)", async () => {
    const { actions } = register();
    const err = hostError("notFound", { what: "program", program: "hello" });
    const { host } = fakeHost({ process: { run: vi.fn(async () => Promise.reject(err)) } });
    await expect(actions.run(ctxOf(host), { "body.program": "hello" })).rejects.toBe(err);
  });
});

describe("command: events", () => {
  it("run.ended writes status and time under lastRun", async () => {
    const { events } = register();
    const { host, store } = fakeHost();
    await events["run.ended"](ctxOf(host), { run: "r1", action: "run", status: "done" });
    const last = JSON.parse(store.get("lastRun")!);
    expect(last.status).toBe("done");
    expect(new Date(last.at).toISOString()).toBe(last.at);
  });
  it("resource.changed writes the number of own-kind resources under count", async () => {
    const { events } = register();
    const { host, store } = fakeHost();
    await events["resource.changed"](ctxOf(host), { id: "x", kind: "com.example.command/command", change: "created" });
    expect(host.resources.list).toHaveBeenCalledWith({ kind: "command" });
    expect(store.get("count")).toBe("3");
  });
  it("subscribes to exactly the declared events", () => {
    expect(Object.keys(register().events).sort()).toEqual([...json(`${base}/manifest.json`).contributes.events].sort());
  });
});

describe("command: page", () => {
  it("is a valid view, shows the two stored items at the top, and offers the four programs", async () => {
    const { pages, events } = register();
    const { host } = fakeHost();
    const empty = await pages.editor.render(ctxOf(host, { resource: { body: {} } }));
    expect(checkView(empty.view)).toEqual([]);
    expect(empty.view[0].text).toBe("Last run: none yet");
    expect(empty.view[1].text).toBe("Commands: 0");
    await events["run.ended"](ctxOf(host), { status: "done" });
    await events["resource.changed"](ctxOf(host), { change: "created" });
    const out = await pages.editor.render(ctxOf(host, { resource: { body: {} } }));
    expect(out.view[0].text).toMatch(/^Last run: done at \d{4}-/);
    expect(out.view[1].text).toBe("Commands: 3");
    const field = out.view.find((n: any) => n.id === "program").fields[0];
    expect(field.options.map((o: any) => o.value)).toEqual(["echo", "sleep", "sh", "hello"]);
  });
  it("is read-only when showing a past run", async () => {
    const { pages } = register();
    const { host } = fakeHost();
    const out = await pages.editor.render(ctxOf(host, { run: {}, resource: { body: {} } }));
    expect(out.view.filter((n: any) => n.fields).every((n: any) => n.fields[0].readOnly)).toBe(true);
  });
});
