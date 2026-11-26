import { describe, expect, it } from "vitest";
import { tokenizeJs, tokenizeJson, tokenizeSql } from "./sql-tokens";

const join = (t: { text: string }[]) => t.map((x) => x.text).join("");
const kinds = (t: { text: string; kind?: string }[]) => t.filter((x) => x.kind).map((x) => `${x.kind}:${x.text}`);

describe("code colours", () => {
  it("never lose or add text", () => {
    const js = "import { a } from './a.js';\n// note\nexport async function run(x) { return a(x, 1.5, `t${x}`); } /* end";
    expect(join(tokenizeJs(js))).toBe(js);
    const json = '{ "id": "org.x", "n": -1.2e3, "ok": true, "v": null, "bad": "unterminated\n}';
    expect(join(tokenizeJson(json))).toBe(json);
    expect(join(tokenizeSql("select 1 -- x"))).toBe("select 1 -- x");
  });
  it("javascript: keywords, strings, numbers, comments, calls", () => {
    expect(kinds(tokenizeJs("const x = f('a', 2); // c"))).toEqual(["keyword:const", "operator:=", "function:f", "string:'a'", "operator:,", "number:2", "operator:);", "comment:// c"]);
  });
  it("json: keys apart from values", () => {
    expect(kinds(tokenizeJson('{"id": "x", "n": 1, "on": false}'))).toEqual(['param:"id"', 'string:"x"', 'param:"n"', "number:1", 'param:"on"', "keyword:false"]);
  });
});
