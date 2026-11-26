// @vitest-environment jsdom
import "../testing/jsdom-setup";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { charDiff, diffCounts, lineDiff } from "./diff";
import { DiffView } from "./diff-view";

const labels = { before: "Before", after: "After", split: "Side by side", stacked: "Above and below", empty: "(empty)", added: "added", removed: "removed", same: "unchanged" };

describe("lineDiff (D487 §29.3)", () => {
  it("keeps what is the same, marks lines added, removed and changed", () => {
    const d = lineDiff("a\nb\nc\nd", "a\nB!\nc\ne\nf");
    expect(d.map((l) => l.op)).toEqual(["same", "changed", "same", "changed", "added"]);
    expect(d[1]).toMatchObject({ before: "b", after: "B!", beforeNo: 2, afterNo: 2 });
    expect(d[4]).toMatchObject({ after: "f", afterNo: 5 });
    expect(diffCounts(d)).toEqual({ added: 1, removed: 0, changed: 2 });
    expect(lineDiff("x\ny", "y").map((l) => l.op)).toEqual(["removed", "same"]);
    expect(lineDiff("", "")).toEqual([]);
    expect(lineDiff("", "new").map((l) => l.op)).toEqual(["added"]);
  });
  it("marks the characters that changed inside a line", () => {
    const c = charDiff("line one", "line one, better");
    expect(c.before).toEqual([{ text: "line one", kind: "same" }]);
    expect(c.after).toEqual([{ text: "line one", kind: "same" }, { text: ", better", kind: "added" }]);
    const z = charDiff("秒的认识", "秒的理解");
    expect(z.before.filter((p) => p.kind === "removed").map((p) => p.text).join("")).toBe("认识");
    expect(z.after.filter((p) => p.kind === "added").map((p) => p.text).join("")).toBe("理解");
  });
});

describe("DiffView", () => {
  it("side by side and above and below, with the changed characters marked", () => {
    const { container } = render(<DiffView label="Text" kind="text" before={"one\ntwo"} after={"one\ntwo!"} labels={labels} />);
    expect(screen.getByRole("group", { name: "Text" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Before" })).toBeTruthy();
    expect(container.querySelector(".od-diff__mark--added")!.textContent).toBe("!");
    fireEvent.click(screen.getByRole("button", { name: "Above and below" }));
    expect(screen.getByRole("button", { name: "Above and below" }).getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelectorAll(".od-diff__row--removed").length).toBe(1);
    expect(container.querySelectorAll(".od-diff__row--added").length).toBe(1);
    expect(screen.getAllByRole("img", { name: "added" }).length).toBe(1);
  });
  it("a value as before → after; an empty side says so", () => {
    render(<DiffView label="Name" kind="value" before="" after="Summary" labels={labels} />);
    expect(screen.getByText("(empty)")).toBeTruthy();
    expect(screen.getByText("Summary").tagName).toBe("INS");
  });
  it("a table's rows, one line each", () => {
    const { container } = render(
      <DiffView label="Lines" kind="rows" columns={[{ name: "item", label: "Item" }, { name: "qty", label: "Qty" }]} before={[{ item: "A", qty: 1 }]} after={[{ item: "A", qty: 2 }, { item: "B", qty: 3 }]} labels={labels} />,
    );
    expect(container.textContent).toContain("Item: B · Qty: 3");
    expect(container.querySelectorAll(".od-diff__row--changed").length).toBe(1);
    expect(container.querySelectorAll(".od-diff__row--added").length).toBe(1);
  });
});
