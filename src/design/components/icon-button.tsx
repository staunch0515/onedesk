import type { ButtonHTMLAttributes, Ref } from "react";
import { cx } from "./cx";
import { Icon } from "./icon";
import { Spinner } from "./spinner";
import { Tooltip } from "./tooltip";
import "./icon-button.css";

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "aria-label"> {
  /** lucide icon name. */
  icon: string;
  /** Required: used as `aria-label` and as the tooltip text. */
  label: string;
  variant?: "ghost" | "secondary";
  size?: "sm" | "md";
  /** Shortcut shown in the tooltip, e.g. `["⌘", "K"]`. */
  shortcut?: string[];
  tooltipSide?: "top" | "right" | "bottom" | "left";
  loading?: boolean;
  ref?: Ref<HTMLButtonElement>;
}

export function IconButton({
  icon,
  label,
  variant = "ghost",
  size = "md",
  shortcut,
  tooltipSide,
  loading = false,
  disabled,
  className,
  type = "button",
  ref,
  ...rest
}: IconButtonProps) {
  const iconSize = size === "sm" ? "sm" : "md";
  return (
    <Tooltip content={label} shortcut={shortcut} side={tooltipSide}>
      <button
        ref={ref}
        type={type}
        aria-label={label}
        aria-busy={loading || undefined}
        disabled={disabled || loading}
        className={cx("od-icon-button", `od-icon-button--${variant}`, `od-icon-button--${size}`, className)}
        {...rest}
      >
        {loading ? <Spinner size={iconSize} /> : <Icon name={icon} size={iconSize} />}
      </button>
    </Tooltip>
  );
}
