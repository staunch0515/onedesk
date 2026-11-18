import * as MenuPrimitive from "@radix-ui/react-dropdown-menu";
import type { ReactElement, ReactNode } from "react";
import { cx } from "./cx";
import { Icon } from "./icon";
import { Kbd } from "./kbd";
import "./dropdown-menu.css";

export type MenuEntry =
  | {
      type?: "item";
      key: string;
      label: ReactNode;
      icon?: string;
      shortcut?: string[];
      disabled?: boolean;
      /** Destructive actions render in red. */
      danger?: boolean;
      onSelect: () => void;
    }
  | { type: "checkbox"; key: string; label: ReactNode; checked: boolean; disabled?: boolean; onCheckedChange: (checked: boolean) => void }
  | { type: "separator"; key: string }
  | { type: "label"; key: string; label: ReactNode };

export interface DropdownMenuProps {
  /** Trigger element (rendered `asChild`); usually a Button or IconButton. */
  trigger: ReactElement;
  items: MenuEntry[];
  align?: "start" | "center" | "end";
  side?: "top" | "right" | "bottom" | "left";
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function DropdownMenu({ trigger, items, align = "start", side = "bottom", open, onOpenChange }: DropdownMenuProps) {
  // When some entry has an icon, the ones without keep an empty slot so the texts stay aligned.
  const anyIcon = items.some((e) => e.type === "checkbox" || (!e.type && Boolean(e.icon)));
  return (
    <MenuPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <MenuPrimitive.Trigger asChild>{trigger}</MenuPrimitive.Trigger>
      <MenuPrimitive.Portal>
        <MenuPrimitive.Content className="od-menu" align={align} side={side} sideOffset={4} collisionPadding={8} loop>
          {items.map((entry) => {
            switch (entry.type) {
              case "separator":
                return <MenuPrimitive.Separator key={entry.key} className="od-menu__separator" />;
              case "label":
                return (
                  <MenuPrimitive.Label key={entry.key} className="od-menu__label">
                    {entry.label}
                  </MenuPrimitive.Label>
                );
              case "checkbox":
                return (
                  <MenuPrimitive.CheckboxItem
                    key={entry.key}
                    className="od-menu__item"
                    checked={entry.checked}
                    disabled={entry.disabled}
                    onCheckedChange={entry.onCheckedChange}
                    onSelect={(e) => e.preventDefault()}
                  >
                    <span className="od-menu__check">
                      <MenuPrimitive.ItemIndicator>
                        <Icon name="check" size="md" />
                      </MenuPrimitive.ItemIndicator>
                    </span>
                    <span className="od-menu__text">{entry.label}</span>
                  </MenuPrimitive.CheckboxItem>
                );
              default:
                return (
                  <MenuPrimitive.Item
                    key={entry.key}
                    className={cx("od-menu__item", entry.danger && "od-menu__item--danger")}
                    disabled={entry.disabled}
                    onSelect={entry.onSelect}
                  >
                    {entry.icon ? <Icon name={entry.icon} size="md" className="od-menu__icon" /> : anyIcon ? <span className="od-menu__icon od-menu__icon--empty" aria-hidden="true" /> : null}
                    <span className="od-menu__text">{entry.label}</span>
                    {entry.shortcut && <Kbd keys={entry.shortcut} className="od-menu__shortcut" />}
                  </MenuPrimitive.Item>
                );
            }
          })}
        </MenuPrimitive.Content>
      </MenuPrimitive.Portal>
    </MenuPrimitive.Root>
  );
}
