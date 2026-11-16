import { describe, expect, it } from "vitest";
import type { ViewField } from "../protocol";
import { applyPageParams, runParams } from "./run-params";

const field = (name: string, envValue?: string): ViewField => ({ name, label: name, kind: "text", param: true, envValue });

describe("runParams", () => {
  it("sends only what the user entered on kernel pages, not the environment's placeholder", () => {
    expect(runParams([field("a", "from-env"), field("b", "env-b"), field("c")], { b: "mine" }, true)).toEqual({ b: "mine" });
  });

  it("keeps the displayed value for demo pages", () => {
    expect(runParams([field("a", "from-env"), field("b")], {}, false)).toEqual({ a: "from-env", b: "" });
  });
});

describe("applyPageParams", () => {
  it("applies only keys of the page's own param fields and drops the rest", () => {
    expect(applyPageParams([field("pick"), field("other")], { pick: "/a", other: "x" }, { pick: "", stray: "y", "body.text": "z" })).toEqual({ pick: "", other: "x" });
  });

  it("clears with an empty string, ignores non-strings, and returns null when nothing applies", () => {
    expect(applyPageParams([field("pick")], { pick: "/a" }, { pick: "" })).toEqual({ pick: "" });
    expect(applyPageParams([field("pick")], { pick: "/a" }, { pick: 3 as unknown as string })).toBeNull();
    expect(applyPageParams([field("pick")], { pick: "/a" }, { stray: "y" })).toBeNull();
    expect(applyPageParams([field("pick")], {}, undefined)).toBeNull();
  });
});
