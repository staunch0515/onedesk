// @vitest-environment jsdom
import "../../design/testing/jsdom-setup";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createMockClient } from "../protocol/mock";
import type { Run, ViewNode } from "../protocol";
import { renderInShell } from "../testing/harness";
import { useLiveLines } from "./result-area";
import { ViewNodes } from "./view-nodes";

const client = () => createMockClient({ fresh: true, quiet: true });
const textNode = (extra: object): ViewNode => ({ type: "text", id: "t", text: "a\nb", ...extra }) as ViewNode;

describe("text nodes with line tones and the terminal style (X10)", () => {
  it("draws each line with its own tone in the terminal style", () => {
    renderInShell(client(), <ViewNodes nodes={[textNode({ style: "terminal", lines: [{ text: "ok", tone: "success" }, { text: "oops", tone: "stderr" }, { text: "plain" }] })]} />);
    const rows = [...document.querySelectorAll(".od-terminal__line")];
    expect(rows.map((r) => r.getAttribute("data-tone"))).toEqual(["success", "stderr", "default"]);
    expect(screen.getByLabelText("t").className).toContain("od-terminal");
  });

  it("tones lines of a plain text node too, and leaves nodes without lines as before", () => {
    renderInShell(client(), <ViewNodes nodes={[textNode({ lines: [{ text: "bad", tone: "danger" }] }), { type: "text", id: "u", text: "old" } as ViewNode]} />);
    expect(screen.getByText("bad").className).toContain("od-text-block--danger");
    expect(document.querySelectorAll(".od-terminal").length).toBe(0);
    expect(screen.getByText("old")).toBeTruthy();
  });
});

function Live({ run }: { run: Run }) {
  const lines = useLiveLines(run);
  return <ul>{lines.map((l, i) => <li key={i}>{`${l.stream ?? "-"}:${l.text}`}</li>)}</ul>;
}
const running = (progress: object): Run => ({ id: "r1", status: "running", progress }) as unknown as Run;

describe("partial output of a running program (X17)", () => {
  it("collects lines in order and keeps which stream each came from", () => {
    const { rerender } = render(<Live run={running({ message: "one\n", stream: "stdout" })} />);
    rerender(<Live run={running({ message: "two", stream: "stderr" })} />);
    expect([...document.querySelectorAll("li")].map((l) => l.textContent)).toEqual(["stdout:one", "stderr:two"]);
  });

  it("takes a whole `output` list when the kernel sends one", () => {
    render(<Live run={running({ output: [{ text: "a", stream: "stdout" }, { text: "b", stream: "stderr" }] })} />);
    expect([...document.querySelectorAll("li")].map((l) => l.textContent)).toEqual(["stdout:a", "stderr:b"]);
  });
});
