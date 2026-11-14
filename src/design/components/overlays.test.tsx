// @vitest-environment jsdom
import "../testing/jsdom-setup";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Button } from "./button";
import { CommandPalette } from "./command-palette";
import { Popover } from "./popover";
import { NavGroup, NavItem } from "./sidebar";
import { ToastProvider, useToast, type ToastOptions } from "./toast";

describe("Popover", () => {
  it("opens from the trigger, is named by its title and closes with Escape", async () => {
    render(
      <Popover trigger={<Button>筛选</Button>} title="筛选条件">
        <input aria-label="标签" />
      </Popover>,
    );
    const trigger = screen.getByRole("button", { name: "筛选" });
    fireEvent.click(trigger);
    const panel = await screen.findByRole("dialog", { name: "筛选条件" });
    expect(panel).toBeInTheDocument();
    fireEvent.keyDown(panel, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});

function Fire({ options }: { options: ToastOptions }) {
  const { toast } = useToast();
  return <button onClick={() => toast(options)}>通知</button>;
}

describe("Toast", () => {
  afterEach(() => vi.useRealTimers());

  it("auto-dismisses normal toasts but keeps danger toasts until closed", async () => {
    vi.useFakeTimers();
    render(
      <ToastProvider duration={1000} closeLabel="关闭">
        <Fire options={{ title: "已保存", tone: "success" }} />
        <Fire options={{ title: "请求失败", tone: "danger" }} />
      </ToastProvider>,
    );
    const [ok, fail] = screen.getAllByRole("button", { name: "通知" });
    act(() => {
      fireEvent.click(ok!);
      fireEvent.click(fail!);
    });
    expect(screen.getByText("已保存")).toBeInTheDocument();
    expect(screen.getByText("请求失败")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(5000));
    expect(screen.queryByText("已保存")).toBeNull();
    expect(screen.getByText("请求失败")).toBeInTheDocument();
  });
});

describe("NavItem", () => {
  it("marks the current page and keeps actions visible while their menu is open", () => {
    render(
      <NavGroup label="工作">
        <NavItem label="知识库" selected actions={<button>操作</button>} actionsOpen />
        <NavItem label="已停用" disabled />
      </NavGroup>,
    );
    const current = screen.getByRole("button", { name: "知识库" });
    expect(current).toHaveAttribute("aria-current", "page");
    expect(current.closest("li")).toHaveClass("od-nav-item--actions-open", "od-nav-item--has-actions");
    expect(screen.getByRole("button", { name: "已停用" })).toHaveAttribute("aria-disabled", "true");
  });

  it("collapses a group with its toggle", () => {
    render(
      <NavGroup label="工作">
        <NavItem label="知识库" />
      </NavGroup>,
    );
    const toggle = screen.getByRole("button", { name: "工作" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: "知识库" })).toBeNull();
  });
});

describe("CommandPalette loading", () => {
  it("marks the list busy while external results load", () => {
    render(<CommandPalette open onOpenChange={() => undefined} groups={[]} label="命令面板" emptyText="无结果" filter={false} loading loadingLabel="搜索中" />);
    expect(screen.getByRole("listbox")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("status", { name: "搜索中" })).toBeInTheDocument();
  });
});
