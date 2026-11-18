// @vitest-environment jsdom
import "../../design/testing/jsdom-setup";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Run } from "../protocol";
import { resultText, useElapsed } from "./result-area";

const table = (rows: Array<Array<string | number | null>>) =>
  ({ output: { type: "table", columns: [{ key: "a", label: "id" }, { key: "b", label: "name" }], rows, total: rows.length, truncated: false } }) as unknown as Run;

describe("resultText (copy)", () => {
  it("is tab-separated with the header first; null is empty; tabs and line breaks inside a cell become spaces", () => {
    expect(resultText(table([[1, "a\tb"], [2, null]]))).toBe("id\tname\n1\ta b\n2\t");
  });
  it("gives text output as it is and nothing for other outputs", () => {
    expect(resultText({ output: { type: "text", text: "hi" } } as unknown as Run)).toBe("hi");
    expect(resultText({ output: { type: "none" } } as unknown as Run)).toBeNull();
  });
});

describe("useElapsed", () => {
  it("counts up while active and stops when not", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const { result, rerender } = renderHook(({ active }) => useElapsed(9_000, active), { initialProps: { active: true } });
    expect(result.current).toBe(1000);
    act(() => void vi.advanceTimersByTime(1000));
    expect(result.current).toBe(2000);
    rerender({ active: false });
    act(() => void vi.advanceTimersByTime(1000));
    expect(result.current).toBe(2000);
    vi.useRealTimers();
  });
});
