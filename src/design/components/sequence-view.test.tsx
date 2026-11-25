// @vitest-environment jsdom
import "../testing/jsdom-setup";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SequenceView } from "./sequence-view";
import { renderMarkdown } from "./markdown-text";

const labels = { toc: "Contents", previous: "Previous", next: "Next", page: (n: number, total: number) => `${n} / ${total}` };
const items = Array.from({ length: 20 }, (_, i) => ({ key: `k${i}`, title: `Item ${i}`, level: i % 3 === 0 ? 1 : 2, book: i === 0 }));

describe("SequenceView (D487 §13)", () => {
  it("scroll: every title, content only near the start; the list of titles jumps", () => {
    const content = vi.fn((key: string) => <p>content of {key}</p>);
    render(<SequenceView label="Book" items={items} toc startKey="k10" renderContent={content} labels={labels} />);
    expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(20);
    // Loaded: the start and a few on each side; not the far ones.
    expect(screen.getByText("content of k10")).toBeTruthy();
    expect(screen.getByText("content of k7")).toBeTruthy();
    expect(screen.queryByText("content of k0")).toBeNull();
    const nav = screen.getByRole("navigation", { name: "Contents" });
    fireEvent.click(nav.querySelectorAll("button")[1]!);
    expect(screen.getByText("content of k1")).toBeTruthy();
    expect(nav.querySelectorAll("button")[1]!.getAttribute("aria-current")).toBe("location");
  });

  it("pages: one item at a time, buttons and arrow keys; the position is told once the reader stays", () => {
    vi.useFakeTimers();
    const onPosition = vi.fn();
    render(<SequenceView label="Book" items={items} mode="pages" renderContent={(k) => <p>content of {k}</p>} onPosition={onPosition} labels={labels} />);
    expect(screen.getByText("1 / 20")).toBeTruthy();
    expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("content of k1")).toBeTruthy();
    fireEvent.keyDown(screen.getByText("content of k1").closest(".od-sequence__reader")!, { key: "ArrowRight" });
    expect(screen.getByText("3 / 20")).toBeTruthy();
    expect(onPosition).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1000));
    expect(onPosition).toHaveBeenCalledWith("k2");
    fireEvent.keyDown(screen.getByText("content of k2").closest(".od-sequence__reader")!, { key: "ArrowLeft" });
    expect(screen.getByText("2 / 20")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Previous" }) as HTMLButtonElement).disabled).toBe(false);
    vi.useRealTimers();
  });

  it("headings in content shown under an item go further down", () => {
    expect(renderMarkdown("# A", undefined, 2)).toContain("<h4 class=\"od-markdown__h3\">A</h4>");
    expect(renderMarkdown("### A", undefined, 5)).toContain("<h6");
    expect(renderMarkdown("# A")).toContain("<h2 class=\"od-markdown__h1\">A</h2>");
  });

  it("D487 §15: a reference shown with given words still points to its name", () => {
    const html = renderMarkdown("See [[Circuit]] and [[Other]].", () => "ok", 0, { Circuit: "Figure 2-1" });
    expect(html).toContain('data-od-ref="Circuit">Figure 2-1</a>');
    expect(html).toContain('data-od-ref="Other">Other</a>');
    expect(renderMarkdown("[[Circuit]]", () => "ok")).toContain(">Circuit</a>");
  });
});
