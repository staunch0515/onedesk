// @vitest-environment jsdom
import "../testing/jsdom-setup";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
