import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
// @ts-ignore plain JS module, no types
import plugin, { cleanUrl, hostOf } from "./main.js";
import { RENDER_KEYS, checkActionResult, checkView, onlyKeys, registry, t } from "../_testing/view-check";

const ctxOf = (host: unknown, extra: Record<string, unknown> = {}) => ({ target: "resource:r1", locale: "en-US", host, t, resource: { id: "r1", body: {} }, ...extra });
const fakeHost = () => ({ ui: { openExternal: vi.fn(async () => undefined) } });
const open = (host: unknown, input: Record<string, string>, extra = {}) => registry(plugin).actions.open(ctxOf(host, extra), input);

describe("link plugin", () => {
  it("registers one page and one action", () => {
    const r = registry(plugin);
    expect(Object.keys(r.pages)).toEqual(["editor"]);
    expect(Object.keys(r.actions)).toEqual(["open"]);
  });

  it("renders a form with url and profile bound to the body", async () => {
    const { pages } = registry(plugin);
    const out = await pages.editor.render(ctxOf({}));
    expect(checkView(out.view)).toEqual([]);
    expect(onlyKeys(out, RENDER_KEYS)).toEqual([]);
    expect(out.view[0].fields.map((f: any) => [f.name, f.bind])).toEqual([["url", "body.url"], ["profile", "body.profile"]]);
    const ro = await pages.editor.render(ctxOf({}, { run: { id: "x" } }));
    expect(ro.view[0].fields.every((f: any) => f.readOnly)).toBe(true);
  });

  it("open: hands the trimmed address to the host and returns a link output", async () => {
    const host = fakeHost();
    const res = await open(host, { "body.url": "  https://example.com/a?b=1  " });
    expect(host.ui.openExternal).toHaveBeenCalledWith("https://example.com/a?b=1");
    expect(checkActionResult(res)).toEqual([]);
    expect(res.output).toEqual({ type: "link", label: "output.label", target: "resource:r1" });
    expect(res.summary.message).toBe("summary.opened");
  });

  it("open: the output label and summary are in the run's language (the kernel's link output label is a plain string)", async () => {
    const host = fakeHost();
    const texts: Record<string, Record<string, string>> = { "output.label": { "en-US": "Opened {host}", "ja-JP": "{host} を開きました" }, "summary.opened": { "en-US": "Opened {host}", "ja-JP": "{host} を開きました" } };
    const ctx = ctxOf(host, { locale: "ja-JP", t: (k: string) => texts[k] ?? { "en-US": k } });
    const res = await registry(plugin).actions.open(ctx, { "body.url": "https://example.com/x" });
    expect(res.output.label).toBe("example.com を開きました");
    expect(res.summary.message).toBe("example.com を開きました");
  });

  it("open: mailto is allowed", async () => {
    const host = fakeHost();
    await open(host, { "body.url": "mailto:a@b.com?subject=hi" });
    expect(host.ui.openExternal).toHaveBeenCalledWith("mailto:a@b.com?subject=hi");
  });

  it("open: an empty address or a refused protocol gives the plugin's own error, and nothing is opened", async () => {
    const host = fakeHost();
    await expect(open(host, { "body.url": "   " })).rejects.toThrow("error.noUrl");
    await expect(open(host, {})).rejects.toThrow("error.noUrl");
    for (const bad of ["javascript:alert(1)", "file:///etc/passwd", "ftp://x.com", "example.com", "https://", "http://a b.com"]) {
      await expect(open(host, { "body.url": bad })).rejects.toThrow("error.badUrl");
    }
    await expect(open(host, { "body.url": "https://e.com/" + "a".repeat(2048) })).rejects.toThrow("error.badUrl");
    expect(host.ui.openExternal).not.toHaveBeenCalled();
  });

  it("open: a host refusal propagates", async () => {
    const err = Object.assign(new Error("bad"), { code: "invalid" });
    const host = { ui: { openExternal: vi.fn(async () => { throw err; }) } };
    await expect(open(host, { "body.url": "https://e.com" })).rejects.toMatchObject({ code: "invalid" });
  });

  it("cleanUrl / hostOf", () => {
    expect(cleanUrl("HTTPS://E.com")).toBe("HTTPS://E.com");
    expect(cleanUrl("")).toBeNull();
    expect(hostOf("https://user@e.com:8080/p")).toBe("e.com:8080");
    expect(hostOf("mailto:a@b.com?x=1")).toBe("a@b.com");
  });

  it("the manifest: kind link with url/profile, action open, three locales", () => {
    const m = JSON.parse(readFileSync(new URL("./manifest.json", import.meta.url), "utf8"));
    expect(m.contributes.kinds[0]).toMatchObject({ id: "link", tree: "resources", fields: { url: { type: "text" }, profile: { type: "text" } } });
    expect(m.contributes.actions[0]).toMatchObject({ id: "open", output: "link" });
    expect(Object.keys(m.contributes.locales)).toEqual(["en-US", "zh-CN", "ja-JP"]);
  });
});
