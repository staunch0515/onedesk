import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
// @ts-ignore plain JS module, no types
import plugin, { checkValue, pickSource, declarations, paramNames, renderSql, sqlLiteral, timePresets, tokenize, toSqlValue } from "./main.js";
import { RENDER_KEYS, checkActionResult, checkView, hostError, onlyKeys, registry } from "../_testing/view-check";

const load = (f: string) => JSON.parse(readFileSync(new URL(`./locales/${f}.json`, import.meta.url), "utf8")) as Record<string, string>;
const EN = load("en-US");
const ZH = load("zh-CN");
const JA = load("ja-JP");
const t = (key: string) => ({ "en-US": EN[key], "zh-CN": ZH[key], "ja-JP": JA[key] });

type Host = Record<string, any>;
const SOURCES = [
  { id: "s1", name: "Local" },
  { id: "s2", name: "Staging" },
];
const table = { type: "table", columns: [{ key: "c0", label: "n" }], rows: [["1"], ["2"]], total: 2 };

function fakeHost(over: Host = {}): Host {
  const store = new Map<string, string>();
  return {
    params: { get: vi.fn(async () => ({ found: false, value: "", sourceName: "" })), config: vi.fn(async () => ({ found: false, value: "", sourceName: "" })) },
    storage: { get: vi.fn(async (k: string) => store.get(k) ?? null), set: vi.fn(async (k: string, v: string) => void store.set(k, v)) },
    resources: { list: vi.fn(async () => SOURCES), create: vi.fn(async (r: any) => ({ id: "new1", name: r.name })) },
    actions: { call: vi.fn(async () => ({ output: table, summary: { message: "Ran in 5 ms" } })) },
    ui: { copy: vi.fn(async () => undefined) },
    ...over,
  };
}
const ctxOf = (host: Host, extra: Record<string, unknown> = {}) => ({ target: "resource:r1", locale: "en-US", host, t, params: {}, progress: vi.fn(), cancelled: () => false, ...extra });
const resourceOf = (body: Record<string, string>) => ({ resource: { id: "r1", body } });
const run = (host: Host, input: Record<string, string>, extra: Record<string, unknown> = {}) => registry(plugin).actions.run(ctxOf(host, { ...resourceOf({}), ...extra }), input);

describe("sql: parameters in the text", () => {
  it("finds :name outside strings, quoted names, dollar quotes, comments and ::casts, once each, in order", () => {
    const sql = `-- :ignored in a comment
SELECT ':no', ":no2", $$ :no3 $$, $t$ :no4 $t$, x::text, :from::text, :bucket
FROM t /* :no5 */ WHERE a = 'it''s :no6' AND b > :from AND c = :Other_1`;
    expect(paramNames(sql)).toEqual(["from", "bucket", "Other_1"]);
    expect(paramNames("SELECT 1")).toEqual([]);
    expect(paramNames(undefined as any)).toEqual([]);
    expect(paramNames("SELECT a::int, b ::text, :x")).toEqual(["x"]);
    expect(paramNames("select 12:30")).toEqual([]);
  });

  it("tokenize keeps the text exactly: joining raw pieces and :names gives the input back", () => {
    const sql = "SELECT :a, 'x :b', y::int -- :c\nFROM t WHERE z = :a";
    expect(tokenize(sql).map((x: any) => (x.param !== undefined ? `:${x.param}` : x.raw)).join("")).toBe(sql);
  });

  it("renders values as single-quoted literals (quotes doubled); empty, missing and null are NULL; comments and strings stay", () => {
    const sql = "SELECT :a, :b, CAST(:c AS int), 'keep :a', :d -- :a";
    expect(renderSql(sql, { a: "it's", b: "", c: null })).toBe("SELECT 'it''s', NULL, CAST(NULL AS int), 'keep :a', NULL -- :a");
    expect(sqlLiteral("a'b")).toBe("'a''b'");
    expect(() => sqlLiteral("a\0b")).toThrow();
  });

  it("reads PostgreSQL's lexical rules: E'' escapes, a $ inside a name, nested block comments", () => {
    expect(paramNames("SELECT E'\\' :a', :b")).toEqual(["b"]); // E'\'' keeps the string open
    expect(paramNames("SELECT 'a\\', :c")).toEqual(["c"]); // a plain string: the backslash is data
    expect(paramNames("SELECT a$b$ :d $$ :e $$")).toEqual(["d"]);
    expect(paramNames("SELECT /* x /* :f */ :g */ :h")).toEqual(["h"]);
  });

  it("a value cannot break out of its literal", () => {
    const evil = "x'; DROP TABLE t; --";
    expect(renderSql("SELECT :v", { v: evil })).toBe("SELECT 'x''; DROP TABLE t; --'");
  });

  it("reads @param declarations: type, required, max, values and a description", () => {
    const sql = `-- @param since type=datetime required -- from when
-- @param n type=number max=5
-- @param kind values=a|b|c
-- @param free
-- @param bad type=weird required nonsense
SELECT :since, :n, :kind, :free`;
    expect(declarations(sql)).toEqual({
      since: { type: "datetime", required: true, max: 0, values: [], description: "from when" },
      n: { type: "number", required: false, max: 5, values: [], description: "" },
      kind: { type: "enum", required: false, max: 0, values: ["a", "b", "c"], description: "" },
      free: { type: "text", required: false, max: 0, values: [], description: "" },
      bad: { type: "text", required: true, max: 0, values: [], description: "" },
    });
  });

  it("datetime values from the form are UTC", () => {
    const d = { type: "datetime" };
    expect(toSqlValue(d, "2026-01-02T03:04")).toBe("2026-01-02T03:04:00Z");
    expect(toSqlValue(d, "2026-01-02T03:04:05")).toBe("2026-01-02T03:04:05Z");
    expect(toSqlValue(d, "2026-01-02T03:04:05Z")).toBe("2026-01-02T03:04:05Z");
    expect(toSqlValue({ type: "text" }, "2026-01-02T03:04")).toBe("2026-01-02T03:04");
    expect(renderSql("SELECT :t", { t: "2026-01-02T03:04" }, declarations("-- @param t type=datetime\n"))).toBe("SELECT '2026-01-02T03:04:00Z'");
  });

  it("checks values against their declaration", () => {
    const decl = (o: Record<string, unknown>) => ({ type: "text", required: false, max: 0, values: [], description: "", ...o });
    expect(checkValue(decl({ required: true }), null)).toBe("required");
    expect(checkValue(decl({}), null)).toBeNull();
    expect(checkValue(decl({ type: "number" }), "12.5")).toBeNull();
    expect(checkValue(decl({ type: "number" }), "-1e3")).toBeNull();
    expect(checkValue(decl({ type: "number" }), "12 or 1=1")).toBe("number");
    expect(checkValue(decl({ type: "date" }), "2026-02-30")).toBeNull();
    expect(checkValue(decl({ type: "date" }), "02/03/2026")).toBe("date");
    expect(checkValue(decl({ type: "datetime" }), "2026-01-01T10:00")).toBeNull();
    expect(checkValue(decl({ type: "datetime" }), "yesterday")).toBe("datetime");
    expect(checkValue(decl({ type: "enum", values: ["a", "b"] }), "c")).toBe("enum");
    expect(checkValue(decl({ max: 3 }), "abcd")).toBe("max");
  });

  it("time presets are UTC and start with now", () => {
    const now = new Date(Date.UTC(2026, 10, 19, 14, 35, 12));
    const presets = timePresets(ctxOf(fakeHost()), now);
    expect(presets.map((p: any) => p.value)).toEqual(["2026-11-19T14:35", "2026-11-19T00:00", "2026-11-18T00:00", "2026-11-12T00:00", "2026-11-01T00:00"]);
    expect(presets[1].label).toEqual(t("preset.today"));
  });
});

describe("sql: page", () => {
  it("registers what the manifest declares", () => {
    const r = registry(plugin);
    expect(Object.keys(r.pages)).toEqual(["editor"]);
    expect(Object.keys(r.actions).sort()).toEqual(["newHere", "run"]);
  });

  it("render: data source picker (empty = environment/default), then the code editor; no strip without parameters", async () => {
    const { pages } = registry(plugin);
    const out = await pages.editor.render(ctxOf(fakeHost(), resourceOf({ sql: "SELECT 1", source: "s2" })));
    expect(checkView(out.view)).toEqual([]);
    expect(onlyKeys(out, RENDER_KEYS)).toEqual([]);
    expect(out.view.map((n: any) => n.id)).toEqual(["source", "editor"]);
    const pick = out.view[0].fields[0];
    expect(pick).toMatchObject({ kind: "ref", kinds: ["org.onedesk.datasource:source"], bind: "body.source" });
    expect(pick.options.map((o: any) => o.value)).toEqual(["", "s1", "s2"]);
    expect(out.view[1].fields[0]).toMatchObject({ kind: "code", bind: "body.sql", fill: true, language: "sql" });
  });

  it("render: a saved source that no longer exists stays visible in the picker", async () => {
    const { pages } = registry(plugin);
    const out = await pages.editor.render(ctxOf(fakeHost(), resourceOf({ sql: "", source: "gone" })));
    expect(out.view[0].fields[0].options.map((o: any) => o.value)).toEqual(["", "s1", "s2", "gone"]);
  });

  it("render: a parameter field per :name by declared type, with environment values, presets, options and hints; the unsaved draft counts", async () => {
    const { pages } = registry(plugin);
    const host = fakeHost({ params: { get: vi.fn(async (n: string) => (n === "limit_n" ? { found: true, value: "50", sourceName: "Prod" } : { found: false, value: "", sourceName: "" })) } });
    const sql = "-- @param since type=datetime required -- from when\n-- @param kind values=a|b\n-- @param day type=date\n-- @param at type=time\n-- @param code max=4\nSELECT :since, :kind, :day, :at, :code, :limit_n, :note";
    const out = await pages.editor.render(ctxOf(host, { ...resourceOf({ sql: "SELECT 1", source: "" }), draft: { "body.sql": sql } }));
    expect(checkView(out.view)).toEqual([]);
    const strip = out.view.find((n: any) => n.id === "params");
    const byName = Object.fromEntries(strip.fields.map((f: any) => [f.name, f]));
    expect(Object.keys(byName)).toEqual(["since", "kind", "day", "at", "code", "limit_n", "note"]);
    expect(byName.since).toMatchObject({ kind: "datetime", param: true, required: true, hint: "from when · UTC" });
    expect(byName.at).toMatchObject({ kind: "time" });
    expect(byName.code).toMatchObject({ kind: "text", maxLength: 4 });
    expect(byName.since.presets).toHaveLength(5);
    expect(byName.kind).toMatchObject({ kind: "enum", options: [{ value: "a", label: "a" }, { value: "b", label: "b" }] });
    expect(byName.day.kind).toBe("date");
    expect(byName.limit_n).toMatchObject({ kind: "text", envValue: "50", envSource: "Prod" });
    expect(byName.note).toEqual({ name: "note", label: "note", kind: "text", param: true });
  });

  it("render: a run page is read only and shows the run's parameter values", async () => {
    const { pages } = registry(plugin);
    const run = { id: "x", resourceId: "r1", input: { "body.sql": "SELECT :a", "body.source": "s1" }, params: { a: "7" } };
    const out = await pages.editor.render(ctxOf(fakeHost(), { run }));
    expect(checkView(out.view)).toEqual([]);
    for (const n of out.view) for (const f of n.fields) expect(f.readOnly).toBe(true);
    expect(out.view.find((n: any) => n.id === "params").fields[0]).toMatchObject({ envValue: "7", readOnly: true });
  });

  it("render: works when the data source list cannot be read", async () => {
    const { pages } = registry(plugin);
    const host = fakeHost({ resources: { list: vi.fn(async () => { throw hostError("denied"); }) } });
    const out = await pages.editor.render(ctxOf(host, resourceOf({ sql: "", source: "" })));
    expect(out.view[0].fields[0].options.map((o: any) => o.value)).toEqual([""]);
  });

  it("copy event copies the text on the page, unsaved changes included", async () => {
    const { pages } = registry(plugin);
    const host = fakeHost();
    const res = await pages.editor.onEvent(ctxOf(host, { ...resourceOf({ sql: "SELECT 1" }), draft: { "body.sql": "SELECT 2" } }), "copy");
    expect(host.ui.copy).toHaveBeenCalledWith("SELECT 2");
    expect(res).toEqual({ message: "SQL copied." });
    await expect(pages.editor.onEvent(ctxOf(host), "nope")).rejects.toThrow();
  });

  it("renderResultTab sent: the SQL that was sent, as code; a muted note without a run", async () => {
    const { pages } = registry(plugin);
    const host = fakeHost();
    const none = await pages.editor.renderResultTab(ctxOf(host, { run: { id: "r", resourceId: "r1" } }), "sent");
    expect(none).toEqual([{ type: "text", id: "none", text: "Nothing has been run yet.", tone: "muted" }]);
    await run(host, { "body.sql": "SELECT :a", "body.source": "s1" }, { params: { a: "x'y" }, runId: "run-9" });
    const view = await pages.editor.renderResultTab(ctxOf(host, { run: { id: "run-9", resourceId: "r1" } }), "sent");
    // another run of the same statement has its own text; so does a run of an unsaved statement
    const other = await pages.editor.renderResultTab(ctxOf(host, { run: { id: "run-10", resourceId: "r1" } }), "sent");
    expect(other[0].id).toBe("none");
    expect(checkView(view)).toEqual([]);
    expect(view[0]).toMatchObject({ type: "text", text: "SELECT 'x''y'", mono: true, language: "sql" });
    await expect(pages.editor.renderResultTab(ctxOf(host, {}), "nope")).rejects.toThrow();
  });
});

describe("sql: run action", () => {
  it("renders the parameters and calls the data source's query on the chosen data source; the output comes back unchanged", async () => {
    const host = fakeHost();
    const res = await run(host, { "body.sql": "SELECT * FROM t WHERE id = :id", "body.source": "s2" }, { params: { id: "42" } });
    expect(host.actions.call).toHaveBeenCalledWith("org.onedesk.datasource:query", { sql: "SELECT * FROM t WHERE id = '42'" }, { resource: "s2" });
    expect(checkActionResult(res)).toEqual([]);
    expect(res.output).toEqual(table);
    expect(res.summary).toEqual({ message: "Ran in 5 ms" });
  });

  it("a data file from the data source is the run's own output", async () => {
    const out = { type: "table", file: "tmp/call-1.csv", header: true };
    const host = fakeHost({ actions: { call: vi.fn(async () => ({ output: out, summary: { message: "Ran in 1 ms" } })) } });
    const res = await run(host, { "body.sql": "SELECT 1", "body.source": "s1" });
    expect(checkActionResult(res)).toEqual([]);
    expect(res.output).toEqual(out);
  });

  describe("which data source", () => {
    const cfg = (v: string) => ({ params: { get: vi.fn(async () => ({ found: false, value: "", sourceName: "" })), config: vi.fn(async () => ({ found: true, value: v, sourceName: "Workspace" })) } });
    it("the statement's own, then the environment's datasource, then the workspace default; a name works too", async () => {
      const own = fakeHost();
      expect(await pickSource(ctxOf(own), "s2")).toBe("s2");
      expect(own.params.get).not.toHaveBeenCalled();
      const env = fakeHost({ params: { get: vi.fn(async (n: string) => (n === "datasource" ? { found: true, value: "s2", sourceName: "Prod" } : { found: false })), config: vi.fn(async () => ({ found: true, value: "s1" })) } });
      expect(await pickSource(ctxOf(env), "")).toBe("s2");
      expect(env.params.config).not.toHaveBeenCalled();
      const def = fakeHost(cfg("Local"));
      expect(await pickSource(ctxOf(def), "")).toBe("s1");
      expect(def.params.config).toHaveBeenCalledWith("datasource.default");
    });
    it("says so when there is none or the named one is gone", async () => {
      await expect(pickSource(ctxOf(fakeHost()), "")).rejects.toThrow("No data source");
      await expect(pickSource(ctxOf(fakeHost()), "ghost")).rejects.toThrow("“ghost” was not found");
    });
    it("a stale reference says where it came from (environment or workspace default), not only the id", async () => {
      const env = fakeHost({ params: { get: vi.fn(async () => ({ found: true, value: "gone", sourceName: "Prod" })), config: vi.fn() } });
      await expect(pickSource(ctxOf(env), "")).rejects.toThrow("(from the environment) was not found");
      const def = fakeHost(cfg("gone2"));
      await expect(pickSource(ctxOf(def), "")).rejects.toThrow("“gone2” (the workspace default) was not found");
    });
  });

  it("a parameter not typed takes the environment's value; an empty one is NULL", async () => {
    const host = fakeHost({ params: { get: vi.fn(async (n: string) => (n === "a" ? { found: true, value: "env-a", sourceName: "Prod" } : { found: false, value: "", sourceName: "" })) } });
    await run(host, { "body.sql": "SELECT :a, :b, :c", "body.source": "s1" }, { params: { c: "typed" } });
    expect(host.actions.call.mock.calls[0]![1].sql).toBe("SELECT 'env-a', NULL, 'typed'");
  });

  it("a typed value wins over the environment's and the environment is not asked", async () => {
    const host = fakeHost();
    await run(host, { "body.sql": "SELECT :a", "body.source": "s1" }, { params: { a: "typed" } });
    expect(host.params.get).not.toHaveBeenCalled();
  });

  it("declared types are checked before anything is sent", async () => {
    const host = fakeHost();
    await expect(run(host, { "body.sql": "-- @param n type=number\nSELECT :n", "body.source": "s1" }, { params: { n: "1; DROP" } })).rejects.toThrow("must be a number");
    await expect(run(host, { "body.sql": "-- @param n required\nSELECT :n", "body.source": "s1" })).rejects.toThrow(":n is required");
    await expect(run(host, { "body.sql": "-- @param at type=time\nSELECT :at", "body.source": "s1" }, { params: { at: "noon" } })).rejects.toThrow("must be a time");
    await expect(run(host, { "body.sql": "-- @param k values=a|b\nSELECT :k", "body.source": "s1" }, { params: { k: "c" } })).rejects.toThrow("allowed values");
    await expect(run(host, { "body.sql": "-- @param k max=2\nSELECT :k", "body.source": "s1" }, { params: { k: "abc" } })).rejects.toThrow("longer than 2");
    await expect(run(host, { "body.sql": "   ", "body.source": "s1" })).rejects.toThrow("nothing to run");
    expect(host.actions.call).not.toHaveBeenCalled();
  });

  it("a failure of the data source (handed back as text) is the run's error with that text", async () => {
    const host = fakeHost({ actions: { call: vi.fn(async () => ({ error: 'ERROR: relation "x" does not exist' })) } });
    await expect(run(host, { "body.sql": "SELECT * FROM x", "body.source": "s1" })).rejects.toThrow('relation "x" does not exist');
  });

  it("a data source that returns no table is an error", async () => {
    const host = fakeHost({ actions: { call: vi.fn(async () => ({ output: { type: "none" } })) } });
    await expect(run(host, { "body.sql": "SELECT 1", "body.source": "s1" })).rejects.toThrow("no table");
  });

  it("reports progress and remembers the SQL it sent (per statement)", async () => {
    const host = fakeHost();
    const ctx = ctxOf(host, resourceOf({}));
    await registry(plugin).actions.run(ctx, { "body.sql": "SELECT 1", "body.source": "s1" });
    expect(ctx.progress).toHaveBeenCalledWith(undefined, "Running on the data source…");
    expect(host.storage.set).toHaveBeenCalledWith("lastSent:-", "SELECT 1");
  });

  it("newHere creates a statement on the data source and links to it", async () => {
    const { actions } = registry(plugin);
    const host = fakeHost();
    const res = await actions.newHere(ctxOf(host, { resource: { id: "s1", name: "Local" } }), {});
    expect(host.resources.create).toHaveBeenCalledWith({ kind: "query", name: "New SQL on Local", body: { sql: "", source: "s1" } });
    expect(checkActionResult(res)).toEqual([]);
    expect(res.output).toEqual({ type: "link", label: "New SQL on Local", target: "resource:new1" });
  });
});

describe("sql: manifest", () => {
  const m = JSON.parse(readFileSync(new URL("./manifest.json", import.meta.url), "utf8"));
  it("depends on the data source plugin and asks for no capability of its own", () => {
    expect(m.depends).toEqual([{ id: "org.onedesk.datasource", version: ">=0.1.0, <1.0.0" }]);
    expect(m.requires).toEqual({ files: false });
  });
  it("every action it handles is declared, and the run page ends with the sent SQL tab", () => {
    expect(m.contributes.actions.map((a: any) => a.id).sort()).toEqual(["newHere", "run"]);
    expect(m.contributes.pages[0].resultTabs.map((x: any) => x.id)).toEqual(["result", "sent", "history"]);
  });
});
