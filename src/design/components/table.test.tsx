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

  it("marks selected and muted rows (grid semantics when interactive)", () => {
    render(<Table columns={columns} rows={rows} getRowKey={(r) => r.id} selectedKeys={["1"]} isRowMuted={(r) => Boolean(r.off)} onRowActivate={() => undefined} />);
    expect(screen.getByRole("grid")).toBeInTheDocument();
    const [, first, second] = screen.getAllByRole("row");
    expect(first).toHaveAttribute("aria-selected", "true");
    expect(first).toHaveClass("od-table__row--selected");
    expect(second).toHaveAttribute("aria-selected", "false");
    expect(second).toHaveClass("od-table__row--muted");
  });

  it("is a plain table without aria-selected when not interactive", () => {
    render(<Table columns={columns} rows={rows} getRowKey={(r) => r.id} selectedKeys={["1"]} />);
    expect(screen.queryByRole("grid")).toBeNull();
    const [, first] = screen.getAllByRole("row");
    expect(first).not.toHaveAttribute("aria-selected");
    expect(first).toHaveClass("od-table__row--selected");
  });

  it("uses fixed layout with token widths so empty and filled tables line up", () => {
    const cols: Array<TableColumn<Row>> = [...columns, { key: "act", header: "", width: "xs" }];
    const { container } = render(<Table columns={cols} rows={[]} getRowKey={(r) => r.id} />);
    const colEls = container.querySelectorAll("col");
    expect(colEls).toHaveLength(3);
    expect(colEls[2]).toHaveClass("od-table__col--xs");
  });

  it("activates rows by click and keyboard when interactive", () => {
    const onRowActivate = vi.fn();
    render(<Table columns={columns} rows={rows} getRowKey={(r) => r.id} onRowActivate={onRowActivate} />);
    const row = screen.getByText("乙").closest("tr")!;
    expect(row).toHaveAttribute("tabindex", "-1");
    fireEvent.click(row);
    fireEvent.keyDown(row, { key: "Enter" });
    fireEvent.keyDown(row, { key: " " });
    expect(onRowActivate).toHaveBeenCalledTimes(3);
    expect(onRowActivate).toHaveBeenCalledWith(rows[1]);
  });
});

describe("Table keyboard and inline controls", () => {
  const withAction: Array<TableColumn<Row>> = [
    ...columns,
    { key: "act", header: "", width: "xs", render: (r) => <button type="button" onClick={() => onAction(r.id)}>{`操作${r.name}`}</button> },
  ];
  let onAction = vi.fn();
  const three: Row[] = [...rows, { id: "3", name: "丙", size: 1 }];

  it("has a single Tab stop and moves focus with arrow keys, Home and End", () => {
    render(<Table columns={columns} rows={three} getRowKey={(r) => r.id} onRowActivate={() => undefined} selectedKeys={["2"]} />);
    const dataRows = screen.getAllByRole("row").slice(1);
    expect(dataRows.map((r) => r.getAttribute("tabindex"))).toEqual(["-1", "0", "-1"]);
    dataRows[1]!.focus();
    fireEvent.keyDown(dataRows[1]!, { key: "ArrowDown" });
    expect(dataRows[2]).toHaveFocus();
    expect(dataRows.map((r) => r.getAttribute("tabindex"))).toEqual(["-1", "-1", "0"]);
    fireEvent.keyDown(dataRows[2]!, { key: "ArrowDown" });
    expect(dataRows[2]).toHaveFocus();
    fireEvent.keyDown(dataRows[2]!, { key: "Home" });
    expect(dataRows[0]).toHaveFocus();
    fireEvent.keyDown(dataRows[0]!, { key: "ArrowUp" });
    expect(dataRows[0]).toHaveFocus();
    fireEvent.keyDown(dataRows[0]!, { key: "End" });
    expect(dataRows[2]).toHaveFocus();
  });

  it("does not steal clicks, Enter or Space from controls inside a row", () => {
    onAction = vi.fn();
    const onRowActivate = vi.fn();
    render(<Table columns={withAction} rows={rows} getRowKey={(r) => r.id} onRowActivate={onRowActivate} />);
    const button = screen.getByRole("button", { name: "操作甲" });
    fireEvent.click(button);
    fireEvent.keyDown(button, { key: "Enter" });
    fireEvent.keyDown(button, { key: " " });
    expect(onAction).toHaveBeenCalledWith("1");
    expect(onRowActivate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("甲"));
    expect(onRowActivate).toHaveBeenCalledTimes(1);
  });
});
