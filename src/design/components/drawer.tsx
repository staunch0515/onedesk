import * as DialogPrimitive from "@radix-ui/react-dialog";
import type { ReactElement, ReactNode } from "react";
import { cx } from "./cx";
import { IconButton } from "./icon-button";
import "./drawer.css";

export interface DrawerProps {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  trigger?: ReactElement;
  title: ReactNode;
  description?: ReactNode;
  footer?: ReactNode;
  /** aria-label of the close button; the close button is hidden when omitted. */
  closeLabel?: string;
  children?: ReactNode;
  className?: string;
}

/** Side panel sliding in from the right; modal, same focus behaviour as Dialog. */
export function Drawer({ open, defaultOpen, onOpenChange, trigger, title, description, footer, closeLabel, children, className }: DrawerProps) {
  return (
    <DialogPrimitive.Root open={open} defaultOpen={defaultOpen} onOpenChange={onOpenChange}>
      {trigger && <DialogPrimitive.Trigger asChild>{trigger}</DialogPrimitive.Trigger>}
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="od-drawer__overlay" />
        <DialogPrimitive.Content className={cx("od-drawer", className)} {...(description ? {} : { "aria-describedby": undefined })}>
          <div className="od-drawer__header">
            <div className="od-drawer__titles">
              <DialogPrimitive.Title className="od-drawer__title">{title}</DialogPrimitive.Title>
              {description && <DialogPrimitive.Description className="od-drawer__description">{description}</DialogPrimitive.Description>}
            </div>
            {closeLabel && (
              <DialogPrimitive.Close asChild>
                <IconButton icon="x" label={closeLabel} size="sm" tooltipSide="left" />
              </DialogPrimitive.Close>
            )}
          </div>
          <div className="od-drawer__body">{children}</div>
          {footer && <div className="od-drawer__footer">{footer}</div>}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
