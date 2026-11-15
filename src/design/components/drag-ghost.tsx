import type { CSSProperties } from "react";
import { createPortal } from "react-dom";
import { cx } from "./cx";
import { Icon } from "./icon";
import "./drag-ghost.css";

export interface DragGhostProps {
  x: number;
  y: number;
  label: string;
  icon?: string;
  /** Shows the uniform "cannot drop here" look (I.0g). */
  denied?: boolean;
  /** Text shown next to the label while denied. */
  deniedLabel?: string;
}

/** Small chip that follows the pointer during a drag. The same chip is used by every tree and the tab strip. */
export function DragGhost({ x, y, label, icon, denied, deniedLabel }: DragGhostProps) {
  const style = { "--od-ghost-x": `${Math.round(x)}px`, "--od-ghost-y": `${Math.round(y)}px` } as CSSProperties;
  return createPortal(
    <div
      className={cx("od-drag-ghost", denied && "od-drag-ghost--denied")}
      style={style} // od-allow-inline-style: follows the pointer
      role="status"
    >
      <Icon name={denied ? "ban" : (icon ?? "grip-vertical")} size="sm" />
      <span className="od-drag-ghost__label">{label}</span>
      {denied && deniedLabel && <span className="od-drag-ghost__denied">{deniedLabel}</span>}
    </div>,
    document.body,
  );
}
