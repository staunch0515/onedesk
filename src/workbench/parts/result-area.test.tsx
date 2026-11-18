// @vitest-environment jsdom
import "../../design/testing/jsdom-setup";
import { act, renderHook, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Run } from "../protocol";
import { createMockClient } from "../protocol/mock";
import { kernelLikeClient, renderInShell } from "../testing/harness";
import { resultText, useElapsed, usePagedRows } from "./result-area";

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

describe("resultText with all rows", () => {
  it("uses the rows given instead of the first page", () => {
    expect(resultText(table([[1, "a"]]), [[1, "a"], [2, "b"]])).toBe("id\tname\n1\ta\n2\tb");
  });
});

describe("usePagedRows (D414)", () => {
  it("reads the next page only when asked (scrolling near the end), keeps what it read, and does not overlap reads", async () => {
    const rows = vi.fn(async (_id: string, offset: number, limit: number) => ({ rows: Array.from({ length: Math.min(limit, 2500 - offset) }, (_, i) => [offset + i, "x"] as Array<string | number | null>), total: 2500 }));
    const base = createMockClient({ fresh: true, quiet: true });
    const client = kernelLikeClient(base, { run: { ...base.run, rows } });
    const run = { id: "r1", output: { type: "table", paged: true, total: 2500, truncated: false, columns: [{ key: "a", label: "a" }, { key: "b", label: "b" }], rows: [[0, "x"]] } } as unknown as Run;
    let more: () => void = () => undefined;
    const Probe = () => {
      const p = usePagedRows(run);
      more = p.more;
      return <span>{p.rows?.length}</span>;
    };
    renderInShell(client, <Probe />);
    expect(rows).not.toHaveBeenCalled();
    await act(async () => {
      more();
      more();
    });
    await waitFor(() => expect(screen.getByText("1001")).toBeTruthy());
    expect(rows).toHaveBeenCalledTimes(1);
    await act(async () => more());
    await waitFor(() => expect(screen.getByText("2001")).toBeTruthy());
    expect(rows.mock.calls.map((c) => [c[1], c[2]])).toEqual([[1, 1000], [1001, 1000]]);
  });

  it("is called before any early return: the hook order does not change when the output turns into a table", () => {
    const base = createMockClient({ fresh: true, quiet: true });
    const client = kernelLikeClient(base, {});
    const none = { id: "r1", output: { type: "none" } } as unknown as Run;
    const whole = { id: "r1", output: { type: "table", total: 1, truncated: false, columns: [], rows: [[1]] } } as unknown as Run;
    const Probe = ({ run }: { run: Run }) => <span>{String(usePagedRows(run).rows)}</span>;
    const { rerender } = renderInShell(client, <Probe run={none} />);
    expect(() => rerender(<Probe run={whole} />)).not.toThrow();
  });
});
