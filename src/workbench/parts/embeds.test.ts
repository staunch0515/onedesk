import { describe, expect, it } from "vitest";
import { refOf, splitMark } from "./embeds";
import type { RefInfo } from "../protocol";

const ref = (text: string, target?: { id: string; name: string }, section?: string): RefInfo =>
  ({ source: { id: "s", name: "S" }, field: "body.text", text, target, state: target ? "ok" : "missing", embed: true, section }) as RefInfo;

describe("embeds (D481)", () => {
  it("reads name#section like the kernel", () => {
    expect(splitMark("劳动法#第三十六条")).toEqual(["劳动法", "第三十六条"]);
    expect(splitMark("C#")).toEqual(["C#", undefined]);
    expect(splitMark("#x")).toEqual(["#x", undefined]);
  });
  it("finds a mark's reference as written, or by the target's new name after a rename", () => {
    const refs = [ref("Law#Art 36", { id: "1", name: "Labour Law" }, "Art 36"), ref("Gone")];
    expect(refOf(refs, "Law#Art 36")?.target?.id).toBe("1");
    expect(refOf(refs, "Labour Law#Art 36")?.target?.id).toBe("1");
    expect(refOf(refs, "Gone")?.state).toBe("missing");
    expect(refOf(refs, "Nothing")).toBeUndefined();
  });
});
