/** Checks of the round-10 fixture: nested (fake host, nothing else). */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
// @ts-ignore plain JS module, no types
import nested from "../../e2e/fixtures/plugins/com.example.nested/0.1.0/main.js";
import { checkActionResult, checkView, onlyKeys, registry, RENDER_KEYS, TREE_NODE_KEYS, TREE_PAGE_KEYS } from "./view-check";

const dir = "com.example.nested/0.1.0";
const fx = (p: string) => new URL(`../../e2e/fixtures/plugins/${dir}/${p}`, import.meta.url);
const json = (p: string) => JSON.parse(readFileSync(fx(p), "utf8"));
const locale = (l: string) => json(`locales/${l}.json`) as Record<string, string>;
const t = (key: string) => ({ "en-US": locale("en-US")[key], "zh-CN": locale("zh-CN")[key] });
const ctxOf = (host: unknown, extra: Record<string, unknown> = {}) => ({ locale: "en-US", t, host, progress: vi.fn(), cancelled: () => false, ...extra }) as any;
const shelf = (count: unknown) => ({ id: "res-1", kind: "shelf", body: { count, text: "" } });

describe("fixture: nested", () => {
  const m = json("manifest.json");
  it("declares the shelf kind with self-supplied children, a touch action and two languages", () => {
    expect(m.contributes.kinds.map((k: any) => [k.id, k.children])).toEqual([["shelf", true]]);
    expect(m.contributes.actions.map((a: any) => a.id)).toEqual(["touch"]);
    expect(m.contributes.trees ?? []).toEqual([]);
    expect(Object.keys(m.contributes.locales)).toEqual(["en-US", "zh-CN"]);
  });
  it("registers exactly what the manifest declares", () => {
    const r = registry(nested);
    expect(Object.keys(r.kinds)).toEqual(["shelf"]);
    expect(typeof r.kinds.shelf.children).toBe("function");
    expect(Object.keys(r.actions)).toEqual(["touch"]);
    expect(Object.keys(r.pages)).toEqual(["editor"]);
  });
  it("has the same locale keys in both languages and every key used is defined", () => {
    expect(Object.keys(locale("en-US")).sort()).toEqual(Object.keys(locale("zh-CN")).sort());
    const src = readFileSync(fx("main.js"), "utf8");
    const used = [...src.matchAll(/(?:tr\(ctx, |ctx\.t\()"([a-zA-Z.]+)"/g)].map((x) => x[1]!);
    const labels = [...readFileSync(fx("manifest.json"), "utf8").matchAll(/"(?:label|name|description|newName)":\s*"([a-zA-Z]+\.[a-zA-Z.]+)"/g)].map((x) => x[1]!);
    expect(used.length).toBeGreaterThan(2);
    for (const k of [...used, ...labels, "touch.text"]) expect(locale("en-US")[k], k).toBeTruthy();
  });
  it("renders a form with count and text, read-only while showing a run", async () => {
    const { pages } = registry(nested);
    const out = await pages.editor.render(ctxOf({}, { resource: shelf(3) }));
    expect(onlyKeys(out, RENDER_KEYS)).toEqual([]);
    expect(checkView(out.view)).toEqual([]);
    expect(out.view[0].fields.map((f: any) => f.bind)).toEqual(["body.count", "body.text"]);
    const run = await pages.editor.render(ctxOf({}, { resource: shelf(3), run: {} }));
    expect(run.view[0].fields.every((f: any) => f.readOnly)).toBe(true);
  });

  describe("children", () => {
    const children = (count: unknown, offset?: string, extra: Record<string, unknown> = {}) => registry(nested).kinds.shelf.children(ctxOf({}, { resource: shelf(count), ...extra }), null, offset);

    it("gives count nodes in batches of 500 continued by next; the first has the target, the rest none", async () => {
      const first = await children(1200);
      expect(onlyKeys(first, TREE_PAGE_KEYS)).toEqual([]);
      expect(first.nodes).toHaveLength(500);
      expect(first.next).toBe("500");
      for (const n of first.nodes) expect(onlyKeys(n, TREE_NODE_KEYS)).toEqual([]);
      expect(first.nodes[0]).toMatchObject({ key: "item-1", label: "Item 00001", target: "resource:res-1" });
      expect(first.nodes.slice(1).some((n: any) => "target" in n)).toBe(false);
      const second = await children(1200, first.next);
      expect(second.nodes).toHaveLength(500);
      expect(second.nodes[0]).toMatchObject({ key: "item-501", label: "Item 00501" });
      expect("target" in second.nodes[0]).toBe(false);
      const third = await children(1200, second.next);
      expect(third.nodes).toHaveLength(200);
      expect(third.next).toBeUndefined();
      expect(third.nodes[199].label).toBe("Item 01200");
    });
    it("walks 20000 nodes in 40 batches with unique keys", async () => {
      const keys = new Set<string>();
      let offset: string | undefined;
      let batches = 0;
      do {
        const page = await children(20000, offset);
        for (const n of page.nodes) keys.add(n.key);
        offset = page.next;
        batches++;
      } while (offset);
      expect(batches).toBe(40);
      expect(keys.size).toBe(20000);
    }, 30000);
    it("an exact multiple of 500 ends without a dangling next; zero gives no nodes", async () => {
      expect((await children(500)).next).toBeUndefined();
      expect(await children(0)).toEqual({ nodes: [] });
      expect(await children(undefined)).toEqual({ nodes: [] });
    });
    it("labels follow the locale", async () => {
      const zh = await children(2, undefined, { locale: "zh-CN" });
      expect(zh.nodes.map((n: any) => n.label)).toEqual(["条目 00001", "条目 00002"]);
    });
    it("count -1 throws", async () => {
      await expect(children(-1)).rejects.toThrow(/-1/);
    });
  });

  it("touch rewrites the resource's text through the host, once", async () => {
    const { actions } = registry(nested);
    const update = vi.fn(async () => undefined);
    const res = await actions.touch(ctxOf({ resources: { update } }, { resource: shelf(3) }), {});
    expect(checkActionResult(res)).toEqual([]);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith("res-1", { "body.text": "changed by the plugin" });
    const zh = await actions.touch(ctxOf({ resources: { update } }, { resource: shelf(3), locale: "zh-CN" }), {});
    expect(update).toHaveBeenLastCalledWith("res-1", { "body.text": "由插件改的" });
    expect(zh.output.text).toBe("已改");
  });
});
