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
    expect(lintPlaceholders("Write about {{topic}} in {{lang}}. Price: 5 USD. https://x.io:8080/a")).toEqual({ errors: [], warnings: [] });
  });

  // Every flagged case has its own test.
  it("warns on $name", () => {
    expect(lintPlaceholders("Hello $name").warnings).toHaveLength(1);
  });
  it("warns on ${name}", () => {
    expect(lintPlaceholders("Hello ${name}").warnings).toHaveLength(1);
  });
  it("warns on :name", () => {
    expect(lintPlaceholders("WHERE id = :id").warnings).toHaveLength(1);
  });
  it("errors on empty {{ }}", () => {
    expect(lintPlaceholders("Hello {{ }}").errors).toHaveLength(1);
  });
  it("errors on name starting with a digit", () => {
    expect(lintPlaceholders("Hello {{1abc}}").errors).toHaveLength(1);
  });
  it("errors on unclosed {{", () => {
    expect(lintPlaceholders("Hello {{name").errors).toHaveLength(1);
  });
  it("does not treat a valid placeholder as foreign syntax", () => {
    expect(lintPlaceholders("{{a}}:{{b}}")).toEqual({ errors: [], warnings: [] });
  });
});
