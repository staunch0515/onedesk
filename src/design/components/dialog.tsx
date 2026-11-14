import * as DialogPrimitive from "@radix-ui/react-dialog";
import type { ReactElement, ReactNode } from "react";
import { cx } from "./cx";
import { IconButton } from "./icon-button";
import "./dialog.css";

export interface DialogProps {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Optional trigger element (rendered `asChild`). */
  trigger?: ReactElement;
  title: ReactNode;
  description?: ReactNode;
  /** Buttons, right-aligned; the primary action goes last. */
  footer?: ReactNode;
  /** aria-label of the close button; the close button is hidden when omitted. */
  closeLabel?: string;
  size?: "sm" | "md" | "lg";
  /** Prevent closing by clicking the backdrop (e.g. while saving). Escape still closes unless `dismissible` is false. */
  dismissible?: boolean;
  children?: ReactNode;
  className?: string;
}

/** Modal dialog: focus is trapped while open and returns to the trigger on close (Radix). */
export function Dialog({
  open,
  defaultOpen,
  onOpenChange,
  trigger,
  title,
  description,
  footer,
  closeLabel,
  size = "md",
  dismissible = true,
  children,
  className,
}: DialogProps) {
  const block = (e: Event) => {
    if (!dismissible) e.preventDefault();
  };
  return (
    <DialogPrimitive.Root open={open} defaultOpen={defaultOpen} onOpenChange={onOpenChange}>
      {trigger && <DialogPrimitive.Trigger asChild>{trigger}</DialogPrimitive.Trigger>}
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="od-dialog__overlay" />
        <DialogPrimitive.Content
          className={cx("od-dialog", `od-dialog--${size}`, className)}
          onPointerDownOutside={block}
          onEscapeKeyDown={block}
          {...(description ? {} : { "aria-describedby": undefined })}
        >
          <div className="od-dialog__header">
            <div className="od-dialog__titles">
              <DialogPrimitive.Title className="od-dialog__title">{title}</DialogPrimitive.Title>
              {description && <DialogPrimitive.Description className="od-dialog__description">{description}</DialogPrimitive.Description>}
            </div>
            {closeLabel && (
              <DialogPrimitive.Close asChild>
                <IconButton icon="x" label={closeLabel} size="sm" className="od-dialog__close" />
              </DialogPrimitive.Close>
            )}
          </div>
          {children !== undefined && <div className="od-dialog__body">{children}</div>}
          {footer && <div className="od-dialog__footer">{footer}</div>}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/** Wrap a footer button so clicking it closes the dialog. */
export function DialogClose({ children }: { children: ReactElement }) {
  return <DialogPrimitive.Close asChild>{children}</DialogPrimitive.Close>;
}
