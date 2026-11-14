// @vitest-environment jsdom
import "../testing/jsdom-setup";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Button } from "./button";
import { Dialog, DialogClose } from "./dialog";
import { Drawer } from "./drawer";

function Example({ onOpenChange }: { onOpenChange?: (open: boolean) => void }) {
  return (
    <Dialog
      trigger={<Button>打开</Button>}
      title="删除资源"
      description="此操作无法撤销。"
      closeLabel="关闭"
      onOpenChange={onOpenChange}
      footer={
        <>
          <DialogClose>
            <Button>取消</Button>
          </DialogClose>
          <Button variant="danger">删除</Button>
        </>
      }
    />
  );
}

describe("Dialog", () => {
  it("opens from the trigger, moves focus inside, and labels itself", async () => {
    render(<Example />);
    fireEvent.click(screen.getByRole("button", { name: "打开" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveAccessibleName("删除资源");
    expect(dialog).toHaveAccessibleDescription("此操作无法撤销。");
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    // The close button is last in DOM order, so initial focus is not on it.
    expect(document.activeElement).not.toHaveAccessibleName("关闭");
  });

  it("closes with Escape and returns focus to the trigger", async () => {
    const onOpenChange = vi.fn();
    render(<Example onOpenChange={onOpenChange} />);
    const trigger = screen.getByRole("button", { name: "打开" });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = await screen.findByRole("dialog");
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("closes from a DialogClose button and from the close icon", async () => {
    render(<Example />);
    fireEvent.click(screen.getByRole("button", { name: "打开" }));
    fireEvent.click(await screen.findByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "打开" }));
    fireEvent.click(await screen.findByRole("button", { name: "关闭" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("ignores Escape when not dismissible", async () => {
    render(<Dialog open title="保存中" dismissible={false} onOpenChange={() => undefined} />);
    const dialog = await screen.findByRole("dialog");
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});

describe("Drawer", () => {
  it("opens as a labelled modal dialog", async () => {
    render(<Drawer trigger={<Button>详情</Button>} title="资源详情" closeLabel="关闭" />);
    fireEvent.click(screen.getByRole("button", { name: "详情" }));
    expect(await screen.findByRole("dialog")).toHaveAccessibleName("资源详情");
  });
});
