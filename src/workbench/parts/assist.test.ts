import { describe, expect, it } from "vitest";
import type { ViewField } from "../protocol";
import { assistable } from "./assist";

const field = (over: Partial<ViewField>): ViewField => ({ name: "a", label: "A", kind: "text", bind: "body.a", ...over }) as ViewField;

describe("assistable (D462)", () => {
  it("editable text, longtext and code fields get “Write with AI”", () => {
    for (const kind of ["text", "longtext", "code"] as const) expect(assistable(field({ kind }), false), kind).toBe(true);
  });

  it("not when the plugin says assist.off, nor for read-only, parameter, other kinds or a read-only page", () => {
    expect(assistable(field({ assist: { off: true } }), false)).toBe(false);
    expect(assistable(field({ assist: { off: false } }), false)).toBe(true);
    expect(assistable(field({ readOnly: true }), false)).toBe(false);
    expect(assistable(field({ param: true }), false)).toBe(false);
    expect(assistable(field({ kind: "number" }), false)).toBe(false);
    expect(assistable(field({}), true)).toBe(false);
  });
});
