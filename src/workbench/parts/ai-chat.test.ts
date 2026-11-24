import { describe, expect, it } from "vitest";
import { clashes, conversationOf, targetInput } from "./ai-chat";
import type { ViewNode } from "../protocol";

describe("AI chat in the shell (D479)", () => {
  it("hands over what the target tab shows: saved values under typed ones, never a secret, nothing for a tab that is not open", () => {
    const s = {
      bases: { t1: { "body.text": "saved", "body.key": "", name: "N" } },
      drafts: { t1: { "body.text": "typed", "body.key": "sk-123", description: "Write release notes" } },
      fieldKinds: { t1: { "body.text": "longtext", "body.key": "secret", name: "text" } },
    };
    expect(targetInput(s, "t1")).toEqual({ "target.draft": { "body.text": "typed", name: "N" }, "target.description": "Write release notes" });
    expect(targetInput(s, "t2")).toEqual({});
  });
  it("tells which values would replace unsaved typing", () => {
    expect(clashes({ "body.text": "mine", name: "same" }, { "body.text": "ai", name: "same", other: "x" })).toEqual(["body.text"]);
    expect(clashes(undefined, { a: "b" })).toEqual([]);
  });
  it("finds the conversation of a page", () => {
    const view = [{ type: "text", id: "a", text: "x" }, { type: "conversation", id: "c", turns: [] }] as unknown as ViewNode[];
    expect(conversationOf(view)?.id).toBe("c");
    expect(conversationOf([])).toBeUndefined();
  });
});
