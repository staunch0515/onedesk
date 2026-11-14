import type { ReactNode } from "react";
import { cx } from "./cx";
import "./text.css";

export interface TextProps {
  as?: "span" | "p" | "div" | "h2" | "h3" | "label";
  size?: "xs" | "sm" | "md" | "lg" | "xl";
  tone?: "default" | "muted" | "subtle" | "accent" | "success" | "warning" | "danger" | "info";
  weight?: "regular" | "medium" | "semibold";
  mono?: boolean;
  tabular?: boolean;
  truncate?: boolean;
  id?: string;
  children: ReactNode;
  className?: string;
}

/** Typography primitive so pages can set size/tone/weight without one-off CSS. */
export function Text({ as: Tag = "span", size = "md", tone = "default", weight = "regular", mono, tabular, truncate, id, children, className }: TextProps) {
  return (
    <Tag
      id={id}
      className={cx(
        "od-text",
        `od-text--${size}`,
        `od-text--${tone}`,
        `od-text--${weight}`,
        mono && "od-mono",
        tabular && "od-tabular",
        truncate && "od-text--truncate",
        className,
      )}
    >
      {children}
    </Tag>
  );
}
