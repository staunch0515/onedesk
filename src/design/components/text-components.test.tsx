// @vitest-environment jsdom
import "../testing/jsdom-setup";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { KeyValueList } from "./key-value-list";
import { Markdown } from "./markdown";
import { Select } from "./select";
import { Sidebar } from "./sidebar";
import { TerminalText } from "./terminal-text";
import { TextBlock } from "./text-block";
import { TextLink } from "./text-link";

describe("TextLink", () => {
  it("is a real link; onOpen replaces navigation", () => {
    const open = vi.fn();
    render(
      <TextLink href="https://example.com" onOpen={open} external>
        Example
      </TextLink>,
    );
    const link = screen.getByRole("link", { name: "Example" });
    expect(link).toHaveAttribute("href", "https://example.com");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    const event = fireEvent.click(link);
    expect(open).toHaveBeenCalledWith("https://example.com");
    expect(event).toBe(false); // default prevented
  });

  it("without onOpen opens in a new window", () => {
    render(<TextLink href="https://example.com">x</TextLink>);
    expect(screen.getByRole("link")).toHaveAttribute("target", "_blank");
  });
});

describe("TextBlock", () => {
  it("keeps the text exactly (line breaks and spaces) in plain and code variants", () => {
    const text = "line 1\n  line 2 " + "x".repeat(300);
    const { container, rerender } = render(<TextBlock>{text}</TextBlock>);
    expect(container.firstElementChild).toHaveClass("od-text-block--plain");
    expect(container.firstElementChild?.textContent).toBe(text);
    rerender(
      <TextBlock variant="code" tone="danger" label="正文">
        {text}
      </TextBlock>,
    );
    const pre = container.querySelector("pre");
    expect(pre).toHaveClass("od-text-block--code", "od-text-block--danger");
    expect(pre).toHaveAttribute("aria-label", "正文");
    expect(pre?.querySelector("code")?.textContent).toBe(text);
  });
});

describe("Markdown headings", () => {
  it("move one level down (h1→h2 … h6 stays h6) but keep the author's level as class", () => {
    const { container } = render(<Markdown>{"# 一\n\n## 二\n\n###### 六"}</Markdown>);
    expect(container.querySelector("h1")).toBeNull();
    expect(container.querySelector("h2")).toHaveClass("od-markdown__h1");
    expect(container.querySelector("h3")).toHaveClass("od-markdown__h2");
    expect(container.querySelector("h6")).toHaveClass("od-markdown__h6");
    expect(screen.getByRole("heading", { level: 2, name: "一" })).toBeInTheDocument();
  });
});

describe("KeyValueList", () => {
  it("renders a description list with labels and values", () => {
    const { container } = render(
      <KeyValueList
        layout="stacked"
        items={[
          { key: "a", label: "名称", value: "甲" },
          { key: "b", label: "raw_key", value: "乙", monoLabel: true },
        ]}
      />,
    );
    expect(container.querySelector("dl")).toHaveClass("od-kv--stacked");
    expect(container.querySelectorAll("dt")).toHaveLength(2);
    expect(screen.getByText("raw_key")).toHaveClass("od-mono");
    expect(screen.getByText("乙").tagName).toBe("DD");
  });
});

describe("Select aria-label", () => {
  it("names the trigger without a visible label", () => {
    render(<Select aria-label="类型" options={[{ value: "a", label: "A" }]} value="a" />);
    expect(screen.getByRole("combobox", { name: "类型" })).toBeInTheDocument();
  });
});

describe("Sidebar header", () => {
  it("can spread header children to both ends", () => {
    const { container } = render(
      <Sidebar label="nav" header={<span>OneDesk</span>} headerJustify="between">
        <div />
      </Sidebar>,
    );
    expect(container.querySelector(".od-sidebar__header")).toHaveClass("od-sidebar__header--between");
  });
});

describe("TerminalText", () => {
  it("colors each line by tone and marks stderr", () => {
    render(<TerminalText label="output" showStreams lines={[{ text: "ok", stream: "stdout" }, { text: "bad", stream: "stderr" }, { text: "done", tone: "success" }]} />);
    const lines = screen.getByLabelText("output").querySelectorAll(".od-terminal__line");
    expect([...lines].map((l) => l.getAttribute("data-tone"))).toEqual(["default", "stderr", "success"]);
    expect(screen.getByText("err")).toBeInTheDocument();
    expect(screen.getByText("out")).toBeInTheDocument();
  });
});
