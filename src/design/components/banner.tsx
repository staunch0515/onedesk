import type { ReactNode } from "react";
import { cx } from "./cx";
import { Icon } from "./icon";
import { IconButton } from "./icon-button";
import "./banner.css";

export type BannerTone = "info" | "success" | "warning" | "danger";

const ICONS: Record<BannerTone, string> = {
  info: "info",
  success: "circle-check",
  warning: "triangle-alert",
  danger: "circle-alert",
};

export interface BannerProps {
  tone?: BannerTone;
  title?: ReactNode;
  children?: ReactNode;
  /** Actions on the right (small buttons). */
  actions?: ReactNode;
  /** Shows a close button when both are given. */
  onDismiss?: () => void;
  dismissLabel?: string;
  className?: string;
}

/** Inline notice bar. Danger/warning use role="alert" so screen readers announce them. */
export function Banner({ tone = "info", title, children, actions, onDismiss, dismissLabel, className }: BannerProps) {
  return (
    <div className={cx("od-banner", `od-banner--${tone}`, className)} role={tone === "danger" || tone === "warning" ? "alert" : "status"}>
      <Icon name={ICONS[tone]} size="md" className="od-banner__icon" />
      <div className="od-banner__content">
        {title && <p className="od-banner__title">{title}</p>}
        {children && <div className="od-banner__body">{children}</div>}
      </div>
      {actions && <div className="od-banner__actions">{actions}</div>}
      {onDismiss && dismissLabel && <IconButton icon="x" label={dismissLabel} size="sm" onClick={onDismiss} className="od-banner__dismiss" />}
    </div>
  );
}
