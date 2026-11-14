import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";
import { cx } from "./cx";
import { Icon } from "./icon";
import { Spinner } from "./spinner";
import "./button.css";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner, disables the button and sets `aria-busy`. The label stays so the width does not jump. */
  loading?: boolean;
  /** lucide icon name shown before the label. */
  icon?: string;
  /** lucide icon name shown after the label. */
  trailingIcon?: string;
  children?: ReactNode;
  ref?: Ref<HTMLButtonElement>;
}

export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  icon,
  trailingIcon,
  disabled,
  className,
  children,
  type = "button",
  ref,
  ...rest
}: ButtonProps) {
  const iconSize = size === "sm" ? "sm" : "md";
  return (
    <button
      ref={ref}
      type={type}
      className={cx("od-button", `od-button--${variant}`, `od-button--${size}`, loading && "od-button--loading", className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Spinner size={iconSize} /> : icon ? <Icon name={icon} size={iconSize} /> : null}
      {children !== undefined && children !== null && <span className="od-button__label">{children}</span>}
      {trailingIcon && !loading && <Icon name={trailingIcon} size={iconSize} />}
    </button>
  );
}
