import { cx } from "./cx";
import "./text-block.css";

export interface TextBlockProps {
  /** Shown as written: line breaks and spaces are kept, long lines wrap (never cut off). */
  children: string;
  /** `code` uses the monospace font on a subtle bordered surface. */
  variant?: "plain" | "code";
  tone?: "default" | "muted" | "success" | "warning" | "danger";
  /** Accessible name for code blocks (e.g. the node title). */
  label?: string;
  className?: string;
}

/** Multi-line text that preserves whitespace: plain paragraphs or a code block. */
export function TextBlock({ children, variant = "plain", tone = "default", label, className }: TextBlockProps) {
  if (variant === "code") {
    return (
      <pre className={cx("od-text-block", "od-text-block--code", `od-text-block--${tone}`, className)} aria-label={label}>
        <code className="od-mono">{children}</code>
      </pre>
    );
  }
  return <div className={cx("od-text-block", "od-text-block--plain", `od-text-block--${tone}`, className)}>{children}</div>;
}
