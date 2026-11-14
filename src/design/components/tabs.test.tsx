// @vitest-environment jsdom
import "../testing/jsdom-setup";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Tabs } from "./tabs";

const items = [
  { value: "a", label: "概览", content: <p>概览内容</p> },
  { value: "b", label: "字段", content: <p>字段内容</p> },
  { value: "c", label: "停用", disabled: true, content: <p>停用内容</p> },
  { value: "d", label: "历史", content: <p>历史内容</p> },
];

describe("Tabs", () => {
  it("shows the first tab by default", () => {
    render(<Tabs label="分区" items={items} />);
    expect(screen.getByRole("tablist", { name: "分区" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "概览" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("概览内容")).toBeVisible();
  });

  it("moves and activates with arrow keys, skipping disabled tabs and wrapping", async () => {
    const onValueChange = vi.fn();
    render(<Tabs label="分区" items={items} onValueChange={onValueChange} />);
    const first = screen.getByRole("tab", { name: "概览" });
    first.focus();

    fireEvent.keyDown(first, { key: "ArrowRight" });
    await waitFor(() => expect(screen.getByRole("tab", { name: "字段" })).toHaveFocus());
    await waitFor(() => expect(screen.getByRole("tab", { name: "字段" })).toHaveAttribute("aria-selected", "true"));
    expect(screen.getByText("字段内容")).toBeVisible();
    expect(onValueChange).toHaveBeenLastCalledWith("b");

    fireEvent.keyDown(screen.getByRole("tab", { name: "字段" }), { key: "ArrowRight" });
    await waitFor(() => expect(screen.getByRole("tab", { name: "历史" })).toHaveFocus());
    expect(onValueChange).toHaveBeenLastCalledWith("d");

    fireEvent.keyDown(screen.getByRole("tab", { name: "历史" }), { key: "ArrowRight" });
    await waitFor(() => expect(screen.getByRole("tab", { name: "概览" })).toHaveFocus());

    fireEvent.keyDown(screen.getByRole("tab", { name: "概览" }), { key: "End" });
    await waitFor(() => expect(screen.getByRole("tab", { name: "历史" })).toHaveFocus());
  });
});
