// @vitest-environment jsdom
import "../../design/testing/jsdom-setup";
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createMockClient } from "../protocol/mock";
import type { Run, ViewNode } from "../protocol";
import { renderInShell } from "../testing/harness";
import { OutputTab } from "./result-area";
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
    expect(textLines("a\nb", ["stdout" as never, "muted"]).map((l) => l.tone)).toEqual(["default", "muted"]);
  });
});

describe("table output in the terminal look and partial output (X10/X17)", () => {
  const table = { columns: [{ key: "stream", label: "Stream" }, { key: "line", label: "Line" }], rows: [["stdout", "hello"], ["stderr", "oops"]], total: 2, truncated: false, appearance: "terminal" as const, toneColumn: "stream", lineColumn: "line" };
  const tbl = { type: "table" as const, ...table };
  it("uses lineColumn for the text and toneColumn for the tone", () => {
    expect(tableLines(table)).toEqual([{ text: "hello", tone: "default" }, { text: "oops", tone: "stderr" }]);
  });
  it("takes the last column when lineColumn is missing or wrong, and the default tone without toneColumn", () => {
    expect(tableLines({ ...table, lineColumn: "nope", toneColumn: undefined }).map((l) => l.text)).toEqual(["hello", "oops"]);
    expect(tableLines({ ...table, toneColumn: undefined }).map((l) => l.tone)).toEqual(["default", "default"]);
  });
  it("only asks for terminal lines when appearance is terminal", () => {
    expect(terminalLinesOf({ ...tbl, appearance: "plain" })).toBeNull();
    expect(terminalLinesOf({ type: "text", text: "a", appearance: "terminal", lineTones: ["danger"] })).toEqual([{ text: "a", tone: "danger" }]);
    expect(terminalLinesOf(undefined)).toBeNull();
  });
});

describe("the terminal block's accessible name", () => {
  it("is the shell's words, not the node id", () => {
    renderInShell(client(), <ViewNodes nodes={[textNode({ appearance: "terminal" })]} />);
    expect(screen.getByRole("region", { name: "Terminal output" })).toBeTruthy();
    expect(screen.queryByLabelText("t")).toBeNull();
  });
});

describe("the output tab of a running run shows Run.partial live (defect A)", () => {
  const tab = { id: "t1", target: "resource:r1", title: "R", icon: "file", pinned: false, envId: null, params: {} } as never;
  const running = (partial: unknown, extra: object = {}) => ({ id: "r1", seq: 1, status: "running", startedAt: Date.now(), cancellable: true, progress: { message: "Running on web-1…" }, partial, ...extra }) as unknown as Run;
  const table = (rows: string[][], appearance?: "terminal") => ({ type: "table", columns: [{ key: "stream", label: "Stream" }, { key: "line", label: "Line" }], rows, total: rows.length, truncated: false, ...(appearance ? { appearance, toneColumn: "stream", lineColumn: "line" } : {}) });

  it("draws the lines so far in the terminal look, replaces them with the next partial, and then the final output", () => {
    const first = running(table([["stdout", "early-line"]], "terminal"));
    const view = renderInShell(client(), <OutputTab tab={tab} run={first} widthKey="k" />);
    expect(screen.getByText("early-line")).toBeTruthy();
    expect(screen.queryByText("Running on web-1…")).toBeNull();
    view.rerender(<OutputTab tab={tab} run={running(table([["stdout", "early-line"], ["stderr", "late-line"]], "terminal"))} widthKey="k" />);
    expect(screen.getByText("late-line").closest(".od-terminal__line")!.getAttribute("data-tone")).toBe("stderr");
    view.rerender(<OutputTab tab={tab} run={{ ...running(undefined), status: "success", partial: undefined, output: table([["stdout", "done"]], "terminal") } as unknown as Run} widthKey="k" />);
    expect(screen.getByText("done")).toBeTruthy();
    expect(screen.queryByText("early-line")).toBeNull();
  });

  it("shows a partial that does not ask for the terminal look as plain lines", () => {
    renderInShell(client(), <OutputTab tab={tab} run={running({ type: "text", text: "one\ntwo" })} widthKey="k" />);
    expect(screen.getByText("one")).toBeTruthy();
    expect(screen.getByText("two")).toBeTruthy();
  });

  it("still says it is running until the first partial arrives", () => {
    renderInShell(client(), <OutputTab tab={tab} run={running(undefined)} widthKey="k" />);
    expect(screen.getByText("Running on web-1…")).toBeTruthy();
  });
});
