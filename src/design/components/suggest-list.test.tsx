// @vitest-environment jsdom
import "../testing/jsdom-setup";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SuggestList } from "./suggest-list";

describe("SuggestList (D482)", () => {
  it("lists the candidates with where they are, marks the active one, and picks on click without taking the focus", () => {
    const onPick = vi.fn();
    render(<SuggestList label="Refs" active={1} onPick={onPick} items={[{ key: "a", title: "Book A/Chapter 1", detail: "Note · Book A" }, { key: "b", title: "Book B/Chapter 1", detail: "Note · Book B" }]} />);
    const options = screen.getAllByRole("option");
    expect(options[1]!.getAttribute("aria-selected")).toBe("true");
    expect(options[0]!.textContent).toContain("Note · Book A");
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    options[0]!.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    fireEvent.click(options[0]!);
    expect(onPick).toHaveBeenCalledWith(0);
  });
  it("says so when there is nothing", () => {
    render(<SuggestList label="Refs" active={0} onPick={() => undefined} items={[]} empty="Nothing with that name" />);
    expect(screen.getByText("Nothing with that name")).toBeTruthy();
  });
});
