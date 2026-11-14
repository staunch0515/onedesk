import { describe, expect, it } from "vitest";
import { ManifestSchema, ViewTreeSchema } from "@onedesk/plugin-api";
import { activatePlugin } from "../testing/fake-host";
import manifestJson from "./manifest.json";
import plugin from "./index";

const setup = () => activatePlugin(plugin, { pluginId: "org.onedesk.prompt" });

const body = {
  template: "把下面的内容翻译成{{lang}}：{{text}}",
  parameters: [
    { name: "lang", label: "语言", default: "英文" },
    { name: "text", label: "内容", required: true },
  ],
};

describe("prompt plugin", () => {
  it("manifest is valid and matches what is registered", async () => {
    const manifest = ManifestSchema.parse(manifestJson);
    const host = await setup();
    expect([...host.registered.kinds.keys()]).toEqual(manifest.provides.kinds);
    expect([...host.registered.actions.keys()]).toEqual(manifest.provides.actions);
    expect([...host.registered.views.keys()]).toEqual(manifest.provides.views);
    const copy = host.registered.actions.get("copy")!;
    expect(copy.input).toEqual({ fromField: "parameters" });
    expect(copy.kinds).toEqual(["prompt"]);
    expect(host.registered.kinds.get("prompt")!.defaultAction).toBe("copy");
  });

  it("copy: fills values, uses defaults, copies and returns the text", async () => {
    const host = await setup();
    const result = await host.runAction("copy", host.makeResource("prompt", body), { text: "你好" });
    expect(result.status).toBe("success");
    expect(result.output).toMatchObject({ type: "text", text: "把下面的内容翻译成英文：你好" });
    expect(host.copied).toEqual(["把下面的内容翻译成英文：你好"]);
  });

  it("copy: given values override defaults; empty string falls back to the default", async () => {
    const host = await setup();
    const r = host.makeResource("prompt", body);
    await host.runAction("copy", r, { lang: "日文", text: "x" });
    await host.runAction("copy", r, { lang: "", text: "y" });
    expect(host.copied).toEqual(["把下面的内容翻译成日文：x", "把下面的内容翻译成英文：y"]);
  });

  it("copy: an optional parameter without value becomes empty", async () => {
    const host = await setup();
    const r = host.makeResource("prompt", { template: "a{{x}}b", parameters: [{ name: "x" }] });
    const result = await host.runAction("copy", r, {});
    expect(result.output).toMatchObject({ text: "ab" });
  });

  it("copy: fails and does not copy when a required parameter is missing", async () => {
    const host = await setup();
    const result = await host.runAction("copy", host.makeResource("prompt", body), {});
    expect(result.status).toBe("error");
    expect(result.error?.code).toBe("validation");
    expect(result.error?.message).toContain("内容");
    expect(host.copied).toHaveLength(0);
  });

  it("copy: fails when the template uses an undefined parameter", async () => {
    const host = await setup();
    const result = await host.runAction("copy", host.makeResource("prompt", { template: "{{nope}}", parameters: [] }), {});
    expect(result.status).toBe("error");
    expect(result.error?.message).toContain("nope");
  });

  it("copy: fails on a malformed placeholder", async () => {
    const host = await setup();
    const result = await host.runAction("copy", host.makeResource("prompt", { template: "你好 {{name" }), {});
    expect(result.status).toBe("error");
    expect(result.error?.code).toBe("validation");
    expect(result.error?.message).toContain("占位符");
  });

  it("copy: reports a clipboard failure", async () => {
    const host = await setup();
    host.failSystemCalls("剪贴板不可用");
    const result = await host.runAction("copy", host.makeResource("prompt", { template: "hi" }), {});
    expect(result.status).toBe("error");
    expect(result.error?.code).toBe("unavailable");
    expect(result.error?.message).toContain("剪贴板不可用");
  });

  describe("validate", () => {
    it("accepts a consistent template", async () => {
      expect((await setup()).registered.kinds.get("prompt")!.validate!(body)).toEqual({});
    });
    it("blocks malformed placeholders", async () => {
      expect((await setup()).registered.kinds.get("prompt")!.validate!({ template: "{{ }}" }).template).toContain("占位符");
    });
    it("blocks placeholders missing from parameters", async () => {
      const errors = (await setup()).registered.kinds.get("prompt")!.validate!({ template: "{{a}} {{b}}", parameters: [{ name: "a" }] });
      expect(errors.template).toContain("{{b}}");
      expect(errors.template).not.toContain("{{a}}");
    });
    it("does not block $name style warnings", async () => {
      expect((await setup()).registered.kinds.get("prompt")!.validate!({ template: "cost $price", parameters: [] })).toEqual({});
    });
    it("rejects bad or duplicate parameter names and non-list parameters", async () => {
      const validate = (await setup()).registered.kinds.get("prompt")!.validate!;
      expect(validate({ template: "x", parameters: [{ name: "1bad" }] }).parameters).toBeTruthy();
      expect(validate({ template: "x", parameters: [{ name: "a" }, { name: "a" }] }).parameters).toContain("重复");
      expect(validate({ template: "x", parameters: "nope" }).parameters).toBeTruthy();
    });
  });

  it("preview view: template + parameter table pass ViewTreeSchema", async () => {
    const host = await setup();
    const tree = await host.renderView("preview", host.makeResource("prompt", body));
    expect(ViewTreeSchema.safeParse(tree).success).toBe(true);
    const nodes = Array.isArray(tree) ? tree : [tree];
    const table = nodes.find((n) => n.type === "table");
    expect(table && table.type === "table" ? table.rows : []).toHaveLength(2);
    expect(JSON.stringify(tree)).toContain("{{lang}}");
  });

  it("preview view: handles an empty prompt", async () => {
    const host = await setup();
    const tree = await host.renderView("preview", host.makeResource("prompt", {}));
    expect(ViewTreeSchema.safeParse(tree).success).toBe(true);
  });

  it("describe lists the parameters", async () => {
    const host = await setup();
    const kind = host.registered.kinds.get("prompt")!;
    expect(kind.describe(host.makeResource("prompt", body, { name: "翻译" })).summary).toContain("lang、text");
    expect(kind.describe(host.makeResource("prompt", { template: "x" })).summary).toContain("无参数");
  });
});
