import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
// @ts-ignore plain JS module, no types
import plugin, { MAX_ITEMS, itemsOf, move } from "./main.js";
import { RENDER_KEYS, TREE_NODE_KEYS, checkView, onlyKeys, registry } from "../_testing/view-check";

const load = (f: string) => JSON.parse(readFileSync(new URL(`./locales/${f}.json`, import.meta.url), "utf8")) as Record<string, string>;
const EN = load("en-US");
const ZH = load("zh-CN");
const JA = load("ja-JP");
const t = (key: string) => ({ "en-US": EN[key], "zh-CN": ZH[key], "ja-JP": JA[key] });

const info = (id: string, over: Record<string, unknown> = {}) => ({ id, name: `Name ${id}`, kind: "org.onedesk.note:note", icon: "file-text", tree: "resources", tags: [], deleted: false, ...over });
type Host = Record<string, any>;
function fakeHost(existing: string[] = [], over: Record<string, unknown> = {}): Host {
  return {
    resources: {
      search: vi.fn(async (q: { ids?: string[] }) => ({ items: (q.ids ?? []).filter((i) => existing.includes(i)).map((i) => info(i)), total: 0 })),
      update: vi.fn(async () => ({})),
    },
    ...over,
  };
}
const ctxOf = (host: Host, items: unknown, extra: Record<string, unknown> = {}) => ({ locale: "en-US", host, t, resource: { id: "c1", body: { items } }, ...extra });

describe("composite: helpers", () => {
  it("itemsOf keeps strings only, drops duplicates and stops at the limit", () => {
    expect(itemsOf(["a", "b", "a", "", 3, null])).toEqual(["a", "b"]);
    expect(itemsOf(undefined)).toEqual([]);
    expect(itemsOf(Array.from({ length: 1500 }, (_, i) => `i${i}`))).toHaveLength(MAX_ITEMS);
  });
  it("move swaps with the neighbour and ignores the ends and unknown ids", () => {
    expect(move(["a", "b", "c"], "b", -1)).toEqual(["b", "a", "c"]);
    expect(move(["a", "b", "c"], "b", 1)).toEqual(["a", "c", "b"]);
    expect(move(["a", "b"], "a", -1)).toEqual(["a", "b"]);
    expect(move(["a", "b"], "b", 1)).toEqual(["a", "b"]);
    expect(move(["a", "b"], "z", 1)).toEqual(["a", "b"]);
  });
});

describe("composite: drop", () => {
  const drop = (host: Host, items: unknown, sources: unknown[]) => registry(plugin).kinds.composite.drop(ctxOf(host, items), { sources });

  it("appends the new ids, skips ones already there and the node itself, and says how many were added", async () => {
    const host = fakeHost();
    const res = await drop(host, ["a"], [info("a"), info("b"), info("c1"), info("c")]);
    expect(host.resources.update).toHaveBeenCalledWith("c1", { "body.items": ["a", "b", "c"] });
    expect(res).toEqual({ handled: true, message: "Added 2 item(s)" });
  });
  it("nothing new: no write, still handled", async () => {
    const host = fakeHost();
    const res = await drop(host, ["a"], [info("a")]);
    expect(host.resources.update).not.toHaveBeenCalled();
    expect(res).toMatchObject({ handled: true, message: "Added 0 item(s)" });
  });
  it("stops at 1000 items", async () => {
    const host = fakeHost();
    const full = Array.from({ length: MAX_ITEMS - 1 }, (_, i) => `i${i}`);
    const res = await drop(host, full, [info("x"), info("y")]);
    expect(host.resources.update.mock.calls[0]![1]["body.items"]).toHaveLength(MAX_ITEMS);
    expect(res.message).toBe("Added 1 item(s)");
  });
  it("a failing write fails the drop", async () => {
    const host = fakeHost([], { resources: { update: vi.fn(async () => { throw new Error("boom"); }) } });
    await expect(drop(host, [], [info("a")])).rejects.toThrow("boom");
  });
});

describe("composite: children", () => {
  const children = (host: Host, items: unknown, node: string | null = null, offset = 0) => registry(plugin).kinds.composite.children(ctxOf(host, items), node, offset);

  it("gives the items in order with target, icon and name from the basic info", async () => {
    const host = fakeHost(["a", "b"]);
    const out = await children(host, ["b", "a"]);
    expect(out.nodes).toEqual([
      { key: "ref-b", label: "Name b", icon: "file-text", expandable: false, target: "resource:b" },
      { key: "ref-a", label: "Name a", icon: "file-text", expandable: false, target: "resource:a" },
    ]);
    for (const n of out.nodes) expect(onlyKeys(n, TREE_NODE_KEYS)).toEqual([]);
    expect(host.resources.search).toHaveBeenCalledWith({ ids: ["b", "a"], limit: 500 });
  });
  it("an id that is gone (or deleted) becomes a node that says so and cannot be opened", async () => {
    const host = fakeHost(["a"], { resources: { search: vi.fn(async () => ({ items: [info("a"), info("d", { deleted: true })], total: 2 })) } });
    const out = await children(host, ["a", "d", "gone"]);
    expect(out.nodes[1]).toEqual({ key: "ref-d", label: "(no longer exists)", icon: "unlink", expandable: false });
    expect(out.nodes[2]).toMatchObject({ key: "ref-gone", label: "(no longer exists)" });
    expect(out.nodes[2].target).toBeUndefined();
  });
  it("batches of 200 continue with next (a position); the last batch has none", async () => {
    const ids = Array.from({ length: 450 }, (_, i) => `i${i}`);
    const host = fakeHost(ids);
    const first = await children(host, ids);
    expect(first.nodes).toHaveLength(200);
    expect(first.next).toBe(200);
    const last = await children(host, ids, null, 400);
    expect(last.nodes).toHaveLength(50);
    expect(last.next).toBeUndefined();
  });
  it("an empty composite and an expanded plugin node give nothing", async () => {
    const host = fakeHost();
    expect(await children(host, [])).toEqual({ nodes: [] });
    expect(await children(host, ["a"], "ref-a")).toEqual({ nodes: [] });
  });
});

describe("composite: page", () => {
  const { pages } = registry(plugin);
  it("an empty composite shows one muted sentence", async () => {
    const out = await pages.editor.render(ctxOf(fakeHost(), []));
    expect(checkView(out.view)).toEqual([]);
    expect(out.view).toEqual([{ type: "text", id: "empty", text: "Drag items onto this node.", tone: "muted" }]);
  });
  it("a table of icon, name and type; rows open the resource, a missing one has no target", async () => {
    const host = fakeHost(["a"]);
    const out = await pages.editor.render(ctxOf(host, ["a", "gone"]));
    expect(checkView(out.view)).toEqual([]);
    expect(onlyKeys(out, RENDER_KEYS)).toEqual([]);
    expect(out.view[0].rows).toEqual([["file-text", "Name a", "org.onedesk.note:note"], ["unlink", "(no longer exists)", ""]]);
    expect(out.view[0].rowTargets).toEqual(["resource:a", ""]);
  });
  it("the unsaved draft wins over the saved list; kindLabel is shown when given", async () => {
    const host = { resources: { search: vi.fn(async () => ({ items: [info("b", { kindLabel: "Note" })], total: 1 })) } };
    const out = await pages.editor.render(ctxOf(host, ["a"], { draft: { "body.items": ["b"] } }));
    expect(out.view[0].rows).toEqual([["file-text", "Name b", "Note"]]);
  });
  it("events remove, up and down change the draft list and leave the resource alone", async () => {
    const host = fakeHost();
    const ev = (name: string, items = ["a", "b", "c"]) => pages.editor.onEvent(ctxOf(host, items), name);
    expect(await ev("remove:b")).toEqual({ changes: { "body.items": ["a", "c"] }, message: "Removed from this composite" });
    expect((await ev("up:c")).changes).toEqual({ "body.items": ["a", "c", "b"] });
    expect((await ev("down:a")).changes).toEqual({ "body.items": ["b", "a", "c"] });
    expect((await ev("up:a")).changes).toEqual({ "body.items": ["a", "b", "c"] });
    await expect(ev("remove:zzz")).rejects.toThrow();
    await expect(ev("nope:a")).rejects.toThrow();
    expect(host.resources.update).not.toHaveBeenCalled();
  });
  it("events work on the draft list, not only the saved one", async () => {
    const out = await pages.editor.onEvent(ctxOf(fakeHost(), ["a"], { draft: { "body.items": ["x", "y"] } }), "remove:x");
    expect(out.changes).toEqual({ "body.items": ["y"] });
  });
});

describe("composite: package", () => {
  const m = JSON.parse(readFileSync(new URL("./manifest.json", import.meta.url), "utf8"));
  it("registers what the manifest declares", () => {
    const r = registry(plugin);
    expect(Object.keys(r.kinds)).toEqual(["composite"]);
    expect(Object.keys(r.pages)).toEqual(["editor"]);
    expect(Object.keys(r.kinds.composite).sort()).toEqual(["children", "drop"]);
  });
  it("the kind is a droppable, self-supplying resource node that accepts composites; resources are required", () => {
    expect(m.requires.resources).toBe(true);
    expect(m.contributes.kinds[0]).toMatchObject({ id: "composite", tree: "resources", children: true, drop: true, accepts: ["composite"], defaults: { items: [] } });
    expect(m.legacyKinds).toBeUndefined();
  });
  it("every text key used exists in en, zh and ja with the same key set", () => {
    const code = readFileSync(new URL("./main.js", import.meta.url), "utf8");
    const used = [...code.matchAll(/(?:ctx\.t|tr)\((?:ctx, )?"([^"]+)"/g)].map((x) => x[1]!);
    const manifest = readFileSync(new URL("./manifest.json", import.meta.url), "utf8");
    const mkeys = [...manifest.matchAll(/"((?:plugin|kind|action)\.[A-Za-z.]+)"/g)].map((x) => x[1]!);
    for (const k of [...used, ...mkeys]) for (const L of [EN, ZH, JA]) expect(L[k], k).toBeTypeOf("string");
    expect(Object.keys(ZH).sort()).toEqual(Object.keys(EN).sort());
    expect(Object.keys(JA).sort()).toEqual(Object.keys(EN).sort());
  });
});
