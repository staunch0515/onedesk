// @vitest-environment jsdom
import "../../design/testing/jsdom-setup";
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createMockClient } from "../protocol/mock";
import type { ViewNode } from "../protocol";
import { renderInShell } from "../testing/harness";
import { tableLines, terminalLinesOf, textLines } from "./terminal-lines";
import { ViewNodes } from "./view-nodes";

const client = () => createMockClient({ fresh: true, quiet: true });
const textNode = (extra: object): ViewNode => ({ type: "text", id: "t", text: "ok\noops\nplain", ...extra }) as ViewNode;

describe("text nodes with line tones and the terminal appearance (X10)", () => {
  it("draws each line with its tone in the terminal look; a missing or null tone is the default", () => {
    renderInShell(client(), <ViewNodes nodes={[textNode({ appearance: "terminal", lineTones: ["success", "stderr"] })]} />);
    expect([...document.querySelectorAll(".od-terminal__line")].map((r) => r.getAttribute("data-tone"))).toEqual(["success", "stderr", "default"]);
  });

  it("tones lines of a plain text node, and leaves nodes without tones as before", () => {
    renderInShell(client(), <ViewNodes nodes={[textNode({ lineTones: [null, "danger"] }), { type: "text", id: "u", text: "old" } as ViewNode]} />);
    expect(screen.getByText("oops").className).toContain("od-text-block--danger");
    expect(document.querySelectorAll(".od-terminal").length).toBe(0);
    expect(screen.getByText("old")).toBeTruthy();
  });

  it("maps tone names, unknown ones (stdout) to default", () => {
    expect(textLines("a\nb", ["stdout", "muted"]).map((l) => l.tone)).toEqual(["default", "muted"]);
  });
});

describe("table output in the terminal look and partial output (X10/X17)", () => {
  const table = { type: "table", columns: [{ key: "stream" }, { key: "line" }], rows: [["stdout", "hello"], ["stderr", "oops"]], appearance: "terminal", toneColumn: "stream", lineColumn: "line" };
  it("uses lineColumn for the text and toneColumn for the tone", () => {
    expect(tableLines(table)).toEqual([{ text: "hello", tone: "default" }, { text: "oops", tone: "stderr" }]);
  });
  it("takes the last column when lineColumn is missing or wrong, and the default tone without toneColumn", () => {
    expect(tableLines({ ...table, lineColumn: "nope", toneColumn: undefined }).map((l) => l.text)).toEqual(["hello", "oops"]);
    expect(tableLines({ ...table, toneColumn: undefined }).map((l) => l.tone)).toEqual(["default", "default"]);
  });
  it("only asks for terminal lines when appearance is terminal", () => {
    expect(terminalLinesOf({ ...table, appearance: "plain" })).toBeNull();
    expect(terminalLinesOf({ type: "text", text: "a", appearance: "terminal", lineTones: ["danger"] })).toEqual([{ text: "a", tone: "danger" }]);
    expect(terminalLinesOf(undefined)).toBeNull();
  });
});
