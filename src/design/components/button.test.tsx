// @vitest-environment jsdom
import "../testing/jsdom-setup";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Button } from "./button";
import { IconButton } from "./icon-button";

describe("Button", () => {
  it("renders the variant and size classes and defaults to type=button", () => {
    render(
      <Button variant="primary" size="sm">
        保存
      </Button>,
    );
    const btn = screen.getByRole("button", { name: "保存" });
    expect(btn).toHaveClass("od-button", "od-button--primary", "od-button--sm");
    expect(btn).toHaveAttribute("type", "button");
  });

  it("calls onClick when enabled", () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>运行</Button>);
    fireEvent.click(screen.getByRole("button", { name: "运行" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("is disabled and does not fire while disabled", () => {
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        运行
      </Button>,
    );
    const btn = screen.getByRole("button", { name: "运行" });
    expect(btn).toBeDisabled();
    fireEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("loading keeps the label, sets aria-busy, shows a spinner and blocks clicks", () => {
    const onClick = vi.fn();
    const { container } = render(
      <Button loading icon="send" onClick={onClick}>
        发送
      </Button>,
    );
    const btn = screen.getByRole("button", { name: "发送" });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute("aria-busy", "true");
    expect(btn).toHaveClass("od-button--loading");
    expect(container.querySelector(".od-spinner")).not.toBeNull();
    expect(container.querySelector('[data-icon="send"]')).toBeNull();
    fireEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("renders leading and trailing icons", () => {
    const { container } = render(
      <Button icon="plus" trailingIcon="chevron-down">
        新建
      </Button>,
    );
    expect(container.querySelector('[data-icon="plus"]')).not.toBeNull();
    expect(container.querySelector('[data-icon="chevron-down"]')).not.toBeNull();
  });
});

describe("IconButton", () => {
  it("uses the label as accessible name", () => {
    render(<IconButton icon="settings" label="设置" />);
    expect(screen.getByRole("button", { name: "设置" })).toBeInTheDocument();
  });
});
