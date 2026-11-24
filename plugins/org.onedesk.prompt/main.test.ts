import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
// @ts-ignore plain JS module, no types
import plugin, { fillHoles, holeNames } from "./main.js";
import { RENDER_KEYS, checkActionResult, checkView, onlyKeys, registry, t } from "../_testing/view-check";

const ctxOf = (host: unknown, extra: Record<string, unknown> = {}) => ({ target: "resource:r1", locale: "en-US", host, t: (k: string) => t(k)["en-US"], ...extra });

describe("prompt plugin: placeholders", () => {
  it("finds {{name}} once each, in order; colons, spaces and long names do not count", () => {
    expect(holeNames("Hi {{who}}, about {{topic}} and {{who}} {{中文名}} {{a-b_c1}}")).toEqual(["who", "topic", "中文名", "a-b_c1"]);
    expect(holeNames("{{secret:key}} {{ spaced }} {{}} {{" + "x".repeat(65) + "}} {single}")).toEqual([]);
    expect(holeNames("{{" + "x".repeat(64) + "}}")).toHaveLength(1);
  });

  it("fills what is typed and leaves the rest as written", () => {
    expect(fillHoles("{{a}} and {{b}} and {{secret:k}}", { a: "1", b: "" })).toBe("1 and {{b}} and {{secret:k}}");
    expect(fillHoles("{{a}}{{a}}", { a: "$&" })).toBe("$&$&");
    expect(fillHoles("x", undefined)).toBe("x");
  });
});

describe("prompt plugin: page and actions", () => {
  it("registers the page and the preview action", () => {
    const r = registry(plugin);
    expect(Object.keys(r.pages)).toEqual(["editor"]);
    expect(Object.keys(r.actions)).toEqual(["preview"]);
  });

  it("render: one param input per placeholder, taken from the unsaved draft", async () => {
    const { pages } = registry(plugin);
    const out = await pages.editor.render(ctxOf({}, { draft: { "body.text": "Write to {{who}} about {{topic}}" }, resource: { id: "r1", body: { text: "old" } } }));
    expect(checkView(out.view)).toEqual([]);
    expect(onlyKeys(out, RENDER_KEYS)).toEqual([]);
    expect(out.view[0]).toMatchObject({ id: "params", fields: [{ name: "who", param: true, kind: "text" }, { name: "topic", param: true, kind: "text" }] });
    expect(out.view[1].fields[0]).toMatchObject({ bind: "body.text", fill: true });
  });

  it("render: no placeholders, no parameter strip; a run page is read only", async () => {
    const { pages } = registry(plugin);
    const out = await pages.editor.render(ctxOf({}, { resource: { id: "r1", body: { text: "plain" } } }));
    expect(out.view.map((n: any) => n.id)).toEqual(["content"]);
    const run = { id: "x", input: { "body.text": "{{a}}" }, params: { a: "7" } };
    const ro = await pages.editor.render(ctxOf({}, { run }));
    expect(ro.view[0].fields[0]).toMatchObject({ name: "a", envValue: "7", readOnly: true });
    expect(ro.view[1].fields[0].readOnly).toBe(true);
  });

  it("copy: puts the filled text on the clipboard and says so", async () => {
    const { pages } = registry(plugin);
    const host = { ui: { copy: vi.fn(async () => undefined) } };
    const res = await pages.editor.onEvent(ctxOf(host, { params: { who: "Ann" }, draft: { "body.text": "Hi {{who}} re {{topic}}" } }), "copy");
    expect(host.ui.copy).toHaveBeenCalledWith("Hi Ann re {{topic}}");
    expect(res).toEqual({ message: "message.copied" });
    expect(onlyKeys(res, ["changes", "params", "message"])).toEqual([]);
    await expect(pages.editor.onEvent(ctxOf(host), "nope")).rejects.toThrow();
  });

  it("preview: text output with the filled text and a summary", async () => {
    const { actions } = registry(plugin);
    const res = await actions.preview(ctxOf({}, { params: { a: "1" } }), { "body.text": "{{a}}-{{b}}" });
    expect(checkActionResult(res)).toEqual([]);
    expect(res.output).toEqual({ type: "text", text: "1-{{b}}" });
    expect(res.summary.message).toBe("summary.preview");
  });

  it("the manifest: copy is an event, preview is a run action", () => {
    const m = JSON.parse(readFileSync(new URL("./manifest.json", import.meta.url), "utf8"));
    expect(m.contributes.pages[0]).toMatchObject({ recompute: true });
    expect(m.contributes.pages[0].actions.find((a: any) => a.id === "copy").role).toBe("event");
    expect(m.contributes.pages[0].actions.find((a: any) => a.id === "preview")).toMatchObject({ role: "run", action: "preview" });
    expect(m.contributes.kinds[0].fields.text.type).toBe("longtext");
  });
});

describe("prompt plugin: values come from the environment (D466)", () => {
  const envHost = (env: Record<string, string>) => ({
    ui: { copy: vi.fn(async () => undefined) },
    params: { get: vi.fn(async (n: string) => (n in env ? { found: true, value: env[n], sourceName: "Staging" } : { found: false })) },
  });

  it("each {{name}} input shows the environment's value; copy and preview use it unless one is typed", async () => {
    const { pages, actions } = registry(plugin);
    const host = envHost({ who: "Team", topic: "release" });
    const draft = { "body.text": "Hi {{who}} re {{topic}}" };
    const out = await pages.editor.render(ctxOf(host, { draft }));
    expect(checkView(out.view)).toEqual([]);
    expect(out.view[0].fields.map((f: any) => [f.name, f.envValue, f.envSource])).toEqual([["who", "Team", "Staging"], ["topic", "release", "Staging"]]);
    await pages.editor.onEvent(ctxOf(host, { draft, params: { who: "Ann" } }), "copy");
    expect(host.ui.copy).toHaveBeenCalledWith("Hi Ann re release");
    const res = await actions.preview(ctxOf(host, { params: {} }), draft);
    expect(res.output.text).toBe("Hi Team re release");
  });
});
