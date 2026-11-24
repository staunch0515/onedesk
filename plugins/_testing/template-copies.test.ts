import { readFileSync, readdirSync, existsSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
// @ts-ignore plain JS module, no types
import { fillHoles, filled, holeNames, holeStrip, holeValues } from "../org.onedesk.note/template.js";

// D466: every plugin that fills templates carries its own copy of template.js (a plugin can only import its own
// files). The copies must stay the same file.
const ROOT = new URL("..", import.meta.url);
const copies = readdirSync(ROOT).filter((d) => !d.startsWith("._") && existsSync(new URL(`${d}/template.js`, ROOT)));

describe("template.js (D466)", () => {
  it("is the same file in every plugin that has it", () => {
    expect(copies.length).toBeGreaterThan(5);
    const first = readFileSync(new URL(`${copies[0]}/template.js`, ROOT), "utf8");
    for (const d of copies) expect(readFileSync(new URL(`${d}/template.js`, ROOT), "utf8"), d).toBe(first);
  });

  it("names: once each, in order; secrets, spaces, empty and over-long names are not placeholders", () => {
    expect(holeNames("{{a}} {{b.c}} {{a}} {{中文}} {{x-y_1}}", "{{d}}")).toEqual(["a", "b.c", "中文", "x-y_1", "d"]);
    expect(holeNames("{{secret:k}} {{ s }} {{}} {{" + "x".repeat(65) + "}} {one}")).toEqual([]);
  });

  it("fill: only names with a value; the rest stay as written; $ patterns are literal", () => {
    expect(fillHoles("{{a}} {{b}}", { a: "1", b: "" })).toBe("1 {{b}}");
    expect(fillHoles("{{a}}", { a: "$&$1" })).toBe("$&$1");
  });

  const host = (env: Record<string, string>) => ({ params: { get: vi.fn(async (n: string) => (n in env ? { found: true, value: env[n], sourceName: "Staging" } : { found: false })) } });

  it("values: typed on the tab first, then the environment; in a run only the run's parameters", async () => {
    const ctx = { host: host({ a: "env-a", b: "env-b" }), params: { a: "typed" } };
    expect(await holeValues(ctx, ["a", "b", "c"])).toEqual({ values: { a: "typed", b: "env-b" }, sources: { b: "Staging" } });
    const run = { host: host({ a: "env" }), run: { params: { a: "from-run" } } };
    expect((await holeValues(run, ["a", "b"])).values).toEqual({ a: "from-run" });
    expect(await filled({ host: host({ who: "Ann" }) }, "Hi {{who}} {{x}}")).toBe("Hi Ann {{x}}");
  });

  it("strip: one page-parameter field per name with the environment's value; read only in a run; none without names", async () => {
    expect(await holeStrip({ host: host({}) }, [])).toBeNull();
    const s = await holeStrip({ host: host({ a: "1" }) }, ["a", "b"]);
    expect(s.fields).toEqual([{ name: "a", label: "a", kind: "text", param: true, envValue: "1", envSource: "Staging" }, { name: "b", label: "b", kind: "text", param: true }]);
    const r = await holeStrip({ host: host({}), run: { params: { a: "x" } } }, ["a"]);
    expect(r.fields[0]).toMatchObject({ envValue: "x", readOnly: true });
  });
});
