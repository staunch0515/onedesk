import { describe, expect, it } from "vitest";
import { mergeDraft, sameValue, staleFields } from "./merge";

describe("mergeDraft", () => {
  const before = { name: "A", "body.text": "hello", tags: ["x"] };

  it("a field changed elsewhere that is not typed here is quiet: nothing to ask", () => {
    const r = mergeDraft(before, { ...before, name: "B" }, { "body.text": "mine" });
    expect(r.changed).toEqual(["name"]);
    expect(r.conflicts).toEqual([]);
  });

  it("a field typed here and changed elsewhere to something else is a conflict", () => {
    const r = mergeDraft(before, { ...before, "body.text": "theirs" }, { "body.text": "mine", name: "C" });
    expect(r.conflicts).toEqual(["body.text"]);
  });

  it("changed elsewhere to exactly what was typed is not a conflict", () => {
    const r = mergeDraft(before, { ...before, "body.text": "mine" }, { "body.text": "mine" });
    expect(r.conflicts).toEqual([]);
    expect(r.converged).toEqual(["body.text"]);
  });

  it("nothing changed elsewhere: nothing to report", () => {
    expect(mergeDraft(before, { ...before }, { name: "mine" })).toEqual({ changed: [], conflicts: [], converged: [] });
  });

  it("compares structured values by content and treats empty as empty", () => {
    expect(sameValue(["x"], ["x"])).toBe(true);
    expect(sameValue(undefined, "")).toBe(true);
    expect(sameValue(1, 2)).toBe(false);
  });

  it("a field that appeared or vanished counts as changed", () => {
    expect(mergeDraft({}, { name: "N" }, { name: "mine" }).conflicts).toEqual(["name"]);
    expect(mergeDraft({ name: "N" }, {}, {}).changed).toEqual(["name"]);
  });
});

describe("staleFields", () => {
  it("reads the fields of a conflict/stale refusal and nothing else", () => {
    expect(staleFields({ code: "conflict", params: { reason: "stale", fields: "name, body.text", rev: "9" } })).toEqual({ fields: ["name", "body.text"], rev: "9" });
    expect(staleFields({ code: "conflict", params: { reason: "dependents" } })).toBeNull();
    expect(staleFields({ code: "conflict", params: { field: "x" } })).toBeNull();
    expect(staleFields(new Error("x"))).toBeNull();
  });
});
