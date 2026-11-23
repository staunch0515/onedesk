import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
// @ts-ignore plain JS module, no types
import plugin, { BATCH, csv, queryOf } from "./main.js";
import { RENDER_KEYS, TREE_NODE_KEYS, checkView, onlyKeys, registry } from "../../plugins/_testing/view-check";

const load = (f: string) => JSON.parse(readFileSync(new URL(`./locales/${f}.json`, import.meta.url), "utf8")) as Record<string, string>;
const EN = load("en-US");
const ZH = load("zh-CN");
const JA = load("ja-JP");
const t = (key: string) => ({ "en-US": EN[key], "zh-CN": ZH[key], "ja-JP": JA[key] });

const info = (id: string) => ({ id, name: `Name ${id}`, kind: "org.onedesk.note:note", icon: "file-text", tree: "resources", tags: [], deleted: false });
type Host = Record<string, any>;
const hostOf = (search: (q: any) => unknown): Host => ({ resources: { search: vi.fn(async (q: any) => search(q)) } });
const body = (b: Record<string, string>) => ({ id: "col1", body: b });
const ctxOf = (host: Host, b: Record<string, string>, extra: Record<string, unknown> = {}) => ({ locale: "en-US", host, t, resource: body(b), ...extra });

describe("collection: helpers", () => {
  it("csv trims, drops empties and duplicates", () => {
    expect(csv(" a, b ,,a,c ")).toEqual(["a", "b", "c"]);
    expect(csv(undefined)).toEqual([]);
  });
  it("queryOf is null without conditions, otherwise only the given conditions", () => {
    expect(queryOf({ kinds: "", tags: " , ", text: "  " }, 0)).toBeNull();
    expect(queryOf({ kinds: "a:b, c:d", tags: "x", text: " hi " }, 5)).toEqual({ kinds: ["a:b", "c:d"], tags: ["x"], text: "hi", limit: BATCH, offset: 5 });
    expect(queryOf({ text: "q" }, undefined)).toEqual({ text: "q", limit: 200, offset: 0 });
  });
});

describe("collection: children", () => {
  const children = (host: Host, b: Record<string, string>, node: string | null = null, offset = 0) => registry(plugin).kinds.collection.children(ctxOf(host, b), node, offset);

  it("no conditions: no search, no nodes", async () => {
    const host = hostOf(() => ({ items: [], total: 0 }));
    expect(await children(host, { kinds: "", tags: "", text: "" })).toEqual({ nodes: [] });
    expect(host.resources.search).not.toHaveBeenCalled();
  });
  it("one node per hit with target, icon and name; the collection itself is left out", async () => {
    const host = hostOf(() => ({ items: [info("a"), info("col1"), info("b")], total: 3 }));
    const out = await children(host, { kinds: "", tags: "todo", text: "" });
    expect(out.nodes).toEqual([
      { key: "hit-a", label: "Name a", icon: "file-text", expandable: false, target: "resource:a" },
      { key: "hit-b", label: "Name b", icon: "file-text", expandable: false, target: "resource:b" },
    ]);
    for (const n of out.nodes) expect(onlyKeys(n, TREE_NODE_KEYS)).toEqual([]);
    expect(host.resources.search).toHaveBeenCalledWith({ tags: ["todo"], limit: 200, offset: 0 });
    expect(out.next).toBeUndefined();
  });
  it("continues with the search's next in batches of 200 (offset is a position)", async () => {
    const all = Array.from({ length: 450 }, (_, i) => info(`i${i}`));
    const host = hostOf((q) => {
      const items = all.slice(q.offset, q.offset + q.limit);
      return q.offset + items.length < all.length ? { items, total: 450, next: q.offset + items.length } : { items, total: 450 };
    });
    const a = await children(host, { text: "x" });
    expect([a.nodes.length, a.next]).toEqual([200, 200]);
    const b = await children(host, { text: "x" }, null, 200);
    expect([b.nodes.length, b.next]).toEqual([200, 400]);
    const c = await children(host, { text: "x" }, null, 400);
    expect([c.nodes.length, c.next]).toEqual([50, undefined]);
  });
  it("an expanded plugin node gives nothing; a search error propagates (the shell shows the failed-to-load node)", async () => {
    expect(await children(hostOf(() => ({ items: [], total: 0 })), { text: "x" }, "hit-a")).toEqual({ nodes: [] });
    const bad = { resources: { search: vi.fn(async () => { throw new Error("boom"); }) } };
    await expect(children(bad, { text: "x" })).rejects.toThrow("boom");
  });
});

describe("collection: page", () => {
  const { pages } = registry(plugin);
  it("without conditions: the three bound fields and a hint, no search", async () => {
    const host = hostOf(() => ({ items: [], total: 0 }));
    const out = await pages.editor.render(ctxOf(host, {}));
    expect(checkView(out.view)).toEqual([]);
    expect(onlyKeys(out, RENDER_KEYS)).toEqual([]);
    expect(out.view[0].fields.map((f: any) => [f.name, f.bind, f.kind])).toEqual([["kinds", "body.kinds", "text"], ["tags", "body.tags", "text"], ["text", "body.text", "text"]]);
    expect(out.view[1]).toEqual({ type: "text", id: "hint", text: "Fill in at least one condition.", tone: "muted" });
    expect(host.resources.search).not.toHaveBeenCalled();
  });
  it("with conditions: the total and a results table whose rows open the resource", async () => {
    const host = hostOf(() => ({ items: [info("a"), info("b")], total: 2 }));
    const out = await pages.editor.render(ctxOf(host, { text: "plan" }));
    expect(checkView(out.view)).toEqual([]);
    expect(out.view[1].text).toBe("2 result(s)");
    expect(out.view[2].rows).toEqual([["Name a", "org.onedesk.note:note"], ["Name b", "org.onedesk.note:note"]]);
    expect(out.view[2].columns.map((c: any) => c.key)).toEqual(["name", "kind"]);
    expect(out.view[2].rowTargets).toEqual(["resource:a", "resource:b"]);
  });
  it("kindLabel is a Label: shown as text in the locale, else English, else the kind name — never an object", async () => {
    const mk = (kindLabel: unknown) => ({ ...info("a"), kindLabel });
    const host = hostOf((q) => (q.ids ? { items: [], total: 0 } : { items: [mk({ "en-US": "Note", "zh-CN": "笔记" }), mk({ "ja-JP": "メモ" })], total: 2 }));
    const zh = await pages.editor.render(ctxOf(host, { text: "x" }, { locale: "zh-CN" }));
    expect(zh.view[2].rows.map((r: string[]) => r[1])).toEqual(["笔记", "org.onedesk.note:note"]);
    const de = await pages.editor.render(ctxOf(host, { text: "x" }, { locale: "de-DE" }));
    expect(de.view[2].rows[0][1]).toBe("Note");
    for (const row of [...zh.view[2].rows, ...de.view[2].rows]) for (const cell of row) expect(typeof cell).toBe("string");
  });
  it("more results than shown say so; zero results show only the total", async () => {
    const many = hostOf(() => ({ items: Array.from({ length: 200 }, (_, i) => info(`i${i}`)), total: 731, next: 200 }));
    expect((await pages.editor.render(ctxOf(many, { text: "x" }))).view[1].text).toBe("731 result(s), showing the first 200");
    const none = await pages.editor.render(ctxOf(hostOf(() => ({ items: [], total: 0 })), { text: "x" }));
    expect(none.view.map((n: any) => n.id)).toEqual(["conditions", "total"]);
  });
  it("the collection itself is not a result and not in the total, even when it is past the shown batch", async () => {
    const host = hostOf((q) => (q.ids ? { items: [info("col1")], total: 1 } : { items: [info("a"), info("col1")], total: 2 }));
    const out = await pages.editor.render(ctxOf(host, { text: "x" }));
    expect(out.view[1].text).toBe("1 result(s)");
    expect(out.view[2].rows).toHaveLength(1);
    expect(host.resources.search).toHaveBeenCalledWith({ text: "x", ids: ["col1"], limit: 1, offset: 0 });
    const far = hostOf((q) => (q.ids ? { items: [info("col1")], total: 1 } : { items: Array.from({ length: 200 }, (_, i) => info(`i${i}`)), total: 501, next: 200 }));
    expect((await pages.editor.render(ctxOf(far, { text: "x" }))).view[1].text).toBe("500 result(s), showing the first 200");
    const notMatching = hostOf((q) => (q.ids ? { items: [], total: 0 } : { items: [info("a")], total: 1 }));
    expect((await pages.editor.render(ctxOf(notMatching, { text: "x" }))).view[1].text).toBe("1 result(s)");
  });
  it("searches with the unsaved draft, and a run page is read only", async () => {
    const host = hostOf(() => ({ items: [], total: 0 }));
    await pages.editor.render(ctxOf(host, { text: "old" }, { draft: { "body.text": "new" } }));
    expect(host.resources.search).toHaveBeenCalledWith({ text: "new", limit: 200, offset: 0 });
    const out = await pages.editor.render(ctxOf(hostOf(() => ({ items: [], total: 0 })), {}, { run: { id: "r" } }));
    for (const f of out.view[0].fields) expect(f.readOnly).toBe(true);
  });
});

describe("collection: package", () => {
  const m = JSON.parse(readFileSync(new URL("./manifest.json", import.meta.url), "utf8"));
  it("registers what the manifest declares", () => {
    const r = registry(plugin);
    expect(Object.keys(r.kinds)).toEqual(["collection"]);
    expect(Object.keys(r.pages)).toEqual(["editor"]);
  });
  it("a self-supplying resource kind with three text fields; resources are required; nothing is droppable", () => {
    expect(m.requires.resources).toBe(true);
    const k = m.contributes.kinds[0];
    expect(k).toMatchObject({ id: "collection", tree: "resources", children: true, accepts: [] });
    expect(k.drop).toBeUndefined();
    expect(Object.keys(k.fields)).toEqual(["kinds", "tags", "text"]);
  });
  it("every text key used exists in en, zh and ja with the same key set", () => {
    const code = readFileSync(new URL("./main.js", import.meta.url), "utf8");
    const used = [...code.matchAll(/(?:ctx\.t|tr)\((?:ctx, )?"([^"]+)"/g)].map((x) => x[1]!);
    const manifest = readFileSync(new URL("./manifest.json", import.meta.url), "utf8");
    const mkeys = [...manifest.matchAll(/"((?:plugin|kind|action)\.[A-Za-z.]+)"/g)].map((x) => x[1]!);
    for (const k of [...used, ...mkeys, "field.kinds", "field.tags", "field.text", "field.kinds.placeholder", "field.tags.placeholder", "field.text.placeholder", "page.total", "page.total.partial"]) for (const L of [EN, ZH, JA]) expect(L[k], k).toBeTypeOf("string");
    expect(Object.keys(ZH).sort()).toEqual(Object.keys(EN).sort());
    expect(Object.keys(JA).sort()).toEqual(Object.keys(EN).sort());
  });
});
