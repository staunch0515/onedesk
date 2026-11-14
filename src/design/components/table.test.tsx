// @vitest-environment jsdom
import "../testing/jsdom-setup";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EmptyState } from "./states";
import { Table, type TableColumn } from "./table";

interface Row {
  id: string;
  name: string;
  size: number;
  off?: boolean;
}

const columns: Array<TableColumn<Row>> = [
  { key: "name", header: "名称" },
  { key: "size", header: "大小", numeric: true },
];

const rows: Row[] = [
  { id: "1", name: "甲", size: 12 },
  { id: "2", name: "乙", size: 3400, off: true },
];

describe("Table", () => {
  it("renders the empty slot across all columns when there are no rows", () => {
    render(<Table label="资源" columns={columns} rows={[]} getRowKey={(r) => r.id} empty={<EmptyState layout="inline" message="还没有资源。" />} />);
    const table = screen.getByRole("table", { name: "资源" });
    expect(within(table).getAllByRole("columnheader")).toHaveLength(2);
    const cell = within(table).getByText("还没有资源。").closest("td");
    expect(cell).toHaveAttribute("colspan", "2");
  });

  it("right-aligns numeric columns with tabular figures", () => {
    render(<Table columns={columns} rows={rows} getRowKey={(r) => r.id} />);
    const cell = screen.getByText("3400");
    expect(cell).toHaveClass("od-table__cell--end", "od-tabular");
    expect(screen.getByRole("columnheader", { name: "大小" })).toHaveClass("od-table__cell--end");
  });

  it("marks selected and muted rows", () => {
    render(<Table columns={columns} rows={rows} getRowKey={(r) => r.id} selectedKeys={["1"]} isRowMuted={(r) => Boolean(r.off)} />);
    const [, first, second] = screen.getAllByRole("row");
    expect(first).toHaveAttribute("aria-selected", "true");
    expect(first).toHaveClass("od-table__row--selected");
    expect(second).toHaveAttribute("aria-selected", "false");
    expect(second).toHaveClass("od-table__row--muted");
  });

  it("activates rows by click and keyboard when interactive", () => {
    const onRowActivate = vi.fn();
    render(<Table columns={columns} rows={rows} getRowKey={(r) => r.id} onRowActivate={onRowActivate} />);
    const row = screen.getByText("乙").closest("tr")!;
    expect(row).toHaveAttribute("tabindex", "0");
    fireEvent.click(row);
    fireEvent.keyDown(row, { key: "Enter" });
    fireEvent.keyDown(row, { key: " " });
    expect(onRowActivate).toHaveBeenCalledTimes(3);
    expect(onRowActivate).toHaveBeenCalledWith(rows[1]);
  });
});
