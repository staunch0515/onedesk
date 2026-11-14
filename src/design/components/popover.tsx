import * as PopoverPrimitive from "@radix-ui/react-popover";
import { useId, type ReactElement, type ReactNode } from "react";
import { cx } from "./cx";
import "./popover.css";

export interface PopoverProps {
  /** Trigger element (rendered `asChild`). */
  trigger: ReactElement;
  children: ReactNode;
  /** Optional heading; also used as the accessible name. */
  title?: ReactNode;
  /** Accessible name when there is no visible title. */
  label?: string;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  size?: "sm" | "md";
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
}

/** Non-modal floating panel (filters, small forms, details). Escape and outside click close it. */
export function Popover({ trigger, children, title, label, side = "bottom", align = "start", size = "md", open, defaultOpen, onOpenChange, className }: PopoverProps) {
  const titleId = useId();
  return (
    <PopoverPrimitive.Root open={open} defaultOpen={defaultOpen} onOpenChange={onOpenChange}>
      <PopoverPrimitive.Trigger asChild>{trigger}</PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          className={cx("od-popover", `od-popover--${size}`, className)}
          side={side}
          align={align}
          sideOffset={6}
          collisionPadding={8}
          aria-label={title ? undefined : label}
          aria-labelledby={title ? titleId : undefined}
        >
          {title && <div className="od-popover__title" id={titleId}>{title}</div>}
          {children}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
