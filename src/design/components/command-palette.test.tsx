// @vitest-environment jsdom
import "../testing/jsdom-setup";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CommandPalette, type CommandGroup } from "./command-palette";

function setup(overrides: Partial<Parameters<typeof CommandPalette>[0]> = {}) {
  const openNote = vi.fn();
  const onOpenChange = vi.fn();
  const groups: CommandGroup[] = [
    {
      id: "resources",
      heading: "资源",
      items: [
        { id: "r1", label: "周报提示词", description: "提示词", keywords: ["写作"], onSelect: openNote },
        { id: "r2", label: "内部知识库", description: "网址", keywords: ["文档"], onSelect: vi.fn() },
      ],
    },
    { id: "pages", heading: "页面", items: [{ id: "settings", label: "设置", onSelect: vi.fn() }] },
  ];
  render(<CommandPalette open onOpenChange={onOpenChange} groups={groups} label="命令面板" placeholder="搜索" emptyText="没有匹配的结果。" {...overrides} />);
  return { openNote, onOpenChange, input: screen.getByPlaceholderText("搜索") };
}

const visibleOptions = () => screen.queryAllByRole("option").map((o) => o.textContent);

describe("CommandPalette", () => {
  it("names the result list with listLabel instead of cmdk's English default", () => {
    setup({ listLabel: "搜索结果" });
    expect(screen.getByRole("listbox", { name: "搜索结果" })).toBeInTheDocument();
    expect(screen.queryByRole("listbox", { name: "Suggestions" })).toBeNull();
  });

  it("lists every item grouped when the query is empty", () => {
    setup();
    expect(screen.getByRole("dialog", { name: "命令面板" })).toBeInTheDocument();
    expect(visibleOptions()).toHaveLength(3);
    expect(screen.getByText("资源")).toBeInTheDocument();
  });

  it("filters by label and keywords, not by internal ids", async () => {
    const { input } = setup();
    fireEvent.change(input, { target: { value: "周报" } });
    await waitFor(() => expect(visibleOptions()).toEqual(["周报提示词提示词"]));

    fireEvent.change(input, { target: { value: "文档" } });
    await waitFor(() => expect(visibleOptions()).toEqual(["内部知识库网址"]));

    fireEvent.change(input, { target: { value: "resources" } });
    await waitFor(() => expect(visibleOptions()).toEqual([]));
  });

  it("shows the empty text when nothing matches", async () => {
    const { input } = setup();
    fireEvent.change(input, { target: { value: "zzzz" } });
    expect(await screen.findByText("没有匹配的结果。")).toBeInTheDocument();
  });

  it("runs the highlighted item on Enter and closes", async () => {
    const { input, openNote, onOpenChange } = setup();
    fireEvent.change(input, { target: { value: "周报" } });
    await waitFor(() => expect(visibleOptions()).toHaveLength(1));
    fireEvent.keyDown(input, { key: "Enter" });
    expect(openNote).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("leaves filtering to the caller when filter is false", async () => {
    const { input } = setup({ filter: false });
    fireEvent.change(input, { target: { value: "zzzz" } });
    await waitFor(() => expect(visibleOptions()).toHaveLength(3));
  });
});
