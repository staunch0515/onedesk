// @vitest-environment jsdom
import "../testing/jsdom-setup";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Tree, type TreeRow } from "./tree";

const row = (key: string, state: TreeRow["state"]): TreeRow => ({ key, label: key, icon: "file", depth: 0, expandable: false, state } as TreeRow);

describe("Tree states", () => {
  it("greys a disabled item but leaves it clickable and not aria-disabled; other states too", () => {
    const onActivate = vi.fn();
    render(<Tree rows={[row("off", "disabled"), row("gone", "missing-plugin"), row("bad", "broken"), row("clash", "conflict")]} label="t" onActivate={onActivate} onToggle={() => undefined} />);
    for (const key of ["off", "gone", "bad", "clash"]) {
      const item = screen.getByText(key).closest('[role="treeitem"]')!;
      expect(item.getAttribute("aria-disabled")).toBeNull();
      fireEvent.click(item);
    }
    expect(onActivate.mock.calls.map((c) => c[0])).toEqual(["off", "gone", "bad", "clash"]);
    expect(screen.getByText("off").closest('[role="treeitem"]')!.getAttribute("data-state")).toBe("disabled");
  });
});
