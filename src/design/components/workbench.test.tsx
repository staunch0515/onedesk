// @vitest-environment jsdom
import "../testing/jsdom-setup";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ActivityBar } from "./workbench";

const items = [
  { key: "resources", label: "Resources", icon: "folder-tree" },
  { key: "environments", label: "Environments", icon: "layers" },
  { key: "runs", label: "Run history", icon: "history", badge: 3 },
];
const footer = [{ key: "settings", label: "Settings", icon: "settings" }];
const labels = { wideLabel: "Show all views", narrowLabel: "Back to icons", filterLabel: "Find a view", emptyLabel: "No view matches" };

describe("ActivityBar (D465)", () => {
  it("without `wide` has no switch", () => {
    render(<ActivityBar label="Views" items={items} footer={footer} activeKey="resources" onSelect={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Show all views" })).toBeNull();
  });

  it("narrow: the switch is first, above the views; it asks to go wide", () => {
    const onToggleWide = vi.fn();
    render(<ActivityBar label="Views" items={items} footer={footer} activeKey="resources" onSelect={vi.fn()} wide={false} onToggleWide={onToggleWide} {...labels} />);
    const nav = screen.getByRole("navigation", { name: "Views" });
    const buttons = within(nav).getAllByRole("button");
    expect(buttons[0]).toHaveAccessibleName("Show all views");
    expect(buttons[0]).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByRole("searchbox")).toBeNull();
    fireEvent.click(buttons[0]!);
    expect(onToggleWide).toHaveBeenCalledTimes(1);
  });

  it("wide: title row with the switch, a search, every view as a tile with its name, the active one marked, counts kept, settings at the bottom", () => {
    const onSelect = vi.fn();
    const onToggleWide = vi.fn();
    const { container } = render(<ActivityBar label="Views" items={items} footer={footer} activeKey="environments" onSelect={onSelect} wide onToggleWide={onToggleWide} {...labels} />);
    expect(screen.getByRole("heading", { level: 2, name: "Views" })).toBeTruthy();
    const tiles = within(screen.getByRole("list")).getAllByRole("listitem");
    expect(tiles.map((t) => t.textContent)).toEqual(["Resources", "Environments", "3Run history"]);
    expect(tiles[1]).toHaveAttribute("aria-current", "true");
    expect(tiles[0]).not.toHaveAttribute("aria-current");
    fireEvent.click(tiles[2]!);
    expect(onSelect).toHaveBeenCalledWith("runs");
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(onSelect).toHaveBeenCalledWith("settings");
    expect(container.querySelector(".od-activity__group--row")?.textContent).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Back to icons" }));
    expect(onToggleWide).toHaveBeenCalledTimes(1);
  });

  it("wide: the search keeps the views whose name (or key) has every word, says so when none does, and Escape clears it", () => {
    render(<ActivityBar label="Views" items={items} activeKey={null} onSelect={vi.fn()} wide onToggleWide={vi.fn()} {...labels} />);
    const search = screen.getByRole("textbox", { name: "Find a view" });
    fireEvent.change(search, { target: { value: "run hist" } });
    expect(within(screen.getByRole("list")).getAllByRole("listitem").map((t) => t.textContent)).toEqual(["3Run history"]);
    fireEvent.change(search, { target: { value: "zzz" } });
    expect(within(screen.getByRole("list")).queryAllByRole("listitem")).toHaveLength(0);
    expect(screen.getByText("No view matches")).toBeTruthy();
    fireEvent.keyDown(search, { key: "Escape" });
    expect(within(screen.getByRole("list")).getAllByRole("listitem")).toHaveLength(3);
  });
});
