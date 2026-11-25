import { describe, expect, it } from "vitest";
import { insertPick, openMark } from "./ref-completion";

describe("typing a reference (D482)", () => {
  it("finds the reference being typed at the caret, for links, embeds and calls", () => {
    expect(openMark("see [[Chap", 10)).toEqual({ start: 6, query: "Chap" });
    expect(openMark("x ![[Book B/Ch", 14)).toEqual({ start: 5, query: "Book B/Ch" });
    expect(openMark("[[=Rate", 7)).toEqual({ start: 3, query: "Rate" });
    expect(openMark("[[", 2)).toEqual({ start: 2, query: "" });
  });
  it("is not open after it was closed, across lines, when escaped, or once a section or parameters are written", () => {
    expect(openMark("[[Done]] and", 12)).toBeNull();
    expect(openMark("[[a\nb", 5)).toBeNull();
    expect(openMark("\\[[not", 6)).toBeNull();
    expect(openMark("[[Law#Art", 9)).toBeNull();
    expect(openMark("[[f | x", 7)).toBeNull();
    expect(openMark("[[C\\#", 5)).toEqual({ start: 2, query: "C\\#" });
  });
  it("puts the chosen writing in and closes it; an existing ]] is kept, not doubled", () => {
    expect(insertPick("see [[Chap tail", 10, 6, "Book B/Chapter 1")).toEqual({ text: "see [[Book B/Chapter 1]] tail", caret: 24 });
    expect(insertPick("[[Ch]]", 4, 2, "Chapter 1")).toEqual({ text: "[[Chapter 1]]", caret: 13 });
  });
});
