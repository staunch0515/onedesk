import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-ignore plain JS modules, no types
import plugin, { valuesOf } from "./main.js";
// @ts-ignore
import { analyze, compute, format, pretty, toNumber } from "./expr.js";
import { checkView, onlyKeys, registry, RENDER_KEYS } from "../_testing/view-check";

const manifest = JSON.parse(readFileSync(new URL("./manifest.json", import.meta.url), "utf8"));
const locale = (f: string) => JSON.parse(readFileSync(new URL(`./locales/${f}.json`, import.meta.url), "utf8"));
const ZH = locale("zh-CN");
const EN = locale("en-US");
const t = (key: string) => ({ "en-US": EN[key] ?? key, "zh-CN": ZH[key] ?? key });
const env: Record<string, string> = { 室温: "25" };
const host = { params: { get: async (n: string) => (n in env ? { found: true, value: env[n] } : { found: false }) } };
const ctx = (body: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ t, locale: "zh-CN", host, params: {}, resource: { id: "f", body }, ...extra });
const C2F = { text: "K = C + 273.15\nF = C * 9 / 5 + 32", unit: "°F", decimals: 1, "param.C.label": "摄氏温度", "param.C.unit": "°C", "param.C.default": "20" };

describe("expressions (D487 §17.3)", () => {
  it("reads lines, finds the parameters, computes in the usual order", () => {
    const a = analyze("K = C + 273.15\nF = C * 9 / 5 + 32");
    expect([a.params, a.result]).toEqual([["C"], "F"]);
    const r = compute(a, { C: "37" });
    expect(r.steps.map((s: any) => format(s.value, 2))).toEqual(["310.15", "98.6"]);
    const v = (src: string, vals = {}) => compute(analyze(src), vals).result;
    expect([v("y = 2 + 3 * 4"), v("y = (2 + 3) * 4"), v("y = -2^2"), v("y = 2^3^2"), v("y = 7 % 3"), v("y = 6 × 2 ÷ 4")]).toEqual([14, 20, -4, 512, 1, 3]);
    expect([v("y = round(2.345, 2)"), v("y = max(1, 5, 3)"), v("y = sqrt(16) + abs(-1)"), v("y = pow(2, 10)"), v("y = round(pi, 4)")]).toEqual([2.35, 5, 5, 1024, 3.1416]);
    expect(v("BMI = 体重 / 身高^2", { 体重: "70", 身高: "1.75" })).toBeCloseTo(22.857, 3);
    // Comments and empty lines are skipped; a name defined earlier is no parameter.
    expect(analyze("# note\n\na = x * 2\nb = a + y").params).toEqual(["x", "y"]);
  });

  it("says what is wrong, in words a person understands", () => {
    expect(analyze("F = sqr(C)").error).toEqual({ key: "unknownFunctionLike", vars: { line: 1, name: "sqr", like: "sqrt" } });
    expect(analyze("F = zzzz(C)").error.key).toBe("unknownFunction");
    expect(analyze("x = 1 +").error).toEqual({ key: "syntax", vars: { line: 1 } });
    expect(analyze("just words").error.key).toBe("noEquals");
    expect(analyze("1x = 2").error.key).toBe("badName");
    expect(analyze("x = 2 $").error.key).toBe("badChar");
    expect(analyze("").error.key).toBe("empty");
    expect(analyze("x = " + "(".repeat(40) + "1" + ")".repeat(40)).error.key).toBe("tooDeep");
    expect(analyze("x = 1\n".repeat(51)).error.key).toBe("tooManyLines");
    expect(analyze("x = " + "1+".repeat(2100) + "1").error.key).toBe("tooLong");
    expect(compute(analyze("y = 1 / x"), { x: "0" }).error).toEqual({ key: "divZero", vars: { line: 1 } });
    expect(compute(analyze("y = x"), {}).error).toEqual({ key: "missing", vars: { name: "x" } });
    expect(compute(analyze("y = x"), { x: "abc" }).error).toEqual({ key: "notNumber", vars: { name: "x", value: "abc" } });
    expect(compute(analyze("y = sqrt(x)"), { x: "-1" }).error.key).toBe("notFinite");
  });

  it("numbers: as written; results to the places asked, without trailing zeros or separators", () => {
    expect([toNumber(" 37 "), toNumber("-3.5"), toNumber("1.2e3"), toNumber("1,000"), toNumber("")]).toEqual([37, -3.5, 1200, null, null]);
    expect([format(98.6, 1), format(77, 1), format(1234567.891, 2), format(-0.0001, 2), format(2 / 3, 3), format(310.15, 1), format(-2.5, 0)]).toEqual(["98.6", "77", "1234567.89", "0", "0.667", "310.2", "-3"]);
    expect(pretty("F = C*9/5 + x^2")).toBe("F = C × 9 ÷ 5 + x²");
  });
});

describe("the formula plugin (D487 §17.3)", () => {
  it("called inline: the result with its unit; defaults, from the environment too; errors as words", async () => {
    const { kinds } = registry(plugin);
    expect(await kinds.formula.embed(ctx(C2F), { inline: true, args: { C: "37" } })).toEqual({ text: "98.6 °F" });
    expect(await kinds.formula.embed(ctx(C2F), { inline: true, args: {} })).toEqual({ text: "68 °F" });
    expect(await kinds.formula.embed(ctx({ ...C2F, "param.C.default": "{{室温}}" }), { inline: true })).toEqual({ text: "77 °F" });
    expect(await kinds.formula.embed(ctx({ ...C2F, "param.C.default": "" }), { inline: true })).toEqual({ text: "缺少参数 C", error: true });
    expect(await kinds.formula.embed(ctx(C2F), { inline: true, args: { D: "1" } })).toEqual({ text: "没有参数 D", error: true });
    expect(await kinds.formula.embed(ctx(C2F), { inline: true, args: { C: "热" } })).toEqual({ text: "“热”不是数字（参数 C）", error: true });
    // A book's contents hands over its own `book` argument: not a parameter.
    expect(await kinds.formula.embed(ctx(C2F), { inline: true, args: { book: { prefix: "1" } } })).toEqual({ text: "68 °F" });
  });

  it("as a block: the formula and its parameters; with values, worked out", async () => {
    const { kinds } = registry(plugin);
    const plain = await kinds.formula.embed(ctx(C2F), {});
    expect(checkView(plain.view)).toEqual([]);
    expect(plain.view[0].text).toContain("`F = C × 9 ÷ 5 + 32`");
    expect(plain.view[0].text).toContain("C——摄氏温度，°C（默认 20）");
    const worked = await kinds.formula.embed(ctx(C2F), { args: { C: "37" } });
    expect(worked.view[1].text).toContain("- C = 37 °C");
    expect(worked.view[1].text).toContain("- K = 310.2");
    expect(worked.view[1].text).toContain("**F = 98.6 °F**");
    const broken = await kinds.formula.embed(ctx({ text: "F = (" }), {});
    expect(broken.view[0].tone).toBe("danger");
  });

  it("D487 §19: where it is embedded, the reader tries other values and computes (nothing is saved)", async () => {
    const { kinds } = registry(plugin);
    const plain = await kinds.formula.embed(ctx(C2F), {});
    expect(plain.actions).toEqual([{ id: "compute", label: t("action.compute"), icon: "calculator" }]);
    expect(plain.view.find((n: any) => n.id === "try").fields.map((f: any) => [f.name, f.bind])).toEqual([["C", undefined]]);
    expect(plain.values).toEqual({ C: "20" });
    const r = await kinds.formula.embedAct(ctx(C2F), { action: "compute", values: { C: "100" } });
    expect(checkView(r.view)).toEqual([]);
    expect(r.view.find((n: any) => n.id === "worked").text).toContain("**F = 212 °F**");
    expect(r.values).toEqual({ C: "100" });
    const bad = await kinds.formula.embedAct(ctx(C2F), { action: "compute", values: { C: "热" } });
    expect(bad.view.find((n: any) => n.id === "worked").tone).toBe("danger");
  });

  it("the page: formula, unit and places, one row per parameter found, trying values on the tab", async () => {
    const { pages } = registry(plugin);
    const out = await pages.formula.render(ctx(C2F, { params: { "try.C": "37" } }));
    expect(checkView(out.view)).toEqual([]);
    expect(onlyKeys(out, RENDER_KEYS)).toEqual([]);
    expect(out.view.map((n: any) => n.id)).toEqual(["formula", "result", "param-C", "try", "outcome"]);
    expect(out.view[2].fields.map((f: any) => f.bind)).toEqual(["body.param.C.label", "body.param.C.unit", "body.param.C.default"]);
    expect(out.view[3].fields[0]).toMatchObject({ name: "try.C", param: true, placeholder: "20" });
    expect(out.view[4].text).toBe("K = 310.2\nF = 98.6 °F");
    // Typed but not saved: a new parameter shows at once.
    const draft = await pages.formula.render(ctx(C2F, { draft: { "body.text": "y = a + b" } }));
    expect(draft.view.filter((n: any) => String(n.id).startsWith("param-")).map((n: any) => n.id)).toEqual(["param-a", "param-b"]);
    expect(draft.view.find((n: any) => n.id === "outcome").tone).toBe("danger");
    const bad = await pages.formula.render(ctx({ text: "y = sqr(2)" }));
    expect(bad.view[2]).toMatchObject({ id: "error", tone: "danger" });
    expect(bad.view[2].text).toContain("是不是 sqrt");
  });

  it("values: given over defaults; only parameters", async () => {
    const a = analyze("y = a + b");
    expect(await valuesOf(ctx({}), { "param.a.default": "1", "param.b.default": "{{室温}}" }, a, { a: "5" })).toEqual({ values: { a: "5", b: "25" } });
  });

  it("in a book it is a calculation page; the manifest and every language", async () => {
    const { actions } = registry(plugin);
    expect((await actions.roles({}, {})).data.kinds).toEqual([{ kind: "formula", role: "calc", part: "body", single: false, container: false, numbering: "level" }]);
    expect(manifest.implements["onedesk.book/1"]).toEqual({ actions: ["roles", "outline"], kind: "formula" });
    expect(manifest.contributes.kinds[0]).toMatchObject({ id: "formula", embed: true, draggable: true });
    for (const f of ["zh-CN", "ja-JP"]) expect(Object.keys(locale(f)).sort(), f).toEqual(Object.keys(EN).sort());
  });
});
