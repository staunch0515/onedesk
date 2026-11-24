// @vitest-environment jsdom
import "../testing/jsdom-setup";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ActionBar, InfoPanel, PageFrame, PageTitleBar } from "./page-frame";

const actions = ["Run", "Save", "Format", "Explain", "Export", "Copy"].map((label) => ({ key: label, label, onSelect: vi.fn() }));

describe("PageTitleBar (D465)", () => {
  it("ends the breadcrumb row with the page's name as the h1, then the badges", () => {
    const open = vi.fn();
    render(<PageTitleBar icon="file" title="Daily orders" crumbsLabel="Location" crumbs={[{ key: "a", label: "Orders", onClick: open }, { key: "b", label: "Checks" }]} meta={<span>SQL query</span>} />);
    const nav = screen.getByRole("navigation", { name: "Location" });
    const heading = within(nav).getByRole("heading", { level: 1, name: "Daily orders" });
    expect(heading.closest("[aria-current='page']")).not.toBeNull();
    // Path, then the current name, then the badges — in that order, all in the one row.
    const text = nav.textContent ?? "";
    expect(text.indexOf("Orders")).toBeLessThan(text.indexOf("Checks"));
    expect(text.indexOf("Checks")).toBeLessThan(text.indexOf("Daily orders"));
    expect(text.indexOf("Daily orders")).toBeLessThan(text.indexOf("SQL query"));
    fireEvent.click(within(nav).getByRole("button", { name: "Orders" }));
    expect(open).toHaveBeenCalled();
    // A crumb without a target is plain text, not a button.
    expect(within(nav).queryByRole("button", { name: "Checks" })).toBeNull();
  });

  it("puts the lead first, then the actions, and the aside last in the second row", () => {
    const { container } = render(
      <PageTitleBar
        icon="file"
        title="Q"
        crumbsLabel="Location"
        lead={<select aria-label="Environment" />}
        actions={<ActionBar items={actions} moreLabel="More" label="Actions" />}
        aside={<button type="button">Info</button>}
      />,
    );
    const row = container.querySelector(".od-titlebar__actions-row")!;
    const parts = [...row.children].map((c) => c.className);
    expect(parts).toEqual(["od-titlebar__lead", "od-titlebar__actions", "od-titlebar__aside"]);
    expect(within(row as HTMLElement).getByRole("combobox", { name: "Environment" })).toBeTruthy();
    // More than four actions: four buttons, the rest behind "More".
    const bar = within(row as HTMLElement).getByRole("toolbar", { name: "Actions" });
    expect(within(bar).getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent)).toEqual(["Run", "Save", "Format", "Explain", "More"]);
  });

  it("has no second row when there is nothing to put in it", () => {
    const { container } = render(<PageTitleBar icon="file" title="Q" crumbsLabel="Location" />);
    expect(container.querySelector(".od-titlebar__actions-row")).toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: "Q" })).toBeTruthy();
  });

  it("PageFrame draws the title bar, the notice and the content in order", () => {
    const { container } = render(
      <PageFrame header={<PageTitleBar icon="file" title="Q" crumbsLabel="Location" />} notice={<p>Read only</p>}>
        <p>Body</p>
      </PageFrame>,
    );
    const kids = [...container.querySelector(".od-pf")!.children].map((c) => c.className);
    expect(kids).toEqual(["od-titlebar", "od-pf__notice", "od-pf__content"]);
  });
});

describe("InfoPanel side", () => {
  it("points its close icon toward its side", () => {
    const onClose = vi.fn();
    const { rerender, container } = render(
      <InfoPanel title="Info" closeLabel="Hide" onClose={onClose}>
        x
      </InfoPanel>,
    );
    expect(container.querySelector("[data-icon='panel-left-close'], .lucide-panel-left-close")).not.toBeNull();
    rerender(
      <InfoPanel title="Info" closeLabel="Hide" onClose={onClose} side="right">
        x
      </InfoPanel>,
    );
    expect(container.querySelector("[data-icon='panel-right-close'], .lucide-panel-right-close")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Hide" }));
    expect(onClose).toHaveBeenCalled();
  });
});
