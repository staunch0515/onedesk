import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-ignore plain JS modules, no types
import plugin from "./main.js";
// @ts-ignore
import { check, holds, lookupIn, parseLine } from "./compare.js";
// @ts-ignore
import { reportOf } from "./log.js";
import { checkView, registry } from "../../plugins/_testing/view-check";

const manifest = JSON.parse(readFileSync(new URL("./manifest.json", import.meta.url), "utf8"));
const locale = (f: string) => JSON.parse(readFileSync(new URL(`./locales/${f}.json`, import.meta.url), "utf8"));
const ZH = locale("zh-CN");
const EN = locale("en-US");
const t = (key: string) => ({ "en-US": EN[key] ?? key, "zh-CN": ZH[key] ?? key });
const R = "org.onedesk.runbook";
const k = (s: string) => `${R}:${s}`;

type Res = { id: string; kind: string; name: string; parentId: string | null; body: Record<string, any> };

/**
 * A book with a flow and steps; `runs` answers `host.runs.call` by target id (a function of the params, or a fixed
 * answer); `env` the environment.
 */
function world(steps: Array<[string, string, Record<string, any>]>, runs: Record<string, any>, env: Record<string, string> = {}) {
  const res = new Map<string, Res>();
  const order: string[] = [];
  const add = (r: Res) => {
    res.set(r.id, r);
    order.push(r.id);
  };
  add({ id: "bk", kind: "org.onedesk.book:book", name: "Release", parentId: null, body: {} });
  add({ id: "fl", kind: k("flow"), name: "Flow", parentId: "bk", body: {} });
  for (const [id, name, body] of steps) add({ id, kind: k("step"), name, parentId: "bk", body });
  let next = 0;
  const storage = new Map<string, unknown>();
  const calls: any[] = [];
  const files = new Map<string, string>();
  const host = {
    params: { async get(n: string) { return n in env ? { found: true, value: env[n], sourceName: "Test" } : { found: false }; } },
    storage: { get: async (key: string) => storage.get(key) ?? null, set: async (key: string, v: unknown) => void storage.set(key, v) },
    interfaces: {
      async call(_i: string, action: string) {
        if (action !== "entries") throw new Error("no");
        const items = order.filter((x) => res.get(x)!.parentId === "bk" && res.get(x)!.kind === k("step")).map((x, i) => ({ key: x, title: `${i + 1} ${res.get(x)!.name}`, level: 1, resource: x }));
        return { data: { items } };
      },
    },
    runs: {
      async call(id: string, o: { params: Record<string, string> }) {
        calls.push([id, o.params]);
        const r = runs[id];
        return typeof r === "function" ? r(o.params) : r;
      },
    },
    files: {
      async roots() { return [{ path: "/out" }]; },
      async stat(p: string) { if (!files.has(p)) throw new Error("nf"); return {}; },
      async writeText(p: string, text: string) { files.set(p, text); },
    },
    resources: {
      async get(id: string) { return res.has(id) ? structuredClone(res.get(id)) : null; },
      async search(o: { ids: string[] }) { return o.ids.map((id) => res.get(id)).filter(Boolean).map((r) => ({ id: r!.id, name: r!.name, kind: r!.kind, parent: r!.parentId })); },
      async list(o: { kind: string }) { return order.map((id) => res.get(id)!).filter((r) => r.kind === k(o.kind)).map((r) => structuredClone(r)); },
      async tree(id: string) { return { nodes: order.filter((x) => res.get(x)!.parentId === id).map((x) => ({ id: x, kind: res.get(x)!.kind, name: res.get(x)!.name, depth: 1 })), next: null }; },
      async create(o: { kind: string; name?: string; body?: any; parent?: string }) {
        const id = `n${++next}`;
        add({ id, kind: k(o.kind), name: o.name ?? o.kind, parentId: o.parent ?? null, body: structuredClone(o.body ?? {}) });
        return structuredClone(res.get(id));
      },
      async update(id: string, changes: Record<string, any>) {
        const r = res.get(id)!;
        for (const [key, v] of Object.entries(changes)) r.body[key.slice(5)] = structuredClone(v);
        return { rev: 2 };
      },
    },
  };
  const ctx = (id: string | null, extra: Record<string, any> = {}) => ({ t, locale: "zh-CN", host, params: {}, envId: "env1", resource: id ? structuredClone(res.get(id)) : null, ...extra });
  const log = () => [...res.values()].filter((r) => r.kind === k("log")).at(-1)!;
  return { res, ctx, calls, log, files, storage };
}

describe("comparing (D487 §25.3)", () => {
  it("reads a line: operators, quotes, {{…}} with its own =; empty and not empty", () => {
    expect(parseLine("@健康检查.状态码 = 200")).toEqual({ left: "@健康检查.状态码", op: "eq", right: "200" });
    expect(parseLine("{{环境}} ≠ 生产")).toEqual({ left: "{{环境}}", op: "ne", right: "生产" });
    expect(parseLine("@a >= 3")).toMatchObject({ op: "ge" });
    expect(parseLine("@a.body contains ok")).toMatchObject({ op: "has", right: "ok" });
    expect(parseLine("@a 不为空")).toEqual({ left: "@a", op: "full" });
    expect(parseLine("@a.output 为空")).toEqual({ left: "@a.output", op: "empty" });
    expect(parseLine("\"a=b\" = x")).toMatchObject({ left: "\"a=b\"", op: "eq" });
    expect(parseLine("nothing here").error).toBe("noOperator");
  });

  it("numbers as numbers, else words; contains; empty", () => {
    expect(holds("eq", "200", 200)).toBe(true);
    expect(holds("gt", "10", "9")).toBe(true);
    expect(holds("gt", "b", "a")).toBe(true);
    expect(holds("has", "{\"ok\":true}", "ok")).toBe(true);
    expect(holds("empty", "  ", undefined)).toBe(true);
    expect(holds("full", 0, undefined)).toBe(true);
  });

  it("values: data first, then the table's first row; deeper keys; a step's text", async () => {
    const look = lookupIn({ 查版本: { text: "2.3.1", first: { version: "2.3.1" }, data: { 行数: 1 } }, 健康: { text: "ok", data: { status: 200, json: { a: { b: 5 } } } } });
    expect(look("查版本.version")).toBe("2.3.1");
    expect(look("查版本.行数")).toBe(1);
    expect(look("健康.json.a.b")).toBe(5);
    expect(look("健康")).toBe("ok");
    expect(look("没有.x")).toBeUndefined();
    const r = await check("@健康.status = 200\n@查版本.version = {{新版本}}", look, async (n: string) => (n === "新版本" ? "2.3.2" : null));
    expect(r.map((x: any) => x.ok)).toEqual([true, false]);
    expect(r[1]).toMatchObject({ left: "2.3.1", right: "2.3.2" });
  });
});

describe("carrying out a flow (D487 §25.4)", () => {
  function release(version: () => string) {
    return world(
      [
        ["s1", "查版本", { target: "q1" }],
        ["s2", "健康检查", { target: "h1", inputs: "host = {{host}}\nv = @查版本.version", expect: "@健康检查.status = 200" }],
        ["s3", "确认", { confirm: "看一下版本再继续" }],
        ["s4", "发布", { target: "c1", when: "{{环境}} = 生产" }],
        ["s5", "再查版本", { target: "q1", expect: "@再查版本.version = 2.3.2" }],
      ],
      {
        q1: () => ({ status: "ok", output: { type: "table", columns: [{ key: "version", label: "版本" }], rows: [[version()]] }, data: { rows: 1 }, ms: 3 }),
        h1: (p: any) => ({ status: "ok", output: { type: "text", text: `ok ${p.host} ${p.v}` }, data: { status: 200 }, ms: 2 }),
        c1: () => ({ status: "ok", output: { type: "text", text: "deployed" }, data: { exitCode: 0 }, ms: 9 }),
      },
      { host: "test.local", 环境: "测试", 运行人: "张三" },
    );
  }

  it("in order; values passed down; stops to be confirmed; skips by its condition; stops on a failure; continues", async () => {
    let v = "2.3.1";
    const w = release(() => v);
    const { actions, pages } = registry(plugin);
    const first = await actions.run(w.ctx("fl", { params: { operator: "张三" } }), {});
    expect(JSON.stringify(first.output)).toContain("看一下版本再继续");
    expect(w.calls).toEqual([["q1", {}], ["h1", { host: "test.local", v: "2.3.1" }]]);
    const log = w.log();
    expect(log.body).toMatchObject({ status: "waiting", next: 2, operator: "张三", number: 1 });
    expect(log.body.steps.s2.expect[0]).toMatchObject({ ok: true });
    expect(log.body.steps.s2.inputs).toEqual({ host: "test.local", v: "2.3.1" });
    // The contents shows each step's state.
    const view = (await pages.flow.render(w.ctx("fl"))).view;
    expect(checkView(view)).toEqual([]);
    const seq = view.find((n: any) => n.type === "sequence");
    expect(seq.items.map((x: any) => x.title)).toEqual(["✓ 1 查版本", "✓ 2 健康检查", "⏸ 3 确认", "· 4 发布", "· 5 再查版本"]);
    // Continue: confirmed; the deploy is skipped (not production); the version check fails.
    const second = await actions.continue(w.ctx("fl", { params: { operator: "李四" } }), {});
    expect(second.failed).toBeTruthy();
    expect(w.log().body.steps.s3).toMatchObject({ state: "confirmed", confirmedBy: "李四" });
    expect(w.log().body.steps.s4.state).toBe("skipped");
    expect(w.log().body).toMatchObject({ status: "failed", next: 4 });
    // Fixed: continue runs the failed step again.
    v = "2.3.2";
    const third = await actions.continue(w.ctx("fl"), {});
    expect(third.failed).toBeUndefined();
    expect(w.log().body).toMatchObject({ status: "done", next: 5 });
    expect(JSON.stringify(await actions.continue(w.ctx("fl"), {}))).toContain("已经全部完成");
    // Start afresh: the next run is a new log.
    await pages.flow.onEvent(w.ctx("fl"), "fresh");
    await actions.run(w.ctx("fl"), {});
    expect(w.log().body.number).toBe(2);
  });

  it("a run that fails stops the flow; a secret given is not written into the log", async () => {
    const w = world(
      [
        ["s1", "登录", { target: "x", inputs: "token = {{secret:api}}" }],
        ["s2", "之后", { target: "y" }],
      ],
      { x: { status: "failed", error: "it failed", ms: 1 }, y: { status: "ok", output: { type: "text", text: "never" }, ms: 1 } },
    );
    const { actions } = registry(plugin);
    const out = await actions.run(w.ctx("fl"), {});
    expect(out.failed).toBeTruthy();
    expect(w.calls.map((c: any) => c[0])).toEqual(["x"]);
    expect(w.log().body.steps.s1).toMatchObject({ state: "failed", error: "it failed", inputs: { token: "{{secret:api}}" } });
  });

  it("a step page: its fields, the last result and the values later steps can use; run alone; the log reads and exports", async () => {
    const w = release(() => "2.3.1");
    const { actions, pages, kinds } = registry(plugin);
    await actions.run(w.ctx("fl"), {});
    const step = await pages.step.render(w.ctx("s2"));
    expect(checkView(step.view)).toEqual([]);
    expect(JSON.stringify(step.view)).toContain("@健康检查.status");
    expect(step.view.find((n: any) => n.id === "step").fields.find((f: any) => f.name === "target").kinds).toContain("org.onedesk.http:request");
    const embed = await kinds.step.embed(w.ctx("s3"), {});
    expect(JSON.stringify(embed.view)).toContain("⏸ 看一下版本再继续");
    // Run one step alone, into the current log.
    const one = await actions.runOne(w.ctx("s1"), {});
    expect(JSON.stringify(one.output)).toContain("完成");
    // The log: read only, a row per step; the report.
    const log = w.log();
    const page = await pages.log.render(w.ctx(log.id, { params: { "view.row": "s2" } }));
    expect(page.readOnly).toBe(true);
    expect(checkView(page.view)).toEqual([]);
    expect(page.view.find((n: any) => n.id === "steps").rows.length).toBe(3);
    expect(JSON.stringify(page.view)).toContain("host = test.local");
    await actions.export(w.ctx(log.id), {});
    const md = w.files.get(`/out/${log.name}.md`)!;
    expect(md).toContain("## ✓ 健康检查");
    expect(md).toContain("- ✓ @健康检查.status = 200");
    expect(reportOf({ t, locale: "zh-CN" }, log)).toContain("| version |");
  });

  it("roles in a book; the manifest; every key in every language", async () => {
    const { actions } = registry(plugin);
    const roles = (await actions.roles({}, {})).data.kinds;
    expect(roles.find((r: any) => r.kind === "flow")).toMatchObject({ role: "toc", single: true });
    expect(roles.find((r: any) => r.kind === "step")).toMatchObject({ part: "body" });
    expect(manifest.requires).toMatchObject({ runs: true, files: true });
    for (const f of ["en-US", "ja-JP"]) expect(Object.keys(locale(f)).sort(), f).toEqual(Object.keys(ZH).sort());
  });
});
