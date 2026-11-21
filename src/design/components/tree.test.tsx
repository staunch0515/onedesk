// @vitest-environment jsdom
import "../testing/jsdom-setup";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeLayout } from "../testing/layout";
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

describe("Tree windowing (D373)", () => {
  const many = (n: number): TreeRow[] => Array.from({ length: n }, (_, i) => ({ key: `k${i}`, label: `Row ${i}`, icon: "file", depth: 0, expandable: false }));
  let restore = () => undefined as void;
  beforeEach(() => {
    restore = fakeLayout({ viewport: 260, tokens: { "--tree-row-height": "26px" } });
  });
  afterEach(() => restore());

  it("draws only the rows in view with a buffer, however long the list is, and stands in for the rest with space", () => {
    const { container } = render(<Tree rows={many(20000)} label="t" onActivate={() => undefined} onToggle={() => undefined} />);
    const drawn = container.querySelectorAll('[role="treeitem"]').length;
    expect(drawn).toBeLessThanOrEqual(10 + 8 + 1);
    expect(drawn).toBeGreaterThanOrEqual(10);
    const gap = container.querySelector<HTMLElement>(".od-tree__gap")!;
    expect(parseInt(gap.style.height)).toBe((20000 - drawn) * 26);
    expect(screen.getByText("Row 0")).toBeTruthy();
    expect(screen.queryByText("Row 19999")).toBeNull();
  });

  it("follows the scroll position", async () => {
    const { container } = render(<Tree rows={many(20000)} label="t" onActivate={() => undefined} onToggle={() => undefined} />);
    const tree = container.querySelector<HTMLElement>(".od-tree")!;
    tree.scrollTop = 26 * 10000;
    fireEvent.scroll(tree);
    expect(await screen.findByText("Row 10000")).toBeTruthy();
    expect(screen.queryByText("Row 0")).toBeNull();
    expect(container.querySelectorAll('[role="treeitem"]').length).toBeLessThanOrEqual(10 + 16 + 1);
  });

  it("a `more` row that is in view asks for the next batch, once", () => {
    const onNeedMore = vi.fn();
    const rows = [...many(5), { key: "more:", label: "Reading more…", icon: "ellipsis", depth: 0, expandable: false, more: true }];
    const { rerender } = render(<Tree rows={rows} label="t" onActivate={() => undefined} onToggle={() => undefined} onNeedMore={onNeedMore} />);
    expect(onNeedMore).toHaveBeenCalledWith("more:");
    rerender(<Tree rows={rows} label="t" onActivate={() => undefined} onToggle={() => undefined} onNeedMore={onNeedMore} />);
    expect(onNeedMore).toHaveBeenCalledTimes(1);
  });

  it("a `more` row far below the view asks for nothing until it comes into view", () => {
    const onNeedMore = vi.fn();
    const rows = [...many(1000), { key: "more:", label: "Reading more…", icon: "ellipsis", depth: 0, expandable: false, more: true }];
    render(<Tree rows={rows} label="t" onActivate={() => undefined} onToggle={() => undefined} onNeedMore={onNeedMore} />);
    expect(onNeedMore).not.toHaveBeenCalled();
  });

  it("keyboard down moves the focus on the long list", () => {
    const { container } = render(<Tree rows={many(20000)} label="t" selectedKey="k0" onActivate={() => undefined} onToggle={() => undefined} />);
    const tree = container.querySelector<HTMLElement>(".od-tree")!;
    fireEvent.keyDown(tree, { key: "End" });
    expect(tree.scrollTop).toBeGreaterThan(26 * 19000);
  });

  it("a `more` row that is still in view after its batch arrived asks again (a batch shorter than the screen)", () => {
    const onNeedMore = vi.fn();
    const more = { key: "more:", label: "Reading more…", icon: "ellipsis", depth: 0, expandable: false, more: true } as TreeRow;
    const props = { label: "t", onActivate: () => undefined, onToggle: () => undefined, onNeedMore };
    const { rerender } = render(<Tree rows={[...many(3), more]} {...props} />);
    expect(onNeedMore).toHaveBeenCalledTimes(1);
    rerender(<Tree rows={[...many(6), more]} {...props} />); // the batch arrived; the row is still in view
    expect(onNeedMore).toHaveBeenCalledTimes(2);
    rerender(<Tree rows={[...many(6), more]} {...props} />); // nothing changed: no new request
    expect(onNeedMore).toHaveBeenCalledTimes(2);
  });

  it("rows opening above the selected row do not pull the view back to it; a new selection does scroll", () => {
    const props = { label: "t", onActivate: () => undefined, onToggle: () => undefined };
    const { container, rerender } = render(<Tree rows={many(500)} selectedKey="k300" {...props} />);
    const tree = container.querySelector<HTMLElement>(".od-tree")!;
    expect(tree.scrollTop).toBeGreaterThan(0); // the first selection was revealed
    tree.scrollTop = 26 * 40; // the user scrolls away
    fireEvent.scroll(tree);
    const extra: TreeRow[] = Array.from({ length: 20 }, (_, i) => ({ key: `x${i}`, label: `X ${i}`, icon: "file", depth: 1, expandable: false }));
    rerender(<Tree rows={[...many(10), ...extra, ...many(500).slice(10)]} selectedKey="k300" {...props} />); // a folder above opened
    expect(tree.scrollTop).toBe(26 * 40);
    rerender(<Tree rows={[...many(10), ...extra, ...many(500).slice(10)]} selectedKey="k450" {...props} />);
    expect(tree.scrollTop).toBeGreaterThan(26 * 400);
  });
});

describe("renaming in place", () => {
  const rows: TreeRow[] = [{ key: "f", label: "report.final.txt", icon: "file", depth: 0, expandable: false }];
  it("takes focus even when something else takes it first, and selects the name without the extension", async () => {
    render(<Tree rows={rows} label="t" onActivate={() => undefined} onToggle={() => undefined} editingKey="f" renameLabel="Rename" />);
    const box = screen.getByLabelText("Rename") as HTMLInputElement;
    document.body.focus(); // a closing menu returning focus elsewhere
    await new Promise((r) => setTimeout(r, 5));
    expect(document.activeElement).toBe(box);
    expect([box.selectionStart, box.selectionEnd]).toEqual([0, "report.final".length]);
  });

  it("selects a name with no extension, or only a leading dot, whole", () => {
    render(<Tree rows={[{ ...rows[0]!, label: ".env" }]} label="t" onActivate={() => undefined} onToggle={() => undefined} editingKey="f" renameLabel="Rename" />);
    const box = screen.getByLabelText("Rename") as HTMLInputElement;
    expect(box.selectionEnd).toBe(".env".length);
  });

  it("Enter commits the typed name", () => {
    const onRenameCommit = vi.fn();
    render(<Tree rows={rows} label="t" onActivate={() => undefined} onToggle={() => undefined} editingKey="f" renameLabel="Rename" onRenameCommit={onRenameCommit} />);
    const box = screen.getByLabelText("Rename") as HTMLInputElement;
    fireEvent.change(box, { target: { value: "x.txt" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onRenameCommit).toHaveBeenCalledWith("f", "x.txt");
  });
});
