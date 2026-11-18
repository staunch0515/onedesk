import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
// @ts-ignore plain JS module, no types
import plugin from "./main.js";
import { RENDER_KEYS, checkView, onlyKeys, registry, t } from "../_testing/view-check";

const ctxOf = (host: unknown, extra: Record<string, unknown> = {}) => ({ target: "resource:r1", locale: "en-US", host, t, ...extra });

describe("note plugin: reading view", () => {
  it("edit mode is the default: mode strip plus the editor", async () => {
    const { pages } = registry(plugin);
    const out = await pages.editor.render(ctxOf({}));
    expect(out.view.map((n: any) => n.id)).toEqual(["mode", "content"]);
    expect(out.view[0].fields[0]).toMatchObject({ name: "mode", param: true, kind: "enum", envValue: "edit" });
  });

  it("read mode renders the unsaved draft as Markdown, not the saved body", async () => {
    const { pages } = registry(plugin);
    const out = await pages.editor.render(ctxOf({}, { params: { mode: "read" }, draft: { "body.text": "# draft" }, resource: { id: "r1", body: { text: "saved" } } }));
    expect(checkView(out.view)).toEqual([]);
    expect(out.view.find((n: any) => n.id === "reading")).toEqual({ type: "text", id: "reading", text: "# draft", format: "markdown" });
    expect(out.view.find((n: any) => n.id === "content")).toBeUndefined();
    const saved = await pages.editor.render(ctxOf({}, { params: { mode: "read" }, resource: { id: "r1", body: { text: "saved" } } }));
    expect(saved.view[1].text).toBe("saved");
  });

  it("toggle flips the page parameter mode and keeps the draft untouched", async () => {
    const { pages } = registry(plugin);
    const a = await pages.editor.onEvent(ctxOf({}), "toggle");
    expect(a.params).toEqual({ mode: "read" });
    expect(onlyKeys(a, ["changes", "params", "message"])).toEqual([]);
    expect(a.changes).toBeUndefined();
    const b = await pages.editor.onEvent(ctxOf({}, { params: { mode: "read" } }), "toggle");
    expect(b.params).toEqual({ mode: "edit" });
    await expect(pages.editor.onEvent(ctxOf({}), "nope")).rejects.toThrow();
  });

  // Review #10: `recompute: true` stays. The shell re-renders a page only through the recompute effect (view-page.tsx: it
  // re-resolves when the draft or a page parameter changes and the page asked for it); a page event's `params`/`changes`
  // only update tab state. Without recompute, toggling `mode` would never redraw the reading view.
  it("the manifest declares the toggle event, recompute (needed to redraw after the mode changes) and legacyKinds", () => {
    const m = JSON.parse(readFileSync(new URL("./manifest.json", import.meta.url), "utf8"));
    expect(m.legacyKinds).toEqual(["note"]);
    expect(m.contributes.pages[0].recompute).toBe(true);
    expect(m.contributes.pages[0].actions.find((a: any) => a.id === "toggle")).toMatchObject({ role: "event" });
  });
});

describe("note plugin", () => {
  it("registers only what the manifest declares", () => {
    const r = registry(plugin);
    expect(Object.keys(r.pages)).toEqual(["editor"]);
    expect(Object.keys(r.commands)).toEqual(["duplicate"]);
    expect(r.trees).toEqual({});
  });

  it("renders a full-height longtext bound to body.text", async () => {
    const { pages } = registry(plugin);
    const out = await pages.editor.render(ctxOf({}));
    expect(checkView(out.view)).toEqual([]);
    const field = out.view.find((n: any) => n.id === "content").fields[0];
    expect(field).toMatchObject({ kind: "longtext", bind: "body.text", fill: true });
    expect(onlyKeys(out, RENDER_KEYS)).toEqual([]);
  });

  it("duplicate: reads the original, creates a copy, opens it", async () => {
    const { commands } = registry(plugin);
    const host = {
      resources: {
        get: vi.fn(async () => ({ id: "r1", name: "Plan", parentId: "g1", description: "d", tags: ["x"], body: { text: "hello" } })),
        create: vi.fn(async () => ({ id: "r2" })),
      },
      ui: { open: vi.fn(async () => undefined) },
    };
    const effects = await commands.duplicate(ctxOf(host), { nodeKey: "r1" });
    expect(effects).toEqual([]);
    expect(host.resources.create).toHaveBeenCalledWith({
      kind: "org.onedesk.note:note",
      parent: "g1",
      name: "Plan (copy.suffix)",
      description: "d",
      tags: ["x"],
      body: { text: "hello" },
    });
    expect(host.ui.open).toHaveBeenCalledWith("resource:r2");
  });

  it("duplicate: localizes the suffix and survives a missing original", async () => {
    const { commands } = registry(plugin);
    const host = {
      resources: { get: vi.fn(async () => null), create: vi.fn() },
      ui: { open: vi.fn() },
    };
    const effects = await commands.duplicate(ctxOf(host), { nodeKey: "gone" });
    expect(effects[0]).toMatchObject({ type: "toast", tone: "danger" });
    expect(host.resources.create).not.toHaveBeenCalled();
    expect(await commands.duplicate(ctxOf(host), {})).toEqual([]);

    const host2 = {
      resources: { get: async () => ({ id: "r1", name: "计划", body: {} }), create: vi.fn(async (_a: unknown) => ({ id: "r3" })) },
      ui: { open: vi.fn() },
    };
    await commands.duplicate(ctxOf(host2, { locale: "zh-CN" }), { nodeKey: "r1" });
    expect((host2.resources.create.mock.calls[0]![0] as { name: string }).name).toBe("计划 (zh:copy.suffix)");
  });

  it("duplicate: a denied host call propagates (the kernel reports it)", async () => {
    const { commands } = registry(plugin);
    const err = Object.assign(new Error("denied"), { code: "denied" });
    const host = { resources: { get: async () => { throw err; } }, ui: { open: vi.fn() } };
    await expect(commands.duplicate(ctxOf(host), { nodeKey: "other" })).rejects.toMatchObject({ code: "denied" });
  });

  it("the manifest declares the body text as a field that may contain [[references]]", () => {
    const m = JSON.parse(readFileSync(new URL("./manifest.json", import.meta.url), "utf8"));
    expect(m.contributes.kinds[0].fields).toEqual({ text: { type: "longtext", refs: true } });
    expect(m.contributes.kinds[0].fields.text.grants).toBeUndefined();
  });

  it("exports the note kind to dependents: they may add actions and read it", () => {
    const m = JSON.parse(readFileSync(new URL("./manifest.json", import.meta.url), "utf8"));
    expect(m.exports).toEqual({ kinds: [{ id: "note", actions: true, read: true }] });
    expect(m.contributes.kinds.map((k: { id: string }) => k.id)).toContain("note");
  });

  it("the body placeholder mentions the [[name]] syntax in both languages", () => {
    for (const [lang, token] of [["en-US", "[[Name]]"], ["zh-CN", "[[名称]]"]] as const) {
      const l = JSON.parse(readFileSync(new URL(`./locales/${lang}.json`, import.meta.url), "utf8"));
      expect(l["field.placeholder"]).toContain(token);
    }
  });
});
