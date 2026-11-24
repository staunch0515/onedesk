// @vitest-environment jsdom
import "../testing/jsdom-setup";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeLayout } from "../testing/layout";
import { DataGrid, type DataGridColumn } from "./data-grid";

type Row = [number, string];
const columns: Array<DataGridColumn<Row>> = [
  { key: "n", header: "N", value: (r) => r[0], numeric: true },
  { key: "s", header: "S", value: (r) => r[1] },
];
const rows = (n: number): Row[] => Array.from({ length: n }, (_, i) => [i, `v${i}`]);

describe("DataGrid windowing (D373)", () => {
  let restore = () => undefined as void;
  beforeEach(() => {
    restore = fakeLayout({ viewport: 280, tokens: { "--grid-row-height": "28px" } });
  });
  afterEach(() => restore());

  it("draws only the rows in view of a 10 000-row result, keeps absolute row numbers, and stands in for the rest with space", () => {
    const { container } = render(<DataGrid label="r" columns={columns} rows={rows(10000)} rowNumbers getRowKey={(_r, i) => String(i)} />);
    const drawn = container.querySelectorAll("tbody tr[data-index]").length;
    expect(drawn).toBeLessThan(40);
    expect(drawn).toBeGreaterThanOrEqual(9);
    const gap = container.querySelector<HTMLElement>(".od-grid__gap td")!;
    expect(parseInt(gap.style.height)).toBe((10000 - drawn) * 28);
    expect(container.querySelector("table")!.getAttribute("aria-rowcount")).toBe("10000");
  });

  it("follows the scroll position; the row number is the row's place in the whole result", async () => {
    const { container } = render(<DataGrid label="r" columns={columns} rows={rows(10000)} rowNumbers getRowKey={(_r, i) => String(i)} />);
    const wrap = container.querySelector<HTMLElement>(".od-grid-wrap")!;
    wrap.scrollTop = 28 * 5000;
    fireEvent.scroll(wrap);
    const cell = await screen.findByText("v5000");
    expect(cell.closest("tr")!.querySelector(".od-grid__td--num")!.textContent).toBe("5001");
    expect(screen.queryByText("v0")).toBeNull();
  });

  it("sorting works on the whole result, not only the drawn rows", () => {
    const { container } = render(<DataGrid label="r" columns={columns} rows={rows(10000)} getRowKey={(_r, i) => String(i)} defaultSort={{ key: "n", direction: "desc" }} />);
    expect(screen.getByText("v9999")).toBeTruthy();
    expect(container.querySelectorAll("tbody tr[data-index]").length).toBeLessThan(40);
  });

  it("a short result is drawn whole with no filler", () => {
    const { container } = render(<DataGrid label="r" columns={columns} rows={rows(12)} getRowKey={(_r, i) => String(i)} />);
    expect(container.querySelectorAll("tbody tr[data-index]").length).toBe(12);
    expect(container.querySelector(".od-grid__gap")).toBeNull();
  });
});

describe("DataGrid reading more rows on demand", () => {
  let restore = () => undefined as void;
  beforeEach(() => {
    restore = fakeLayout({ viewport: 280, tokens: { "--grid-row-height": "28px" } });
  });
  afterEach(() => restore());

  it("asks for more only when the visible rows are near the end of the loaded ones", () => {
    const far = vi.fn();
    render(<DataGrid label="a" columns={columns} rows={rows(5000)} getRowKey={(_r, i) => String(i)} onNeedMore={far} />);
    expect(far).not.toHaveBeenCalled();
    const near = vi.fn();
    render(<DataGrid label="b" columns={columns} rows={rows(50)} getRowKey={(_r, i) => String(i)} onNeedMore={near} />);
    expect(near).toHaveBeenCalled();
  });
});

describe("DataGrid last row (D472)", () => {
  it("draws the last row after the sorted rows, one cell per column, and no empty message", () => {
    const { container } = render(
      <DataGrid label="r" columns={columns} rows={rows(3)} autoHeight getRowKey={(_r, i) => String(i)} defaultSort={{ key: "n", direction: "desc" }} lastRow={{ s: <input aria-label="new" /> }} />,
    );
    const trs = container.querySelectorAll("tbody tr");
    expect(trs.length).toBe(4);
    expect(trs[3]!.querySelector("input[aria-label=new]")).not.toBeNull();
    expect(trs[0]!.textContent).toContain("v2");
    const empty = render(<DataGrid label="e" columns={columns} rows={[]} getRowKey={(_r, i) => String(i)} empty="Nothing" lastRow={{ s: "add" }} />);
    expect(empty.queryByText("Nothing")).toBeNull();
    expect(empty.getByText("add")).toBeTruthy();
  });
});
