// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Run } from "../protocol";
import { useRunEndRefresh } from "./run-refresh";

const run = (id: string, status: Run["status"]) => ({ id, status }) as Run;

describe("useRunEndRefresh", () => {
  it("fires once when a run started here ends, even if the first answer already says success", () => {
    const onEnd = vi.fn();
    const { rerender } = renderHook(({ id, r }) => useRunEndRefresh(id, r, onEnd), { initialProps: { id: null as string | null, r: null as Run | null } });
    rerender({ id: "r1", r: run("r1", "success") });
    rerender({ id: "r1", r: run("r1", "success") });
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it("waits while the run is running and fires when it ends", () => {
    const onEnd = vi.fn();
    const { rerender } = renderHook(({ id, r }) => useRunEndRefresh(id, r, onEnd), { initialProps: { id: null as string | null, r: null as Run | null } });
    rerender({ id: "r2", r: run("r2", "running") });
    expect(onEnd).not.toHaveBeenCalled();
    rerender({ id: "r2", r: run("r2", "cancelled") });
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it("ignores a run the tab only remembers", () => {
    const onEnd = vi.fn();
    renderHook(() => useRunEndRefresh("old", run("old", "success"), onEnd));
    expect(onEnd).not.toHaveBeenCalled();
  });
});
