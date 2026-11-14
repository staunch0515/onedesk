import { describe, expect, it } from "vitest";
import { ManifestSchema, ViewTreeSchema } from "@onedesk/plugin-api";
import { activatePlugin } from "../testing/fake-host";
import manifestJson from "./manifest.json";
import plugin from "./index";

const setup = () => activatePlugin(plugin, { pluginId: "org.onedesk.link" });

describe("link plugin", () => {
  it("manifest is valid and matches what is registered", async () => {
    const manifest = ManifestSchema.parse(manifestJson);
    expect(manifest.apiVersion).toBe("1");
    const host = await setup();
    expect([...host.registered.kinds.keys()]).toEqual(manifest.provides.kinds);
    expect([...host.registered.actions.keys()]).toEqual(manifest.provides.actions);
    expect([...host.registered.views.keys()]).toEqual(manifest.provides.views);
    const kind = host.registered.kinds.get("link")!;
    expect(kind.defaultAction).toBe("open");
    expect(kind.views.every((v) => host.registered.views.has(v))).toBe(true);
    expect(host.registered.actions.get("open")!.kinds).toEqual(["link"]);
  });

  it("open: calls openExternal with the url and profile", async () => {
    const host = await setup();
    const r = host.makeResource("link", { url: "https://example.com/a", profile: "工作" });
    const result = await host.runAction("open", r);
    expect(result.status).toBe("success");
    expect(result.output?.type).toBe("none");
    expect(host.opened).toEqual([{ url: "https://example.com/a", options: { profile: "工作" } }]);
  });

  it("open: works without a profile", async () => {
    const host = await setup();
    const result = await host.runAction("open", host.makeResource("link", { url: "mailto:a@b.co" }));
    expect(result.status).toBe("success");
    expect(host.opened[0]?.url).toBe("mailto:a@b.co");
  });

  it.each([
    ["missing", {}],
    ["empty", { url: "  " }],
    ["file scheme", { url: "file:///etc/passwd" }],
    ["javascript scheme", { url: "javascript:alert(1)" }],
    ["not a url", { url: "https://" }],
  ])("open: rejects an invalid url (%s)", async (_name, body) => {
    const host = await setup();
    const result = await host.runAction("open", host.makeResource("link", body));
    expect(result.status).toBe("error");
    expect(result.error?.code).toBe("validation");
    expect(host.opened).toHaveLength(0);
  });

  it("open: reports a host failure as an error result", async () => {
    const host = await setup();
    host.failSystemCalls("无法启动浏览器");
    const result = await host.runAction("open", host.makeResource("link", { url: "https://example.com" }));
    expect(result.status).toBe("error");
    expect(result.error?.message).toContain("无法启动浏览器");
  });

  it("validate: flags a bad url and accepts a good one", async () => {
    const kind = (await setup()).registered.kinds.get("link")!;
    expect(kind.validate!({ url: "ftp://x" }).url).toBeTruthy();
    expect(kind.validate!({}).url).toBeTruthy();
    expect(kind.validate!({ url: "https://example.com" })).toEqual({});
  });

  it("details view: form + link node pass ViewTreeSchema", async () => {
    const host = await setup();
    const tree = await host.renderView("details", host.makeResource("link", { url: "https://example.com", profile: "个人" }));
    expect(ViewTreeSchema.safeParse(tree).success).toBe(true);
    expect(JSON.stringify(tree)).toContain("个人");
    expect(Array.isArray(tree) && tree.some((n) => n.type === "link")).toBe(true);
  });

  it("details view: still valid when the url is unusable (no link node)", async () => {
    const host = await setup();
    const tree = await host.renderView("details", host.makeResource("link", { url: "javascript:x" }));
    expect(ViewTreeSchema.safeParse(tree).success).toBe(true);
    expect(Array.isArray(tree) && tree.some((n) => n.type === "link")).toBe(false);
    const form = Array.isArray(tree) ? tree[0] : tree;
    expect(form).toMatchObject({ type: "form", fields: [{ label: "网址", format: "text" }, expect.anything()] });
  });

  it("describe returns Chinese summary and usage", async () => {
    const host = await setup();
    const d = host.registered.kinds.get("link")!.describe(host.makeResource("link", { url: "https://example.com" }, { name: "官网" }));
    expect(d.summary).toContain("官网");
    expect(d.summary).toContain("https://example.com");
    expect(d.usage).toBeTruthy();
  });
});
