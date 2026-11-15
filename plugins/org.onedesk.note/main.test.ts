import { describe, expect, it, vi } from "vitest";
// @ts-ignore plain JS module, no types
import plugin from "./main.js";
import { RENDER_KEYS, checkView, onlyKeys, registry, t } from "../_testing/view-check";

const ctxOf = (host: unknown, extra: Record<string, unknown> = {}) => ({ target: "resource:r1", locale: "en-US", host, t, ...extra });

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
    const field = out.view[0].fields[0];
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
});
