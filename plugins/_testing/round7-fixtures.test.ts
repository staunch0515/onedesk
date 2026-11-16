/** Checks of the round-7 fixtures: the note-tools plugin (depends on the note plugin) and the market folder. */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
// @ts-ignore plain JS module, no types
import plugin, { countText } from "../../e2e/fixtures/plugins/com.example.note-tools/0.1.0/main.js";
import { checkActionResult, hostError, registry } from "./view-check";

const fx = (p: string) => new URL(`../../e2e/fixtures/${p}`, import.meta.url);
const json = (p: string) => JSON.parse(readFileSync(fx(p), "utf8"));
const NT = "plugins/com.example.note-tools/0.1.0";
const locale = (l: string) => json(`${NT}/locales/${l}.json`) as Record<string, string>;
const t = (key: string) => ({ "en-US": locale("en-US")[key], "zh-CN": locale("zh-CN")[key] });
const note = { id: "n1", kind: "org.onedesk.note:note", name: "Plan", body: { text: "hello brave world\nsecond line\n你好世界" } };
const ctxOf = (host: unknown, extra: Record<string, unknown> = {}) => ({ locale: "en-US", t, host, resource: note, progress: vi.fn(), cancelled: () => false, ...extra }) as any;

describe("fixture: note-tools manifest", () => {
  const m = json(`${NT}/manifest.json`);
  it("depends on the note plugin and asks for no permission", () => {
    expect(m.depends).toEqual([{ id: "org.onedesk.note", version: ">=0.1.0" }]);
    expect(m.requires).toEqual({ files: false });
  });
  it("adds count and stamp to the note kind by its full name", () => {
    expect(m.contributes.actions.map((a: any) => [a.id, a.kinds, a.output])).toEqual([
      ["count", ["org.onedesk.note:note"], "text"],
      ["stamp", ["org.onedesk.note:note"], "text"],
    ]);
    expect(m.contributes.kinds).toBeUndefined();
  });
  it("the kind it names is exported by the built-in note plugin with actions and read", () => {
    const builtin = JSON.parse(readFileSync(new URL("../org.onedesk.note/manifest.json", import.meta.url), "utf8"));
    expect(builtin.exports.kinds).toContainEqual({ id: "note", actions: true, read: true });
    expect(m.depends[0].id).toBe(builtin.id);
  });
  it("has the same locale keys in both languages and the manifest keys are defined", () => {
    expect(Object.keys(locale("en-US")).sort()).toEqual(Object.keys(locale("zh-CN")).sort());
    for (const k of ["plugin.name", "plugin.description", "action.count", "action.stamp"]) expect(locale("en-US")[k]).toBeTruthy();
  });
  it("registers exactly its two actions", () => {
    expect(Object.keys(registry(plugin).actions).sort()).toEqual(["count", "stamp"]);
  });
});

describe("note-tools: count", () => {
  it("counts words and lines of the resource body", async () => {
    const { actions } = registry(plugin);
    const res = await actions.count(ctxOf({}), {});
    expect(checkActionResult(res)).toEqual([]);
    // 3 + 2 latin words, 4 CJK characters
    expect(res.output).toEqual({ type: "text", text: "9 words, 3 lines" });
    expect(res.summary).toEqual({ message: "9 words" });
  });
  it("answers in the viewer's language", async () => {
    const { actions } = registry(plugin);
    expect((await actions.count(ctxOf({}, { locale: "zh-CN" }), {})).output.text).toBe("9 个词，3 行");
  });
  it("an empty note has 0 words and 0 lines; the input snapshot is the fallback", async () => {
    const { actions } = registry(plugin);
    expect((await actions.count(ctxOf({}, { resource: { id: "n2", body: { text: "" } } }), {})).output.text).toBe("0 words, 0 lines");
    expect((await actions.count(ctxOf({}, { resource: { id: "n2", body: undefined } }), { "body.text": "a b" })).output.text).toBe("2 words, 1 lines");
  });
  it("never touches the host", async () => {
    const { actions } = registry(plugin);
    const host = { resources: { update: vi.fn(), create: vi.fn(), remove: vi.fn() } };
    await actions.count(ctxOf(host), {});
    expect(host.resources.update).not.toHaveBeenCalled();
  });
  it("fails without a resource", async () => {
    const { actions } = registry(plugin);
    await expect(actions.count(ctxOf({}, { resource: undefined }), {})).rejects.toThrow("no resource");
  });
  it("countText", () => {
    expect(countText("  a   b\tc ")).toEqual({ words: 3, lines: 1 });
    expect(countText(undefined)).toEqual({ words: 0, lines: 0 });
    expect(countText("日本語です")).toEqual({ words: 5, lines: 1 });
  });
});

describe("note-tools: stamp", () => {
  it("tries to update the note with the new text", async () => {
    const { actions } = registry(plugin);
    const update = vi.fn(async () => ({ id: "n1" }));
    await actions.stamp(ctxOf({ resources: { update } }), {});
    expect(update).toHaveBeenCalledWith("n1", { "body.text": `${note.body.text}\n-- stamped` });
  });
  it("lets the host's refusal through unchanged (code and params kept)", async () => {
    const { actions } = registry(plugin);
    const err = hostError("denied", { reason: "foreignKind" });
    const update = vi.fn(async () => Promise.reject(err));
    await expect(actions.stamp(ctxOf({ resources: { update } }), {})).rejects.toBe(err);
  });
});

describe("fixture: market folder", () => {
  it("has the three packages", () => {
    expect(existsSync(fx("market/com.example.hello/0.1.0/manifest.json"))).toBe(true);
    expect(existsSync(fx("market/broken/manifest.json"))).toBe(true);
    expect(existsSync(fx("market/org.onedesk.note/0.1.0/manifest.json"))).toBe(true);
  });
  it("hello: one kind, one page, no permission", () => {
    const m = json("market/com.example.hello/0.1.0/manifest.json");
    expect(m.id).toBe("com.example.hello");
    expect(m.requires).toEqual({ files: false });
    expect(m.contributes.kinds).toHaveLength(1);
    expect(m.contributes.pages).toHaveLength(1);
    expect(m.contributes.kinds[0].page).toBe(m.contributes.pages[0].id);
    for (const l of ["en-US", "zh-CN"]) {
      const names = json(`market/com.example.hello/0.1.0/locales/${l}.json`);
      for (const k of [m.name, m.description, m.contributes.kinds[0].label, m.contributes.kinds[0].newName]) expect(names[k], `${l} ${k}`).toBeTruthy();
    }
  });
  it("hello has a main.js that registers its kind and page", () => {
    const src = readFileSync(fx("market/com.example.hello/0.1.0/main.js"), "utf8");
    expect(src).toContain('host.kinds.handle("greeting"');
    expect(src).toContain('host.pages.handle("editor"');
  });
  it("broken: readable JSON with an id and a version, but an unknown top-level field", () => {
    const m = json("market/broken/manifest.json");
    expect(m.id).toBeTruthy();
    expect(m.version).toBeTruthy();
    expect(m.surprise).toBeDefined();
  });
  it("the bundled note copy is the built-in package, byte for byte, at the built-in version", () => {
    const builtin = new URL("../org.onedesk.note/", import.meta.url);
    const copy = fx("market/org.onedesk.note/0.1.0/");
    const version = JSON.parse(readFileSync(new URL("manifest.json", builtin), "utf8")).version;
    expect(copy.pathname.endsWith(`/${version}/`)).toBe(true);
    for (const f of ["manifest.json", "main.js", "locales/en-US.json", "locales/zh-CN.json"]) {
      expect(readFileSync(new URL(f, copy), "utf8"), f).toBe(readFileSync(new URL(f, builtin), "utf8"));
    }
  });
});
