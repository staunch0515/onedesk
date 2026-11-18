// @vitest-environment jsdom
import "../testing/jsdom-setup";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Button } from "./button";
import { DropdownMenu } from "./dropdown-menu";

describe("DropdownMenu", () => {
  it("keeps an empty icon slot on entries without an icon when a sibling has one, so the texts line up", async () => {
    render(
      <DropdownMenu
        trigger={<Button>菜单</Button>}
        items={[
          { key: "a", label: "有勾", icon: "check", onSelect: () => undefined },
          { key: "b", label: "没勾", onSelect: () => undefined },
        ]}
      />,
    );
    fireEvent.pointerDown(screen.getByRole("button", { name: "菜单" }), { button: 0, ctrlKey: false });
    const items = await screen.findAllByRole("menuitem");
    expect(items[0]!.querySelector(".od-menu__icon:not(.od-menu__icon--empty)")).not.toBeNull();
    expect(items[1]!.querySelector(".od-menu__icon--empty")).not.toBeNull();
  });

  it("adds no slot when no entry has an icon", async () => {
    render(<DropdownMenu trigger={<Button>菜单</Button>} items={[{ key: "b", label: "没勾", onSelect: () => undefined }]} />);
    fireEvent.pointerDown(screen.getByRole("button", { name: "菜单" }), { button: 0, ctrlKey: false });
    const items = await screen.findAllByRole("menuitem");
    expect(items[0]!.querySelector(".od-menu__icon--empty")).toBeNull();
  });

  it("also keeps the slot when a checkbox entry (which has a check mark slot) sits with plain ones", async () => {
    render(
      <DropdownMenu
        trigger={<Button>菜单</Button>}
        items={[
          { type: "checkbox", key: "c", label: "勾选", checked: true, onCheckedChange: () => undefined },
          { key: "b", label: "普通", onSelect: () => undefined },
        ]}
      />,
    );
    fireEvent.pointerDown(screen.getByRole("button", { name: "菜单" }), { button: 0, ctrlKey: false });
    const plain = (await screen.findByText("普通")).closest("[role=menuitem]")!;
    expect(plain.querySelector(".od-menu__icon--empty")).not.toBeNull();
  });
});
