import { describe, expect, it } from "vitest";
import type { ViewField } from "../protocol";
import { runParams } from "./run-params";

const field = (name: string, envValue?: string): ViewField => ({ name, label: name, kind: "text", param: true, envValue });

describe("runParams", () => {
  it("sends only what the user entered on kernel pages, not the environment's placeholder", () => {
    expect(runParams([field("a", "from-env"), field("b", "env-b"), field("c")], { b: "mine" }, true)).toEqual({ b: "mine" });
  });

  it("keeps the displayed value for demo pages", () => {
    expect(runParams([field("a", "from-env"), field("b")], {}, false)).toEqual({ a: "from-env", b: "" });
  });
});
