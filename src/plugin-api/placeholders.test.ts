import { describe, expect, it } from "vitest";
import { extractPlaceholders, fillPlaceholders, lintPlaceholders } from "./placeholders";

describe("placeholders", () => {
  it("extracts {{name}} in order, deduplicated, tolerating inner spaces", () => {
    expect(extractPlaceholders("Hi {{name}}, {{ topic }} and {{name}}")).toEqual(["name", "topic"]);
  });

  it("fills values and reports every missing name", () => {
    expect(fillPlaceholders("翻译成{{lang}}：{{text}}", { lang: "英文", text: "你好" })).toBe("翻译成英文：你好");
    expect(() => fillPlaceholders("{{a}} {{b}} {{c}}", { b: "x" })).toThrow("缺少参数：a、c");
  });

  it("accepts clean templates", () => {
    expect(lintPlaceholders("Write about {{topic}} in {{lang}}. Price: 5 USD. https://x.io:8080/a")).toEqual([]);
  });

  // Every rejection case has its own test (err on the side of rejecting).
  it("rejects $name", () => {
    expect(lintPlaceholders("Hello $name")).toHaveLength(1);
  });
  it("rejects ${name}", () => {
    expect(lintPlaceholders("Hello ${name}")).toHaveLength(1);
  });
  it("rejects :name", () => {
    expect(lintPlaceholders("WHERE id = :id")).toHaveLength(1);
  });
  it("rejects malformed {{ }}", () => {
    expect(lintPlaceholders("Hello {{ }}")).toHaveLength(1);
    expect(lintPlaceholders("Hello {{1abc}}")).toHaveLength(1);
    expect(lintPlaceholders("Hello {{name")).toHaveLength(1);
  });
});
