// @vitest-environment jsdom
import "../testing/jsdom-setup";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RowsEditor } from "./rows-editor";

const labels = { addLabel: "Add a line", removeLabel: "Remove", upLabel: "Up", downLabel: "Down", emptyLabel: "No lines" };
const columns = [{ name: "item", label: "Item" }, { name: "qty", label: "Qty", width: "sm" as const }];
const cell = (row: number, c: { name: string }, value: unknown, set: (v: unknown) => void) => <input aria-label={`${c.name} ${row}`} value={String(value ?? "")} onChange={(e) => set(e.target.value)} />;

describe("RowsEditor (D487 §27, K15)", () => {
  it("adds, edits, moves and removes lines", () => {
    const onChange = vi.fn();
    const rows = [{ item: "a", qty: "1" }, { item: "b", qty: "2" }];
    render(<RowsEditor label="Lines" columns={columns} rows={rows} renderCell={cell} onChange={onChange} {...labels} />);
    fireEvent.change(screen.getByLabelText("qty 1"), { target: { value: "5" } });
    expect(onChange).toHaveBeenLastCalledWith([{ item: "a", qty: "1" }, { item: "b", qty: "5" }]);
    fireEvent.click(screen.getAllByRole("button", { name: "Up" })[1]!);
    expect(onChange).toHaveBeenLastCalledWith([rows[1], rows[0]]);
    fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[0]!);
    expect(onChange).toHaveBeenLastCalledWith([rows[1]]);
    fireEvent.click(screen.getByRole("button", { name: "Add a line" }));
    expect(onChange).toHaveBeenLastCalledWith([...rows, {}]);
    // Enter in the last cell adds a line.
    fireEvent.keyDown(screen.getByLabelText("qty 1"), { key: "Enter" });
    expect(onChange).toHaveBeenLastCalledWith([...rows, {}]);
  });

  it("read only: no tools; empty says so", () => {
    render(<RowsEditor label="Lines" columns={columns} rows={[]} readOnly renderCell={cell} onChange={() => undefined} {...labels} />);
    expect(screen.getByText("No lines")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add a line" })).toBeNull();
  });
});
