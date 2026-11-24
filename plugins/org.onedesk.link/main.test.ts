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

  it("renders a form with the address bound to the body (the browser profile field is gone, user 2026-11-24)", async () => {
    const { pages } = registry(plugin);
    const out = await pages.editor.render(ctxOf({}));
    expect(checkView(out.view)).toEqual([]);
    expect(onlyKeys(out, RENDER_KEYS)).toEqual([]);
    expect(out.view[0].fields.map((f: any) => [f.name, f.bind])).toEqual([["url", "body.url"]]);
    expect(out.view).toHaveLength(1); // no placeholders: no strip, no "opens" line
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

  it("the manifest: kind link with url only, action open, three locales", () => {
    const m = JSON.parse(readFileSync(new URL("./manifest.json", import.meta.url), "utf8"));
    expect(m.contributes.kinds[0]).toMatchObject({ id: "link", tree: "resources", fields: { url: { type: "text" } } });
    expect(m.contributes.kinds[0].fields.profile).toBeUndefined();
    expect(m.contributes.actions[0]).toMatchObject({ id: "open", output: "link" });
    expect(Object.keys(m.contributes.locales)).toEqual(["en-US", "zh-CN", "ja-JP"]);
  });
});

describe("link plugin: a link is a template (D466)", () => {
  const envHost = (env: Record<string, string>) => ({
    ui: { openExternal: vi.fn(async () => undefined) },
    params: { get: vi.fn(async (n: string) => (n in env ? { found: true, value: env[n], sourceName: "Env" } : { found: false })) },
  });
  const url = "https://{{host}}/t/{{tenant_id}}";

  it("opens the address filled from the run's environment; another environment opens another address", async () => {
    const a = envHost({ host: "staging.example.com", tenant_id: "1" });
    await open(a, { "body.url": url });
    expect(a.ui.openExternal).toHaveBeenCalledWith("https://staging.example.com/t/1");
    const b = envHost({ host: "example.com", tenant_id: "9" });
    await open(b, { "body.url": url });
    expect(b.ui.openExternal).toHaveBeenCalledWith("https://example.com/t/9");
  });

  it("a value typed on the tab wins over the environment", async () => {
    const h = envHost({ host: "example.com", tenant_id: "9" });
    await open(h, { "body.url": url }, { params: { tenant_id: "42" } });
    expect(h.ui.openExternal).toHaveBeenCalledWith("https://example.com/t/42");
  });

  it("refuses to open while a placeholder has no value, and names it", async () => {
    const h = envHost({ host: "example.com" });
    await expect(open(h, { "body.url": url })).rejects.toThrow("error.unfilled");
    expect(h.ui.openExternal).not.toHaveBeenCalled();
  });

  it("the page shows each placeholder with the environment's value, and the address that would open", async () => {
    const out = await registry(plugin).pages.editor.render(ctxOf(envHost({ host: "example.com", tenant_id: "9" }), { draft: { "body.url": url } }));
    expect(checkView(out.view)).toEqual([]);
    expect(out.view[0].fields.map((f: any) => [f.name, f.envValue])).toEqual([["host", "example.com"], ["tenant_id", "9"]]);
    expect(out.view.at(-1)).toMatchObject({ type: "text", id: "resolved" });
  });
});
