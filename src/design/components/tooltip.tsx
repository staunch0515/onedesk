import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import type { ReactElement, ReactNode } from "react";
import { Kbd } from "./kbd";
import "./tooltip.css";

export interface TooltipProps {
  content: ReactNode;
  /** Optional shortcut shown after the text, e.g. `["⌘", "K"]`. */
  shortcut?: string[];
  side?: "top" | "right" | "bottom" | "left";
  /** The trigger. Must accept a ref and forward props (Button, IconButton, plain elements). */
  children: ReactElement;
}

/** Delay before showing, in ms. Mirrors --duration-tooltip-delay (Radix needs a number). */
const OPEN_DELAY = 400;

/**
 * Tooltip on hover and keyboard focus. Each tooltip carries its own Radix provider so it works
 * anywhere without app-level setup.
 */
export function Tooltip({ content, shortcut, side = "top", children }: TooltipProps) {
  return (
    <TooltipPrimitive.Provider delayDuration={OPEN_DELAY} skipDelayDuration={0}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content className="od-tooltip" side={side} sideOffset={6} collisionPadding={8}>
            <span>{content}</span>
            {shortcut && shortcut.length > 0 && <Kbd keys={shortcut} tone="inverse" />}
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}
