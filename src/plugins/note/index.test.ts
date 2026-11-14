import { describe, expect, it } from "vitest";
import { ManifestSchema, ViewTreeSchema } from "@onedesk/plugin-api";
import { activatePlugin } from "../testing/fake-host";
import manifestJson from "./manifest.json";
import plugin from "./index";

const setup = () => activatePlugin(plugin, { pluginId: "org.onedesk.note" });

describe("note plugin", () => {
  it("manifest is valid and matches what is registered", async () => {
    const manifest = ManifestSchema.parse(manifestJson);
    const host = await setup();
    expect([...host.registered.kinds.keys()]).toEqual(manifest.provides.kinds);
    expect([...host.registered.actions.keys()]).toEqual(manifest.provides.actions);
    expect([...host.registered.views.keys()]).toEqual(manifest.provides.views);
    expect(host.registered.kinds.get("note")!.views.every((v) => host.registered.views.has(v))).toBe(true);
  });

  it("markdown view renders content as a markdown text node", async () => {
    const host = await setup();
    const tree = await host.renderView("markdown", host.makeResource("note", { content: "# 标题\n\n- 一\n- 二" }));
    expect(ViewTreeSchema.parse(tree)).toEqual({ type: "text", text: "# 标题\n\n- 一\n- 二", format: "markdown" });
  });

  it.each([["missing", {}], ["blank", { content: "  \n " }]])("markdown view shows a hint when content is %s", async (_n, body) => {
    const host = await setup();
    const tree = await host.renderView("markdown", host.makeResource("note", body));
    const parsed = ViewTreeSchema.parse(tree);
    expect(parsed).toMatchObject({ type: "text", tone: "muted" });
    expect(JSON.stringify(parsed)).toContain("还没有内容");
  });

  it("describe covers empty and non-empty notes", async () => {
    const host = await setup();
    const kind = host.registered.kinds.get("note")!;
    expect(kind.describe(host.makeResource("note", { content: "第一行\n第二行" }, { name: "日记" })).summary).toContain("第一行");
    expect(kind.describe(host.makeResource("note", {}, { name: "空" })).summary).toContain("内容为空");
    expect(kind.describe(host.makeResource("note", {})).usage).toBeTruthy();
  });
});
