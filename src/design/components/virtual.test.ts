import { describe, expect, it } from "vitest";
import { computeWindow, scrollTopFor, UNMEASURED_ROWS } from "./virtual";

describe("computeWindow", () => {
  const base = { count: 20000, rowHeight: 26, viewport: 520, overscan: 8 };

  it("draws the visible rows plus a buffer at the top, and stands in for the rest with empty space", () => {
    const w = computeWindow({ ...base, scrollTop: 0 });
    expect(w).toMatchObject({ start: 0, end: 20 + 8, before: 0 });
    expect(w.after).toBe((20000 - 28) * 26);
  });

  it("moves with the scroll position; the space above and below always adds up to the full height", () => {
    const w = computeWindow({ ...base, scrollTop: 26 * 5000 });
    expect(w.start).toBe(5000 - 8);
    expect(w.end).toBe(5000 + 20 + 8);
    expect(w.before + (w.end - w.start) * 26 + w.after).toBe(20000 * 26);
  });

  it("never draws more than a screen and the buffers, however many rows there are", () => {
    for (const scrollTop of [0, 1, 13, 26 * 777 + 5, 26 * 19990]) {
      const w = computeWindow({ ...base, scrollTop });
      expect(w.end - w.start).toBeLessThanOrEqual(Math.ceil(520 / 26) + 1 + 16);
    }
  });

  it("stops at the end of the list", () => {
    const w = computeWindow({ ...base, scrollTop: 26 * 20000 });
    expect(w.end).toBe(20000);
    expect(w.after).toBe(0);
    expect(w.start).toBeLessThan(20000);
  });

  it("draws only a bounded first part while the size is unknown (not laid out), and nothing for an empty list", () => {
    expect(computeWindow({ ...base, viewport: 0, scrollTop: 0 })).toEqual({ start: 0, end: UNMEASURED_ROWS, before: 0, after: 0 });
    expect(computeWindow({ ...base, rowHeight: Number.NaN, scrollTop: 0 }).end).toBe(UNMEASURED_ROWS);
    expect(computeWindow({ ...base, count: 40, viewport: 0, scrollTop: 0 }).end).toBe(40);
    expect(computeWindow({ ...base, count: 0, scrollTop: 0 })).toEqual({ start: 0, end: 0, before: 0, after: 0 });
  });

  it("small lists are drawn whole", () => {
    expect(computeWindow({ count: 12, rowHeight: 26, viewport: 520, scrollTop: 0 })).toEqual({ start: 0, end: 12, before: 0, after: 0 });
  });
});

describe("padding above the rows (inset)", () => {
  it("the first row starts below the padding: at the very bottom nothing is off by the padding", () => {
    // 100 rows of 26 px, viewport 260, 4 px padding on top: content is 4 + 2600 high, the last scroll position is 2344.
    const w = computeWindow({ count: 100, rowHeight: 26, viewport: 260, scrollTop: 4 + 2600 - 260, inset: 4, overscan: 0 });
    expect(w.end).toBe(100);
    expect(w.start).toBe(90);
    // without the inset the same position would claim one row too few at the top
    expect(computeWindow({ count: 100, rowHeight: 26, viewport: 260, scrollTop: 4 + 2600 - 260, overscan: 0 }).start).toBe(90);
    const mid = computeWindow({ count: 100, rowHeight: 26, viewport: 260, scrollTop: 4 + 26 * 50 - 1, inset: 4, overscan: 0 });
    expect(mid.start).toBe(49);
  });

  it("revealing a row accounts for the padding", () => {
    expect(scrollTopFor({ index: 99, rowHeight: 26, scrollTop: 0, viewport: 260, inset: 4 })).toBe(4 + 100 * 26 - 260);
    expect(scrollTopFor({ index: 0, rowHeight: 26, scrollTop: 100, viewport: 260, inset: 4 })).toBe(4);
  });
});

describe("scrollTopFor", () => {
  it("leaves the scroll alone when the row is visible and moves the least otherwise", () => {
    const at = (index: number, scrollTop: number) => scrollTopFor({ index, rowHeight: 26, scrollTop, viewport: 520 });
    expect(at(5, 0)).toBe(0);
    expect(at(30, 0)).toBe(31 * 26 - 520);
    expect(at(2, 26 * 10)).toBe(52);
  });
});
