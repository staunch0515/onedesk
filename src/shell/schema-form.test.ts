import { describe, expect, it } from "vitest";
import type { FieldDef } from "../plugin-api";
import { initialValues, validateParameterRows, validateValues, valuesToData, valuesToInput } from "./schema-form";

const fields: FieldDef[] = [
  { name: "title", label: "标题", type: "text", required: true },
  { name: "body", label: "正文", type: "longtext" },
  { name: "count", label: "数量", type: "number", default: 3 },
  { name: "site", label: "网址", type: "url" },
  { name: "on", label: "开关", type: "boolean" },
  { name: "mode", label: "模式", type: "select", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] },
  { name: "ref", label: "引用", type: "reference" },
  { name: "params", label: "参数", type: "parameter" },
];

describe("schema 表单：初始值", () => {
  it("每种字段类型转成编辑值；默认值只在 useDefaults 时填入", () => {
    const body = { title: "x", count: 5, on: true, params: [{ name: "p", default: "d", required: true }], extra: 1 };
    expect(initialValues(fields, body)).toEqual({
      title: "x",
      body: "",
      count: "5",
      site: "",
      on: true,
      mode: "",
      ref: "",
      params: [{ name: "p", label: "", default: "d", required: true }],
    });
    expect(initialValues(fields, {}).count).toBe("");
    expect(initialValues(fields, {}, true).count).toBe("3");
  });
});

describe("schema 表单：转回数据", () => {
  it("空值省略、数字转换、保留 schema 之外的键、参数行去空", () => {
    const values = initialValues(fields, { title: "x", extra: 1 });
    values.count = " 7 ";
    values.site = " https://a.com ";
    values.params = [
      { name: " p ", label: " 名 ", default: "", required: false },
      { name: "", label: "", default: "", required: false },
    ];
    expect(valuesToData(fields, values, { title: "old", body: "old", extra: 1 })).toEqual({
      title: "x",
      count: 7,
      site: "https://a.com",
      on: false,
      params: [{ name: "p", label: "名" }],
      extra: 1,
    });
  });

  it("动作输入：文本字段总是字符串（空串交给默认值处理）", () => {
    const input: FieldDef[] = [
      { name: "a", label: "A", type: "text" },
      { name: "n", label: "N", type: "number" },
    ];
    expect(valuesToInput(input, { a: "", n: "" })).toEqual({ a: "" });
    expect(valuesToInput(input, { a: "x", n: "2" })).toEqual({ a: "x", n: 2 });
  });
});

describe("schema 表单：校验", () => {
  it("必填、数字、网址、选项", () => {
    const values = initialValues(fields, {});
    values.count = "abc";
    values.site = "ftp://x";
    values.mode = "z";
    const errors = validateValues(fields, values);
    expect(Object.keys(errors).sort()).toEqual(["count", "mode", "site", "title"]);
    expect(errors.title).toContain("标题");
  });

  it("合法值没有错误；mailto 和 http 网址都接受", () => {
    const values = initialValues(fields, { title: "x", count: 1, site: "mailto:a@b.c", mode: "a" });
    expect(validateValues(fields, values)).toEqual({});
    values.site = "http://localhost:8080/x";
    expect(validateValues(fields, values)).toEqual({});
  });

  it("参数：名字格式、重复、缺名", () => {
    const row = (name: string, extra: Partial<{ label: string }> = {}) => ({ name, label: extra.label ?? "", default: "", required: false });
    expect(validateParameterRows([row("a"), row("b_1")])).toBeUndefined();
    expect(validateParameterRows([row("1a")])).toMatch(/参数名/);
    expect(validateParameterRows([row("a"), row("a")])).toMatch(/重复/);
    expect(validateParameterRows([row("", { label: "x" })])).toMatch(/第 1 行/);
    expect(validateParameterRows([row("")])).toBeUndefined();
  });
});
