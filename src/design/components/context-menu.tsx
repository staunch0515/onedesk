import type { CSSProperties } from "react";
import { DropdownMenu, type MenuEntry } from "./dropdown-menu";
import "./context-menu.css";

export interface ContextMenuProps {
  /** Where the menu opens (viewport coordinates); null = closed. */
  point: { x: number; y: number } | null;
  items: MenuEntry[];
  onClose: () => void;
}

/** Right-click menu: the shared DropdownMenu anchored to an invisible point, so every menu looks the same (D197). */
export function ContextMenu({ point, items, onClose }: ContextMenuProps) {
  if (!point || items.length === 0) return null;
  const style = { "--od-anchor-x": `${Math.round(point.x)}px`, "--od-anchor-y": `${Math.round(point.y)}px` } as CSSProperties;
  return (
    <DropdownMenu
      key={`${point.x}:${point.y}`}
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      items={items}
      trigger={
        <span
          className="od-context-anchor"
          aria-hidden="true"
          style={style} // od-allow-inline-style: menu opens at the pointer
        />
      }
    />
  );
}
