import { cx } from "./cx";
import "./spinner.css";

export interface SpinnerProps {
  size?: "sm" | "md" | "lg";
  /** Accessible label; without it the spinner is decorative (e.g. inside a labelled button). */
  label?: string;
  className?: string;
}

export function Spinner({ size = "md", label, className }: SpinnerProps) {
  return (
    <span
      className={cx("od-spinner", `od-spinner--${size}`, className)}
      role={label ? "status" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  );
}

export interface ProgressProps {
  /** 0–100. Omit for an indeterminate bar. */
  value?: number;
  label?: string;
  className?: string;
}

/** Linear progress. Determinate uses the native `<progress>` element (no inline width needed). */
export function Progress({ value, label, className }: ProgressProps) {
  if (value === undefined) {
    return (
      <span className={cx("od-progress", "od-progress--indeterminate", className)} role="progressbar" aria-label={label}>
        <span className="od-progress__bar" />
      </span>
    );
  }
  const clamped = Math.min(100, Math.max(0, value));
  return <progress className={cx("od-progress", className)} max={100} value={clamped} aria-label={label} />;
}
