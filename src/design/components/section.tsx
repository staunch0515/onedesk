import type { ReactNode } from "react";
import { cx } from "./cx";
import "./section.css";

export interface SectionProps {
  title?: ReactNode;
  description?: ReactNode;
  /** Actions at the right of the title row. */
  actions?: ReactNode;
  /** `card` draws a bordered surface; `plain` only spaces the content. */
  variant?: "card" | "plain";
  children: ReactNode;
  className?: string;
}

/** A titled block inside a page (settings groups, form sections, view nodes). */
export function Section({ title, description, actions, variant = "card", children, className }: SectionProps) {
  return (
    <section className={cx("od-section", `od-section--${variant}`, className)}>
      {(title || actions) && (
        <div className="od-section__header">
          <div className="od-section__titles">
            {title && <h2 className="od-section__title">{title}</h2>}
            {description && <p className="od-section__description">{description}</p>}
          </div>
          {actions && <div className="od-section__actions">{actions}</div>}
        </div>
      )}
      <div className="od-section__body">{children}</div>
    </section>
  );
}
