import type { ReactNode } from "react";
import { Button } from "./button";
import { cx } from "./cx";
import { Icon } from "./icon";
import { Spinner } from "./spinner";
import "./states.css";

interface StateBase {
  /** `inline` for small areas (table body, panel); `page` fills the content area. */
  layout?: "page" | "inline";
  className?: string;
}

export interface LoadingStateProps extends StateBase {
  label: string;
}

export function LoadingState({ label, layout = "page", className }: LoadingStateProps) {
  return (
    <div className={cx("od-state", `od-state--${layout}`, className)} role="status" aria-live="polite">
      <Spinner size="md" />
      <p className="od-state__muted">{label}</p>
    </div>
  );
}

export interface EmptyStateProps extends StateBase {
  /** One sentence telling the user what to do next. No illustration (B 节). */
  message: ReactNode;
  /** Optional lucide icon, kept small and neutral. */
  icon?: string;
  /** Optional action, e.g. a primary Button. */
  action?: ReactNode;
}

export function EmptyState({ message, icon, action, layout = "page", className }: EmptyStateProps) {
  return (
    <div className={cx("od-state", `od-state--${layout}`, className)}>
      {icon && (
        <span className="od-state__icon">
          <Icon name={icon} size="lg" />
        </span>
      )}
      <p className="od-state__message">{message}</p>
      {action && <div className="od-state__actions">{action}</div>}
    </div>
  );
}

export interface ErrorStateProps extends StateBase {
  title: ReactNode;
  /** Why it failed. */
  reason: ReactNode;
  /** What the user can do about it. */
  resolution?: ReactNode;
  onRetry?: () => void;
  retryLabel?: string;
  retrying?: boolean;
  /** Extra actions next to retry. */
  actions?: ReactNode;
}

export function ErrorState({ title, reason, resolution, onRetry, retryLabel, retrying, actions, layout = "page", className }: ErrorStateProps) {
  return (
    <div className={cx("od-state", "od-state--error", `od-state--${layout}`, className)} role="alert">
      <span className="od-state__icon od-state__icon--danger">
        <Icon name="circle-alert" size="lg" />
      </span>
      <p className="od-state__title">{title}</p>
      <p className="od-state__reason">{reason}</p>
      {resolution && <p className="od-state__muted">{resolution}</p>}
      {((onRetry && retryLabel) || actions) && (
        <div className="od-state__actions">
          {onRetry && retryLabel && (
            <Button icon="rotate-cw" onClick={onRetry} loading={retrying}>
              {retryLabel}
            </Button>
          )}
          {actions}
        </div>
      )}
    </div>
  );
}
