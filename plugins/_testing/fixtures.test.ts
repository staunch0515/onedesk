/** Checks of the install / upgrade fixtures in e2e/fixtures (they are test packages, not built-in plugins). */
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
// @ts-ignore plain JS module, no types
import v2 from "../../e2e/fixtures/plugins/org.onedesk.sample/0.2.0/main.js";
// @ts-ignore plain JS module, no types
import v3 from "../../e2e/fixtures/plugins/org.onedesk.sample/0.3.0/main.js";
import { checkView, registry } from "./view-check";

const dir = (p: string) => new URL(`../../e2e/fixtures/plugins/${p}`, import.meta.url);
const json = (p: string) => JSON.parse(readFileSync(dir(p), "utf8"));
const locale = (v: string, l: string) => json(`org.onedesk.sample/${v}/locales/${l}.json`) as Record<string, string>;
const t = (v: string) => (key: string) => ({ "en-US": locale(v, "en-US")[key], "zh-CN": locale(v, "zh-CN")[key] });

describe("fixture: sample 0.2.0", () => {
  const m = json("org.onedesk.sample/0.2.0/manifest.json");
  it("is version 0.2.0, upgrades 0.1.x and asks for one more permission (network, one fixed host)", () => {
    expect(m).toMatchObject({ id: "org.onedesk.sample", version: "0.2.0", upgradesFrom: ">=0.1.0, <0.2.0" });
    expect(m.requires.network).toEqual({ hosts: ["example.com"] });
  });
  it("migrate adds a note naming the old version and keeps the rest of the body", () => {
    const { kinds } = registry(v2);
    expect(kinds.query.migrate({ text: "select 1", extra: 1 }, "0.1.0")).toEqual({ text: "select 1", extra: 1, note: "migrated from 0.1.0" });
  });
  it("migrate is pure: it needs no host and does not mutate its input", () => {
    const { kinds } = registry(v2);
    const body = { text: "x" };
    kinds.query.migrate(body, "0.1.0");
    expect(body).toEqual({ text: "x" });
  });
  it("the page shows the note", async () => {
    const { pages } = registry(v2);
    const host = { params: { get: async () => ({ found: false, value: "", sourceName: "" }) }, storage: { get: vi.fn(async () => null) } };
    const out = await pages.editor.render({ locale: "en-US", host, t: t("0.2.0"), resource: { body: { text: "", note: "migrated from 0.1.0" } } });
    expect(checkView(out.view)).toEqual([]);
    expect(out.view.find((n: any) => n.id === "note")).toMatchObject({ type: "text", text: "Note: migrated from 0.1.0" });
    const none = await pages.editor.render({ locale: "en-US", host, t: t("0.2.0"), resource: { body: { text: "" } } });
    expect(none.view.find((n: any) => n.id === "note")).toBeUndefined();
  });
  it("has the same locale keys in both languages", () => {
    expect(Object.keys(locale("0.2.0", "en-US")).sort()).toEqual(Object.keys(locale("0.2.0", "zh-CN")).sort());
  });
});

describe("fixture: sample 0.3.0 (migrate fails on purpose)", () => {
  it("upgrades 0.1.x and later and its migrate throws", () => {
    const m = json("org.onedesk.sample/0.3.0/manifest.json");
    expect(m).toMatchObject({ version: "0.3.0", upgradesFrom: ">=0.1.0" });
    const { kinds } = registry(v3);
    expect(() => kinds.query.migrate({ text: "x" }, "0.1.0")).toThrow("migrate failed on purpose");
  });
});

describe("fixture: broken package", () => {
  it("is valid JSON with a field the strict manifest check rejects, and it is not under plugins/", () => {
    const m = json("broken/manifest.json");
    expect(m.unknownField).toBe(true);
    expect(readdirSync(new URL("../", import.meta.url)).includes("broken")).toBe(false);
  });
});
