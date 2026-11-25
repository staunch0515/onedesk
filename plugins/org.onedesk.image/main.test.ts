import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-ignore plain JS module, no types
import plugin, { imageOf, widthOf } from "./main.js";
import { checkView, onlyKeys, registry, RENDER_KEYS, t } from "../_testing/view-check";

const manifest = JSON.parse(readFileSync(new URL("./manifest.json", import.meta.url), "utf8"));
const BLOB = "a".repeat(64);
const img = { blob: BLOB, name: "circuit.png", type: "image/png", size: 1200, width: 640, height: 480 };

describe("image plugin (D484 §16)", () => {
  it("the page is the image field; the interface draws and reads it", () => {
    const out = registry(plugin).pages.image.render({ t, resource: { id: "r", body: { image: img } } });
    expect(checkView(out.view)).toEqual([]);
    expect(onlyKeys(out, RENDER_KEYS)).toEqual([]);
    expect(out.view[0].fields[0]).toMatchObject({ name: "image", kind: "attachment", bind: "body.image" });
  });
  it("embedded, it shows the image at the width asked for, with the description under it; without an image it says so", () => {
    const { kinds } = registry(plugin);
    const ctx = { t, resource: { id: "r", name: "Circuit", description: "The main board", body: { image: img } } };
    const out = kinds.image.embed(ctx, { section: null });
    expect(checkView(out.view)).toEqual([]);
    expect(out.view[0]).toEqual({ type: "image", id: "image", blob: BLOB, alt: "Circuit", width: "medium" });
    expect(out.view[1]).toMatchObject({ type: "text", text: "The main board" });
    expect(kinds.image.embed(ctx, { args: { 宽: "小" } }).view[0].width).toBe("small");
    expect(kinds.image.embed({ t, resource: { id: "r", name: "x", body: { image: null } } }, {}).view[0].id).toBe("empty");
  });
  it("widths by name in either language; anything else is medium", () => {
    expect([widthOf({ 宽: "大" }), widthOf({ width: "Original" }), widthOf({ 宽: "huge" }), widthOf(undefined)]).toEqual(["large", "original", "medium", "medium"]);
    expect(imageOf({ image: { blob: 1 } })).toBeNull();
  });
  it("declares an image field, an embed view, and New; every key in every language", () => {
    const k = manifest.contributes.kinds[0];
    expect(k).toMatchObject({ id: "image", embed: true, draggable: true, fields: { image: { type: "attachment", accept: ["image"] } } });
    expect(manifest.contributes.menus.new).toEqual(["image"]);
    const keys = ["plugin.name", "plugin.description", "kind.image", "kind.image.new", "field.image", "action.save", "embed.empty"];
    for (const f of ["en-US", "zh-CN", "ja-JP"]) {
      const l = JSON.parse(readFileSync(new URL(`./locales/${f}.json`, import.meta.url), "utf8"));
      for (const key of keys) expect(l[key], `${f} ${key}`).toBeTruthy();
    }
  });
});
