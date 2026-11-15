import { describe, expect, it, vi } from "vitest";
// @ts-ignore plain JS module, no types
import plugin, { buildRows, fillParams, hash, paramKind, paramNames, tidy } from "./main.js";
import { readFileSync } from "node:fs";
import { EVENT_RESULT_KEYS, RENDER_KEYS, checkActionResult, checkView, onlyKeys, registry } from "../_testing/view-check";

const load = (f: string) => JSON.parse(readFileSync(new URL(`./locales/${f}.json`, import.meta.url), "utf8")) as Record<string, string>;
const EN = load("en-US");
const ZH = load("zh-CN");
/** The kernel's `ctx.t`: a localized Label from the plugin's own locale files. */
const t = (key: string) => ({ "en-US": EN[key], "zh-CN": ZH[key] });

type Host = Record<string, any>;
function fakeHost(over: Host = {}): Host {
  const store = new Map<string, string>();
  return {
    params: { get: vi.fn(async () => ({ found: false, value: "", sourceName: "" })) },
    storage: {
      get: vi.fn(async (k: string) => store.get(k) ?? null),
      set: vi.fn(async (k: string, v: string) => void store.set(k, v)),
    },
    settings: { get: vi.fn(async () => null) },
    util: { sleep: vi.fn(async () => undefined) },
    ...over,
  };
}
const ctxOf = (host: Host, extra: Record<string, unknown> = {}) => ({
  target: "resource:r1",
  locale: "en-US",
  host,
  t,
  params: {},
  progress: vi.fn(),
  cancelled: () => false,
  ...extra,
});
const noteOf = (text: string) => ({ resource: { body: { text } } });

describe("sample: helpers", () => {
  it("finds :name parameters outside strings and comments, in order, once", () => {
    expect(paramNames("select * from t where a = :tenant_id and b = :start_time and c = :tenant_id")).toEqual(["tenant_id", "start_time"]);
    expect(paramNames("select ':nope', \":nor\" -- :never\n /* :no */ where x = :yes")).toEqual(["yes"]);
    expect(paramNames("a::int, :ok")).toEqual(["ok"]);
  });
  it("guesses a type from the name", () => {
    expect(paramKind("tenant_id")).toBe("number");
    expect(paramKind("limit")).toBe("number");
    expect(paramKind("start_time")).toBe("datetime");
    expect(paramKind("end_date")).toBe("date");
    expect(paramKind("channel")).toBe("text");
  });
  it("fills :name with values and leaves unknown ones", () => {
    expect(fillParams("where a = :a and b = :b -- :a", { a: "1" })).toBe("where a = 1 and b = :b -- :a");
  });
  it("tidies keywords by the style and keeps strings and parameters", () => {
    expect(tidy("select a from t where x = ':from' and y = :where", "upper")).toBe("SELECT a FROM t WHERE x = ':from' AND y = :where");
    expect(tidy("SELECT 1 FROM t", "lower")).toBe("select 1 from t");
  });
  it("makes the same rows for the same input and honours the limit", () => {
    expect(hash("a")).toBe(hash("a"));
    const a = buildRows("x", { p: "1" }, 5);
    expect(buildRows("x", { p: "1" }, 5)).toEqual(a);
    expect(a.rows).toHaveLength(Math.min(5, a.total));
    expect(buildRows("x", {}, 0).rows).toEqual([]);
    expect(buildRows("x", {}, 100000).rows.length).toBe(buildRows("x", {}, 100000).total);
  });
});

describe("sample: page", () => {
  it("registers what the manifest declares", () => {
    const r = registry(plugin);
    expect(Object.keys(r.pages)).toEqual(["editor"]);
    expect(Object.keys(r.actions).sort()).toEqual(["explain", "run"]);
    expect(r.trees).toEqual({});
  });

  it("render: parameter strip from the text, env values as placeholder with source, full-height editor", async () => {
    const { pages } = registry(plugin);
    const host = fakeHost({
      params: { get: vi.fn(async (n: string) => (n === "tenant_id" ? { found: true, value: "42", sourceName: "Prod" } : { found: false, value: "", sourceName: "" })) },
    });
    const out = await pages.editor.render(ctxOf(host, noteOf("select :tenant_id, :channel")));
    expect(checkView(out.view)).toEqual([]);
    expect(onlyKeys(out, RENDER_KEYS)).toEqual([]);
    const strip = out.view[0];
    expect(strip).toMatchObject({ type: "form", layout: "strip" });
    expect(strip.fields).toEqual([
      { name: "tenant_id", label: "tenant_id", kind: "number", param: true, envValue: "42", envSource: "Prod" },
      { name: "channel", label: "channel", kind: "text", param: true },
    ]);
    const editor = out.view[out.view.length - 1].fields[0];
    expect(editor).toMatchObject({ kind: "code", bind: "body.text", fill: true });
    expect("readOnly" in editor).toBe(false);
  });

  it("render: no strip without parameters; uses the unsaved draft; shows the last run summary", async () => {
    const { pages } = registry(plugin);
    const host = fakeHost();
    await host.storage.set("lastRun", JSON.stringify({ rows: 7, total: 90 }));
    const out = await pages.editor.render(ctxOf(host, { ...noteOf("saved :old"), draft: { "body.text": "select 1" } }));
    expect(checkView(out.view)).toEqual([]);
    expect(out.view.map((n: any) => n.id)).toEqual(["last", "editor"]);
    expect(out.view[0]).toMatchObject({ type: "text", tone: "muted", text: "Last run: 7 of 90 rows" });
    const none = await pages.editor.render(ctxOf(fakeHost(), noteOf("")));
    expect(none.view[0].text).toBe("No run yet");
  });

  it("render: a run page is read only and shows the run's parameter values", async () => {
    const { pages } = registry(plugin);
    const run = { id: "run1", input: { "body.text": "select :a" }, params: { a: "5" } };
    const out = await pages.editor.render(ctxOf(fakeHost(), { run }));
    expect(checkView(out.view)).toEqual([]);
    expect(out.view[0].fields[0]).toMatchObject({ name: "a", envValue: "5", readOnly: true });
    expect(out.view[out.view.length - 1].fields[0].readOnly).toBe(true);
  });

  it("onEvent tidy: changes the text by the style setting, with a message", async () => {
    const { pages } = registry(plugin);
    const res = await pages.editor.onEvent(ctxOf(fakeHost(), { ...noteOf("select 1 from t") }), "tidy");
    expect(res.changes).toEqual({ "body.text": "SELECT 1 FROM t" });
    expect(onlyKeys(res, EVENT_RESULT_KEYS)).toEqual([]);
    const lower = fakeHost({ settings: { get: vi.fn(async () => "lower") } });
    const r2 = await pages.editor.onEvent(ctxOf(lower, { draft: { "body.text": "SELECT 1 FROM t" } }), "tidy");
    expect(r2.changes).toEqual({ "body.text": "select 1 from t" });
  });

  it("onEvent tidy: nothing to change gives only a message; unknown events throw", async () => {
    const { pages } = registry(plugin);
    const res = await pages.editor.onEvent(ctxOf(fakeHost(), noteOf("hello")), "tidy");
    expect(res.changes).toBeUndefined();
    expect(onlyKeys(res, EVENT_RESULT_KEYS)).toEqual([]);
    await expect(pages.editor.onEvent(ctxOf(fakeHost(), noteOf("")), "boom")).rejects.toThrow();
  });

  it("renderResultTab final: the text with :name replaced by the run's values", async () => {
    const { pages } = registry(plugin);
    const run = { id: "r", input: { "body.text": "where a = :a and b = :b" }, params: { a: "1" } };
    const view = await pages.editor.renderResultTab(ctxOf(fakeHost(), { run }), "final");
    expect(checkView(view)).toEqual([]);
    expect(view[0]).toMatchObject({ type: "text", text: "where a = 1 and b = :b", mono: true });
    await expect(pages.editor.renderResultTab(ctxOf(fakeHost(), { run }), "nope")).rejects.toThrow();
  });
});

describe("sample: run action", () => {
  const run = (host: Host, text: string, extra: Record<string, unknown> = {}) => {
    const { actions } = registry(plugin);
    const ctx = ctxOf(host, extra);
    return { ctx, done: actions.run(ctx, { "body.text": text }) };
  };

  it("success: table output of the declared shape, progress steps, sleeps, summary stored", async () => {
    const host = fakeHost();
    const { ctx, done } = run(host, "select :a", { params: { a: "1" } });
    const res = await done;
    expect(checkActionResult(res)).toEqual([]);
    expect(res.output.type).toBe("table");
    expect(res.output.columns.map((c: any) => c.key)).toEqual(["id", "customer", "amount", "status"]);
    expect(res.output.rows.length).toBeGreaterThan(0);
    expect(res.output.rows[0]).toHaveLength(4);
    expect(res.summary).toEqual({ rows: res.output.rows.length, message: `${res.output.rows.length} rows` });
    expect(ctx.progress.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(ctx.progress.mock.calls.map((c: any[]) => c[0])).toEqual([...ctx.progress.mock.calls.map((c: any[]) => c[0])].sort());
    expect(host.util.sleep).toHaveBeenCalled();
    expect(JSON.parse(host.storage.set.mock.calls[0]![1])).toEqual({ rows: res.output.rows.length, total: res.output.total });
  });

  it("is deterministic and the rowLimit setting caps the rows (total stays)", async () => {
    const a = await run(fakeHost(), "select :a", { params: { a: "1" } }).done;
    const b = await run(fakeHost(), "select :a", { params: { a: "1" } }).done;
    expect(b.output.rows).toEqual(a.output.rows);
    const capped = await run(fakeHost({ settings: { get: vi.fn(async () => "3") } }), "select :a", { params: { a: "1" } }).done;
    expect(capped.output.rows.length).toBe(Math.min(3, a.output.total));
    expect(capped.output.total).toBe(a.output.total);
    expect(checkActionResult(capped)).toEqual([]);
    const bad = await run(fakeHost({ settings: { get: vi.fn(async () => "abc") } }), "x").done;
    expect(bad.output.rows.length).toBeLessThanOrEqual(200);
  });

  it("!fail throws before doing anything", async () => {
    const host = fakeHost();
    await expect(run(host, "select 1 !fail").done).rejects.toThrow(/!fail/);
    expect(host.storage.set).not.toHaveBeenCalled();
  });

  it("explain: text output listing each parameter, its value and where it comes from", async () => {
    const { actions } = registry(plugin);
    const host = fakeHost({
      params: { get: vi.fn(async (n: string) => (n === "tenant_id" ? { found: true, value: "42", sourceName: "Prod" } : { found: false, value: "", sourceName: "" })) },
    });
    const res = await actions.explain(ctxOf(host, { params: { start_time: "2026-01-01T00:00" } }), { "body.text": "select :tenant_id, :start_time, :channel from t" });
    expect(checkActionResult(res)).toEqual([]);
    expect(res.output.type).toBe("text");
    expect(res.output.text.split("\n")).toEqual([
      "Parameters used by this text:",
      "tenant_id = 42 (from environment Prod)",
      "start_time = 2026-01-01T00:00 (entered here)",
      "channel (not set)",
    ]);
    const none = await actions.explain(ctxOf(fakeHost()), { "body.text": "select 1" });
    expect(none.output).toEqual({ type: "text", text: "This text uses no parameters." });
    const zh = await actions.explain(ctxOf(fakeHost(), { locale: "zh-CN" }), { "body.text": "select 1" });
    expect(zh.output.text).toBe("这段正文没有用到参数。");
  });

  it("!slow runs about twenty one-second steps and stops quickly when cancelled", async () => {
    const host = fakeHost();
    const { ctx, done } = run(host, "!slow");
    const res = await done;
    expect(checkActionResult(res)).toEqual([]);
    expect(host.util.sleep).toHaveBeenCalledTimes(20);
    expect(host.util.sleep).toHaveBeenCalledWith(1000);
    expect(ctx.progress).toHaveBeenCalledTimes(20);

    const host2 = fakeHost();
    let calls = 0;
    const { done: done2 } = run(host2, "!slow", { cancelled: () => ++calls > 3 });
    const res2 = await done2;
    expect(host2.util.sleep).toHaveBeenCalledTimes(3);
    expect(checkActionResult(res2)).toEqual([]);
  });

  it("a host error (denied after cancel, storage too big…) propagates with its code", async () => {
    const err = Object.assign(new Error("denied"), { code: "denied", params: { reason: "cancelled" } });
    const host = fakeHost({ util: { sleep: async () => { throw err; } } });
    await expect(run(host, "select 1").done).rejects.toMatchObject({ code: "denied" });
  });
});

describe("sample: package", () => {
  it("every text key the code uses exists in both locale files, and both files have the same keys", () => {
    const code = readFileSync(new URL("./main.js", import.meta.url), "utf8");
    const used = [...code.matchAll(/(?:ctx\.t|tr)\((?:ctx, )?"([^"]+)"/g)].map((m) => m[1]!);
    expect(used.length).toBeGreaterThan(10);
    for (const k of used) {
      expect(EN[k], `en-US ${k}`).toBeTypeOf("string");
      expect(ZH[k], `zh-CN ${k}`).toBeTypeOf("string");
    }
    expect(Object.keys(EN).sort()).toEqual(Object.keys(ZH).sort());
  });

  it("every key the manifest uses exists in the locale files", () => {
    const manifest = JSON.parse(readFileSync(new URL("./manifest.json", import.meta.url), "utf8"));
    const keys = [...JSON.stringify(manifest).matchAll(/"((?:plugin|kind|action|tab|setting)\.[A-Za-z.]+)"/g)].map((m) => m[1]!);
    for (const k of keys) expect(EN[k], k).toBeTypeOf("string");
  });
});
