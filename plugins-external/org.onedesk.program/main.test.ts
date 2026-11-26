import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
// @ts-ignore plain JS modules, no types
import plugin from "./main.js";
// @ts-ignore
import { assemble } from "./common.js";
// @ts-ignore
import { sandboxFiles } from "./runner.js";
import { checkView, registry } from "../../plugins/_testing/view-check";

const manifest = JSON.parse(readFileSync(new URL("./manifest.json", import.meta.url), "utf8"));
const locale = (f: string) => JSON.parse(readFileSync(new URL(`./locales/${f}.json`, import.meta.url), "utf8"));
const ZH = locale("zh-CN");
const EN = locale("en-US");
const t = (key: string) => ({ "en-US": EN[key] ?? key, "zh-CN": ZH[key] ?? key });
const P = "org.onedesk.program";
const k = (s: string) => `${P}:${s}`;
const fill = (s: string, vars: Record<string, string | number>) => Object.entries(vars).reduce((a, [n, v]) => a.split(`{${n}}`).join(String(v)), s);

const TMP = mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "od-program-test-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));
let runs = 0;

/**
 * What the kernel's empty sandbox (K21) does, in Node: the files written to a folder of their own, `./x` imports made to
 * point at the folder's root (as the sandbox resolves them), the entry's export called. Globals the harness sets are
 * put back afterwards.
 */
async function codeRun(o: { files: Record<string, string>; entry: string; call: string; input: unknown }) {
  const root = path.join(TMP, `run${++runs}`);
  const url = pathToFileURL(root).href;
  for (const [p, text] of Object.entries(o.files)) {
    mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
    writeFileSync(path.join(root, p), text.replace(/((?:from|import)\s*)(["'])\.\/([^"']+)\2/g, (_m, a, q, p2) => `${a}${q}${url}/${p2}${q}`));
  }
  const g = globalThis as any;
  const saved = ["test", "expect", "load", "fakeHost"].map((n) => [n, g[n]]);
  try {
    const m = await import(/* @vite-ignore */ `${url}/${o.entry}`);
    const value = JSON.parse(JSON.stringify(await m[o.call](o.input)));
    for (const x of value.tests || []) if (x.file) x.file = String(x.file).slice(String(x.file).indexOf(root) + root.length + 1);
    return { ok: true, value };
  } catch (e: any) {
    const at = /([A-Za-z0-9_./-]+\.js):(\d+)/.exec(String(e?.stack || ""));
    const file = at ? at[1].slice(at[1].indexOf(root) + root.length + 1) : undefined;
    return { ok: false, error: { message: String(e?.message || e), file, line: at ? Number(at[2]) : undefined } };
  } finally {
    for (const [n, v] of saved) g[n] = v;
  }
}

type Res = { id: string; kind: string; name: string; parentId: string | null; body: Record<string, any> };

const MANIFEST = JSON.stringify({ id: "org.example.convert", version: "0.1.0", apiVersion: "2", name: "plugin.name", icon: "ruler", main: "main.js", contributes: { locales: { "en-US": "locales/en-US.json", "zh-CN": "locales/zh-CN.json" } } }, null, 2);
const CONVERT = "export function convert(n, from, to) {\n  if (from === 'm' && to === 'cm') return n * 100;\n  return n;\n}\n";
const MAIN = "import { convert } from './lib/convert.js';\nexport default { activate(host) { host.pages.handle('conversion', { render: () => ({ view: [{ type: 'form', id: 'f', fields: [] }] }) }); } };\nexport const twice = (n) => convert(n, 'm', 'cm') * 2;\n";
const TESTS = "test('one metre is a hundred centimetres', () => {\n  const { convert } = load('lib/convert.js');\n  expect(convert(1, 'm', 'cm')).toBe(100);\n});\ntest('the page', async () => {\n  const plugin = load('main.js').default;\n  expect(load('locales/zh-CN.json').hello).toBe('你好');\n  expect(typeof plugin.activate).toBe('function');\n});\n";

/** A program book: manifest, two code pages, two languages, a test page, the build page. */
function world(over: Partial<Record<string, Record<string, any>>> = {}, extra: Res[] = []) {
  const res = new Map<string, Res>();
  const order: string[] = [];
  const add = (r: Res) => {
    res.set(r.id, r);
    order.push(r.id);
  };
  add({ id: "bk", kind: "org.onedesk.book:book", name: "单位换算", parentId: null, body: {} });
  add({ id: "man", kind: k("manifest"), name: "清单", parentId: "bk", body: { text: MANIFEST, ...over.man } });
  add({ id: "build", kind: k("build"), name: "构建", parentId: "bk", body: { out: "", notes: "第一版", history: [], devCount: 0, ...over.build } });
  add({ id: "main", kind: k("code"), name: "主文件", parentId: "bk", body: { path: "main.js", explain: "插件从这里开始。", code: MAIN, ...over.main } });
  add({ id: "conv", kind: k("code"), name: "换算", parentId: "bk", body: { path: "lib/convert.js", explain: "", code: CONVERT, ...over.conv } });
  add({ id: "zh", kind: k("locale"), name: "中文", parentId: "bk", body: { language: "zh-CN", texts: [{ key: "plugin.name", text: "单位换算" }, { key: "hello", text: "你好" }], ...over.zh } });
  add({ id: "en", kind: k("locale"), name: "English", parentId: "bk", body: { language: "en-US", texts: [{ key: "plugin.name", text: "Convert" }, { key: "hello", text: "Hello" }], ...over.en } });
  add({ id: "tst", kind: k("test"), name: "换算的测试", parentId: "bk", body: { explain: "", code: TESTS, ...over.tst } });
  for (const r of extra) add(r);
  const written = new Map<string, string>();
  const dirs: string[] = [];
  const installs: any[] = [];
  const builds: any[] = [];
  let identity = true;
  const desc = (p: string, depth: number, out: any[]) => {
    for (const id of order.filter((x) => res.get(x)?.parentId === p)) {
      const r = res.get(id)!;
      out.push({ id, name: r.name, kind: r.kind, depth });
      desc(id, depth + 1, out);
    }
    return out;
  };
  const host = {
    resources: {
      async get(id: string) {
        return res.get(id) ?? null;
      },
      async search(o: { ids: string[] }) {
        return o.ids.filter((id) => res.has(id)).map((id) => ({ id, kind: res.get(id)!.kind, name: res.get(id)!.name, parent: res.get(id)!.parentId }));
      },
      async tree(id: string) {
        return { nodes: desc(id, 1, []), next: null };
      },
      async update(id: string, changes: Record<string, any>) {
        const r = res.get(id)!;
        for (const [key, v] of Object.entries(changes)) r.body[key.slice(5)] = v;
        return { rev: 2 };
      },
    },
    interfaces: {
      async list() {
        return [{ plugin: "org.onedesk.book" }, { plugin: P }];
      },
      async call(_i: string, action: string, _input: unknown, o: { plugin: string }) {
        if (action === "roles" && o.plugin === "org.onedesk.book") return { data: { kinds: [{ kind: "book", role: "book" }] } };
        return { data: { kinds: [] } };
      },
    },
    plugins: {
      // The kernel's check (K20), as far as these tests need it: the main file there, languages with the same keys.
      async check(files: Record<string, string>) {
        const problems: any[] = [];
        let m: any;
        try {
          m = JSON.parse(files["manifest.json"]);
        } catch {
          return { ok: false, problems: [{ file: "manifest.json", field: "line 1", code: "badJson" }] };
        }
        if (!files[m.main]) problems.push({ file: m.main, field: "main", code: "mainMissing" });
        const keys = Object.values(m.contributes?.locales ?? {}).map((p: any) => (files[p] ? Object.keys(JSON.parse(files[p])) : []));
        const all = new Set(keys.flat());
        Object.values(m.contributes?.locales ?? {}).forEach((p: any, i) => all.forEach((key) => !keys[i].includes(key) && problems.push({ file: p, field: key, code: "missingKey" })));
        return { ok: problems.length === 0, id: m.id, version: m.version, problems };
      },
      async build(files: Record<string, string>, o: { path: string }) {
        if (!identity) throw Object.assign(new Error("invalid"), { params: { reason: "noIdentity" } });
        builds.push({ files, path: o.path });
        return { path: o.path, id: "org.example.convert", version: "0.1.0", bytes: 1234 };
      },
      async requestInstall(o: any) {
        installs.push(o);
        return { outcome: "installed", plugin: "org.example.convert" };
      },
    },
    code: { run: codeRun },
    files: {
      async roots() {
        return [{ path: "/out", name: "out" }];
      },
      async mkdir(p: string) {
        // As the kernel: a folder that is there already is a conflict.
        if (dirs.includes(p)) throw Object.assign(new Error("exists"), { code: "conflict" });
        dirs.push(p);
        return {};
      },
      async writeText(p: string, text: string) {
        written.set(p, text);
        return {};
      },
    },
  };
  const ctx = (id: string | null, extra2: Record<string, any> = {}) => ({ t, locale: "zh-CN", host, params: {}, resource: id ? res.get(id) : null, ...extra2 });
  return { res, ctx, written, dirs, installs, builds, noIdentity: () => (identity = false) };
}

describe("the manifest (D487 §37)", () => {
  it("five kinds playing roles in books; runs code, builds and asks to install; three languages", () => {
    expect(manifest.contributes.kinds.map((x: any) => x.id)).toEqual(["manifest", "code", "locale", "test", "build"]);
    expect(manifest.contributes.menus.new).toEqual(["manifest", "code", "locale", "test", "build"]);
    expect(manifest.requires).toEqual({ resources: true, files: true, code: true, plugins: { install: true } });
    expect(manifest.implements["onedesk.book/1"].actions).toEqual(["roles", "outline", "conventions"]);
    expect(manifest.contributes.aiTools.map((x: any) => x.name)).toEqual(["program_test"]);
    for (const f of ["en-US", "ja-JP"]) expect(Object.keys(locale(f)).sort(), f).toEqual(Object.keys(ZH).sort());
  });
  it("the kinds read in a book declare their embeds (the kernel refuses an undeclared one)", () => {
    const { kinds } = registry(plugin);
    const declared = manifest.contributes.kinds.filter((x: any) => x.embed).map((x: any) => x.id);
    expect(Object.keys(kinds).filter((id) => kinds[id].embed).sort()).toEqual(declared.sort());
  });
  it("roles: the manifest and build pages in front, code numbered in the body, languages and tests at the back", async () => {
    const r = await registry(plugin).actions.roles({}, {});
    expect(r.data.kinds.map((x: any) => `${x.kind}:${x.role}:${x.part}`)).toEqual(["manifest:manifest:front", "build:build:front", "code:body:body", "locale:locale:back", "test:tests:back"]);
  });
});

describe("the book's pages make up the plugin's files", () => {
  it("manifest, code by path, languages as JSON; test pages are not in the package", async () => {
    const w = world();
    const a = await assemble(w.ctx("man"), "bk");
    expect(Object.keys(a.files).sort()).toEqual(["lib/convert.js", "locales/en-US.json", "locales/zh-CN.json", "main.js", "manifest.json"]);
    expect(JSON.parse(a.files["locales/zh-CN.json"])).toEqual({ "plugin.name": "单位换算", hello: "你好" });
    expect(a.tests.map((x: any) => x.name)).toEqual(["换算的测试"]);
    expect(a.problems).toEqual([]);
  });
  it("two pages for one file, a bad name, a language page without its language: said, with the page", async () => {
    const w = world({ conv: { path: "main.js" } }, [
      { id: "x", kind: k("code"), name: "坏名字", parentId: "bk", body: { path: "../x.js", code: "" } },
      { id: "y", kind: k("locale"), name: "空的", parentId: "bk", body: { language: "", texts: [] } },
    ]);
    const a = await assemble(w.ctx("man"), "bk");
    expect(a.problems.map((p: any) => `${p.page}:${p.code}`)).toEqual(["换算:samePath", "坏名字:badPath", "空的:noLanguage"]);
    const v = await registry(plugin).pages.code.render(w.ctx("conv"));
    checkView(v.view);
    expect(v.view[0].text).toBe(fill(ZH["code.samePath"], { path: "main.js" }));
  });
});

describe("the pages", () => {
  it("manifest page: JSON with colours, and what the kernel's check says of the whole book", async () => {
    const w = world();
    const { pages } = registry(plugin);
    let v = await pages.manifest.render(w.ctx("man"));
    checkView(v.view);
    expect(v.view[0].fields[0]).toMatchObject({ kind: "code", language: "json", bind: "body.text" });
    expect(v.view[1].text).toBe(ZH["check.ok"]);
    // As typed (not saved): a main file the book does not have.
    v = await pages.manifest.render(w.ctx("man", { draft: { "body.text": MANIFEST.replace('"main.js"', '"app.js"') } }));
    expect(v.view[1].tone).toBe("danger");
    expect(v.view[1].text).toContain(`app.js · main: ${ZH["problem.mainMissing"]}`);
    v = await pages.manifest.render(w.ctx("man", { draft: { "body.text": "{" } }));
    expect(v.view[1].text).toContain(ZH["manifest.badJson"].split("{")[0]);
  });
  it("code page: explanation then code (javascript); in the book the explanation comes first, then the file", async () => {
    const w = world();
    const { pages, kinds } = registry(plugin);
    const v = await pages.code.render(w.ctx("main"));
    expect(v.view[0].fields.map((f: any) => `${f.name}:${f.kind}`)).toEqual(["path:text", "explain:longtext", "code:code"]);
    expect(v.view[0].fields[2].language).toBe("javascript");
    const e = await kinds.code.embed(w.ctx("main"));
    expect(e.view[0].text).toBe("插件从这里开始。\n\n**main.js**\n\n```javascript\n" + MAIN.trimEnd() + "\n```");
  });
  it("language page: the keys other languages have and this one has not", async () => {
    const w = world({ en: { texts: [{ key: "plugin.name", text: "Convert" }] } });
    const v = await registry(plugin).pages.locale.render(w.ctx("en"));
    checkView(v.view);
    expect(v.view[1].text).toBe(fill(ZH["locale.missing"], { keys: "hello" }));
    const ok = await registry(plugin).pages.locale.render(w.ctx("zh"));
    expect(ok.view[1].text).toBe(fill(ZH["locale.complete"], { n: 2 }));
  });
});

describe("tests run in the empty sandbox", () => {
  it("the files the sandbox gets: the book's code, the harness, each test page as a module; the entry imports them all", () => {
    const s = sandboxFiles({ "main.js": "x", "manifest.json": "{}", "locales/a.json": '{"k":"v"}' }, [{ name: "t", code: "test('a', () => {});" }]);
    expect(Object.keys(s.files).sort()).toEqual(["__entry.js", "__harness.js", "main.js", "tests/t0.js"]);
    expect(s.files["tests/t0.js"].split("\n")).toHaveLength(1);
    expect(s.files["__entry.js"]).toContain('const JSONS = {"manifest.json":{},"locales/a.json":{"k":"v"}};');
  });
  it("passing and failing tests: what was expected, what came instead, where", async () => {
    const w = world({ conv: { code: CONVERT.replace("n * 100", "n * 10") } });
    const r = await registry(plugin).actions.test(w.ctx("tst"), {});
    expect(r.output.type).toBe("table");
    expect(r.output.rows.map((x: string[]) => x[0])).toEqual(["one metre is a hundred centimetres", "the page"]);
    expect(r.output.rows[0][1]).toBe(`${ZH["test.fail"]} (换算的测试:3)`);
    expect(r.output.rows[0].slice(2, 4)).toEqual(["100", "10"]);
    expect(r.output.rows[1][1]).toBe(ZH["test.pass"]);
    expect(r.summary.message).toBe(fill(ZH["test.someFailed"], { failed: 1, total: 2 }));
    // Fixed: all pass.
    const ok = await registry(plugin).actions.test(world().ctx("tst"), {});
    expect(ok.summary.message).toBe(fill(ZH["test.allPassed"], { total: 2 }));
  });
  it("an error in a test: its message; a file that does not load: which page", async () => {
    const w = world({ tst: { code: "test('boom', () => { throw new Error('nope'); });\ntest('throws', () => { expect(() => { throw new Error('bad unit'); }).toThrow('unit'); expect(1).not.toBe(2); });" } });
    const r = await registry(plugin).actions.test(w.ctx("tst"), {});
    expect(r.output.rows[0][1]).toBe(`${ZH["test.fail"]}: nope (换算的测试:1)`);
    expect(r.output.rows[1][1]).toBe(ZH["test.pass"]);
    const broken = world({ conv: { code: "export function convert( {" } });
    const b = await registry(plugin).actions.test(broken.ctx("tst"), {});
    expect(b.failed.message).toContain(ZH["test.loadFailed"].split("（")[0]);
  });
  it("fakeHost: resources and storage in memory; the network, files and programs refused", async () => {
    const code = [
      "test('host', async () => {",
      "  const host = fakeHost({ resources: [{ id: 'a', kind: 'org.example.convert:conversion', name: 'A', body: { n: 1 } }] });",
      "  await host.resources.update('a', { 'body.n': 2 });",
      "  expect((await host.resources.get('a')).body).toEqual({ n: 2 });",
      "  expect((await host.resources.list({ kind: 'conversion' })).length).toBe(1);",
      "  await host.storage.set('k', [1]);",
      "  expect(await host.storage.get('k')).toEqual([1]);",
      "  let refused = '';",
      "  try { await host.network.request({ url: 'https://example.com' }); } catch (e) { refused = e.message; }",
      "  expect(refused).toContain('not available');",
      "});",
    ].join("\n");
    const r = await registry(plugin).actions.test(world({ tst: { code } }).ctx("tst"), {});
    expect(r.output.rows).toEqual([["host", ZH["test.pass"], "", "", expect.any(String)]]);
  });
  it("program_test: an AI runs all the book's tests (read-only) and reads each result", async () => {
    const w = world({ conv: { code: CONVERT.replace("n * 100", "n * 10") } });
    const r = await registry(plugin).actions.aiTest(w.ctx(null), { book: "main" });
    const data = JSON.parse(r.output.text);
    expect(data).toMatchObject({ loaded: true, passed: 1, failed: 1 });
    expect(data.tests[0]).toMatchObject({ page: "换算的测试", name: "one metre is a hundred centimetres", ok: false, expected: "100", actual: "10", line: 3 });
    await expect(registry(plugin).actions.aiTest(w.ctx(null), { book: "nowhere" })).rejects.toThrow(ZH["ai.notABook"]);
  });
});

describe("the build page", () => {
  it("shows the plugin, the check and the history", async () => {
    const w = world({ build: { history: [{ version: "0.0.9", date: "2026-11-01", notes: "试", file: "/out/a.odplugin" }] } });
    const v = await registry(plugin).pages.build.render(w.ctx("build"));
    checkView(v.view);
    expect(v.view[0].text).toBe(fill(ZH["build.head"], { id: "org.example.convert", version: "0.1.0", files: 5 }));
    expect(v.view.find((n: any) => n.id === "check").text).toBe(ZH["check.ok"]);
    expect(v.view.find((n: any) => n.id === "history").rows).toEqual([["0.0.9", "2026-11-01", "试", "/out/a.odplugin"]]);
  });
  it("try it out: the files in a dev version's folder, then the install request naming the book", async () => {
    const w = world();
    const r = await registry(plugin).actions.try(w.ctx("build"), {});
    expect(r.output.text).toBe(fill(ZH["build.installed"], { id: "org.example.convert", version: "0.1.0-dev.1" }));
    const folder = "/out/org.example.convert-0.1.0-dev.1";
    expect([...w.written.keys()].sort()).toEqual(["lib/convert.js", "locales/en-US.json", "locales/zh-CN.json", "main.js", "manifest.json"].map((p) => `${folder}/${p}`));
    expect(JSON.parse(w.written.get(`${folder}/manifest.json`)!).version).toBe("0.1.0-dev.1");
    expect(w.installs).toEqual([{ folder, source: fill(ZH["build.source"], { book: "单位换算" }) }]);
    expect(w.res.get("build")!.body.devCount).toBe(1);
    await registry(plugin).actions.try(w.ctx("build"), {});
    expect(w.installs[1].folder).toBe("/out/org.example.convert-0.1.0-dev.2");
  });
  it("build: the signed package, recorded; one build per version; not without an identity; not with problems", async () => {
    const w = world();
    const r = await registry(plugin).actions.build(w.ctx("build"), {});
    expect(r.output.text).toBe(fill(ZH["build.done"], { path: "/out/org.example.convert-0.1.0.odplugin", bytes: 1234 }));
    expect(Object.keys(w.builds[0].files)).not.toContain("tests/t0.js");
    expect(w.res.get("build")!.body.history).toEqual([{ version: "0.1.0", date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), notes: "第一版", file: "/out/org.example.convert-0.1.0.odplugin" }]);
    expect(w.res.get("build")!.body.notes).toBe("");
    expect((await registry(plugin).actions.build(w.ctx("build"), {})).failed.message).toBe(fill(ZH["build.sameVersion"], { version: "0.1.0" }));
    const n = world();
    n.noIdentity();
    expect((await registry(plugin).actions.build(n.ctx("build"), {})).failed.message).toBe(ZH["build.noIdentity"]);
    const bad = world({ man: { text: MANIFEST.replace('"main.js"', '"app.js"') } });
    expect((await registry(plugin).actions.build(bad.ctx("build"), {})).failed.message).toBe(fill(ZH["check.problems"], { n: 1 }));
  });
  it("conventions: what the manifest page says of the program book", async () => {
    const r = await registry(plugin).actions.conventions(world().ctx("man"), {});
    expect(r.data.lines[0]).toBe(fill(ZH["conv.plugin"], { id: "org.example.convert", version: "0.1.0" }));
    expect(r.data.lines).toHaveLength(4);
  });
});
