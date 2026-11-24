// @vitest-environment jsdom
import "../testing/jsdom-setup";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MultiSelect } from "./multi-select";

const options = [
  { value: "a", label: "Alpha" },
  { value: "b", label: "Beta" },
  { value: "c", label: "Gamma" },
];

describe("MultiSelect (D477)", () => {
  it("shows the chosen names in the order of the options, or the placeholder", () => {
    const { rerender } = render(<MultiSelect aria-label="Kinds" options={options} value={["c", "a"]} placeholder="Any" />);
    expect(screen.getByRole("button", { name: "Kinds" })).toHaveTextContent("Alpha, Gamma");
    rerender(<MultiSelect aria-label="Kinds" options={options} value={[]} placeholder="Any" />);
    expect(screen.getByRole("button", { name: "Kinds" })).toHaveTextContent("Any");
  });
  it("ticking adds and unticking removes, keeping the order of the options", () => {
    const onValueChange = vi.fn();
    render(<MultiSelect aria-label="Kinds" options={options} value={["c"]} onValueChange={onValueChange} />);
    fireEvent.keyDown(screen.getByRole("button", { name: "Kinds" }), { key: "Enter" });
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Alpha" }));
    expect(onValueChange).toHaveBeenLastCalledWith(["a", "c"]);
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Gamma" }));
    expect(onValueChange).toHaveBeenLastCalledWith([]);
  });
  it("disabled: no list", () => {
    render(<MultiSelect aria-label="Kinds" options={options} value={["a"]} disabled />);
    expect(screen.getByRole("button", { name: "Kinds" })).toBeDisabled();
  });
});
