import { describe, expect, it, vi } from "vitest";
// @ts-ignore plain JS module, no types
import plugin, { arrange, chain, languageOf } from "./main.js";
import { CRUMB_KEYS, RENDER_KEYS, SAVE_KEYS, TREE_NODE_KEYS, TREE_PAGE_KEYS, checkView, hostError, onlyKeys, registry, t } from "../_testing/view-check";

const ROOT = "/Users/me/docs";
const roots = [{ path: ROOT, name: "docs" }];
const entry = (name: string, dir = false, hidden = false) => ({ name, path: `${ROOT}/${name}`, dir, size: 1, modifiedAt: 0, hidden });

function ctxOf(files: Record<string, unknown>, key: string, extra: Record<string, unknown> = {}) {
  return { target: `node:org.onedesk.files:files/${encodeURIComponent(key)}`, node: { tree: "org.onedesk.files:files", key }, locale: "en-US", host: { files }, t, ...extra };
}

describe("files plugin: tree", () => {
  it("top level is the authorized folders; empty when none", async () => {
    const { trees } = registry(plugin);
    const files = { roots: vi.fn(async () => roots) };
    const out = await trees.files.children(ctxOf(files, ""), null, 0);
    expect(out.nodes).toEqual([{ key: ROOT, label: "docs", icon: "folder", expandable: true }]);
    files.roots.mockResolvedValue([]);
    expect((await trees.files.children(ctxOf(files, ""), null, 0)).nodes).toEqual([]);
  });

  it("lists folders first, sorted, no hidden, files target a node page", async () => {
    const { trees } = registry(plugin);
    const files = {
      list: vi.fn(async () => ({
        entries: [entry("b.txt"), entry("Zeta", true), entry(".git", true, true), entry("a.md"), entry("alpha", true), entry(".env", false, false)],
        next: 200,
      })),
    };
    const out = await trees.files.children(ctxOf(files, ROOT), ROOT, 0);
    expect(out.nodes.map((n: any) => n.label)).toEqual(["alpha", "Zeta", "a.md", "b.txt"]);
    expect(out.nodes[0]).toMatchObject({ expandable: true, key: `${ROOT}/alpha` });
    expect(out.nodes[0].target).toBeUndefined();
    expect(out.nodes[2].target).toBe(`node:org.onedesk.files:files/${encodeURIComponent(`${ROOT}/a.md`)}`);
    expect(out.next).toBe(200);
    expect(onlyKeys(out, TREE_PAGE_KEYS)).toEqual([]);
    for (const n of out.nodes) expect(onlyKeys(n, TREE_NODE_KEYS)).toEqual([]);
    expect(files.list).toHaveBeenCalledWith(ROOT, { offset: 0, limit: 200 });
  });

  it("passes the offset on and omits next at the end", async () => {
    const { trees } = registry(plugin);
    const files = { list: vi.fn(async () => ({ entries: [entry("x.txt")] })) };
    const out = await trees.files.children(ctxOf(files, ROOT), ROOT, 200);
    expect("next" in out).toBe(false);
    expect(files.list).toHaveBeenCalledWith(ROOT, { offset: 200, limit: 200 });
  });

  it("a denied listing propagates", async () => {
    const { trees } = registry(plugin);
    const files = { list: async () => { throw hostError("denied"); } };
    await expect(trees.files.children(ctxOf(files, "/etc"), "/etc", 0)).rejects.toMatchObject({ code: "denied" });
  });

  it("path runs from the authorized folder down", async () => {
    const { trees } = registry(plugin);
    const files = { roots: async () => roots };
    expect(await trees.files.path(ctxOf(files, ""), `${ROOT}/a/b.txt`)).toEqual([ROOT, `${ROOT}/a`, `${ROOT}/a/b.txt`]);
  });

  it("helpers", () => {
    expect(chain("/Users/me/docs2/x", roots)).toBeNull();
    expect(chain(ROOT, roots)).toEqual([ROOT]);
    expect(languageOf("a.RS")).toBe("rust");
    expect(languageOf("Makefile")).toBeUndefined();
    expect(arrange([entry("b"), entry("a")]).map((e: { name: string }) => e.name)).toEqual(["a", "b"]);
  });
});

describe("files plugin: text page", () => {
  const key = `${ROOT}/notes.md`;

  it("shows a full-height code field with language, values and basis", async () => {
    const { pages } = registry(plugin);
    const files = { roots: async () => roots, readText: vi.fn(async () => ({ text: "# hi", basis: "b1" })) };
    const out = await pages.text.render(ctxOf(files, key));
    expect(checkView(out.view)).toEqual([]);
    expect(out.view[0].fields[0]).toMatchObject({ kind: "code", bind: "content", fill: true, language: "markdown" });
    expect(out).toMatchObject({ title: "notes.md", values: { content: "# hi" }, basis: "b1" });
    expect(out.breadcrumb.map((c: any) => c.label)).toEqual(["docs", "notes.md"]);
    expect(out.readOnly).toBeUndefined();
    expect(onlyKeys(out, RENDER_KEYS)).toEqual([]);
    for (const c of out.breadcrumb) expect(onlyKeys(c, CRUMB_KEYS)).toEqual([]);
  });

  it("no language for unknown extensions", async () => {
    const { pages } = registry(plugin);
    const files = { roots: async () => roots, readText: async () => ({ text: "", basis: "b" }) };
    const out = await pages.text.render(ctxOf(files, `${ROOT}/data.xyz`));
    expect("language" in out.view[0].fields[0]).toBe(false);
  });

  it.each([
    ["invalid", { reason: "tooLarge" }, "reason.tooLarge"],
    ["invalid", { reason: "notText" }, "reason.notText"],
    ["denied", {}, "reason.denied"],
    ["notFound", {}, "reason.notFound"],
    ["internal", {}, "reason.failed"],
  ])("%s %j → muted explanation", async (code, params, textKey) => {
    const { pages } = registry(plugin);
    const files = { roots: async () => roots, readText: async () => { throw hostError(code, params as Record<string, string>); } };
    const out = await pages.text.render(ctxOf(files, key));
    expect(checkView(out.view)).toEqual([]);
    expect(out.view[0]).toMatchObject({ type: "text", id: "reason", tone: "muted" });
    expect(out.view[0].text).toBe(textKey); // fake t() returns the key for en-US
    expect(out.readOnly).toBe(true);
    expect(onlyKeys(out, RENDER_KEYS)).toEqual([]);
    for (const c of out.breadcrumb) expect(onlyKeys(c, CRUMB_KEYS)).toEqual([]);
  });

  it("save writes with the basis and returns the new one", async () => {
    const { pages } = registry(plugin);
    const files = { writeText: vi.fn(async () => ({ basis: "b2" })) };
    const res = await pages.text.save(ctxOf(files, key), { content: "new" }, "b1");
    expect(files.writeText).toHaveBeenCalledWith(key, "new", { basis: "b1" });
    expect(res).toEqual({ basis: "b2" });
    expect(onlyKeys(res, SAVE_KEYS)).toEqual([]);
  });

  it("save without a basis passes no options", async () => {
    const { pages } = registry(plugin);
    const files = { writeText: vi.fn(async () => ({ basis: "b" })) };
    await pages.text.save(ctxOf(files, key), { content: "x" }, undefined);
    expect(files.writeText).toHaveBeenCalledWith(key, "x", undefined);
  });

  it.each(["conflict", "denied", "invalid"])("save: %s propagates to the kernel", async (code) => {
    const { pages } = registry(plugin);
    const files = { writeText: async () => { throw hostError(code); } };
    await expect(pages.text.save(ctxOf(files, key), { content: "x" }, "b1")).rejects.toMatchObject({ code });
  });
});
