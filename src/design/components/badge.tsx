import type { ReactNode } from "react";
import { cx } from "./cx";
import { Icon } from "./icon";
import "./badge.css";

export type Tone = "neutral" | "accent" | "success" | "warning" | "danger" | "info";

export interface BadgeProps {
  tone?: Tone;
  /** lucide icon name before the text. */
  icon?: string;
  /** Small coloured dot before the text (status). Ignored when `icon` is set. */
  dot?: boolean;
  children: ReactNode;
  className?: string;
}

export function Badge({ tone = "neutral", icon, dot = false, children, className }: BadgeProps) {
  return (
    <span className={cx("od-badge", `od-badge--${tone}`, className)}>
      {icon ? <Icon name={icon} size="xs" /> : dot ? <span className="od-badge__dot" aria-hidden="true" /> : null}
      {children}
    </span>
  );
}
