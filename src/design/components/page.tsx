import type { ReactNode } from "react";
import { cx } from "./cx";
import { Icon } from "./icon";
import "./page.css";

export interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  /** lucide icon name shown before the title. */
  icon?: string;
  /** Small inline meta after the title (Badges). */
  meta?: ReactNode;
  /** Action area on the right; primary action last. */
  actions?: ReactNode;
  /** Content under the header row, e.g. Tabs. */
  children?: ReactNode;
  className?: string;
}

/** Page title area + action area (B: 页面统一：标题区、操作区、内容区). */
export function PageHeader({ title, description, icon, meta, actions, children, className }: PageHeaderProps) {
  return (
    <header className={cx("od-page-header", className)}>
      <div className="od-page-header__row">
        {icon && (
          <span className="od-page-header__icon">
            <Icon name={icon} size="lg" />
          </span>
        )}
        <div className="od-page-header__titles">
          <div className="od-page-header__title-row">
            <h1 className="od-page-header__title">{title}</h1>
            {meta && <div className="od-page-header__meta">{meta}</div>}
          </div>
          {description && <p className="od-page-header__description">{description}</p>}
        </div>
        {actions && <div className="od-page-header__actions">{actions}</div>}
      </div>
      {children}
    </header>
  );
}

export interface PageBodyProps {
  /** `readable` caps the width for prose and forms; `full` uses all available width. */
  width?: "full" | "default" | "readable";
  children: ReactNode;
  className?: string;
}

export function PageBody({ width = "default", children, className }: PageBodyProps) {
  return <div className={cx("od-page-body", `od-page-body--${width}`, className)}>{children}</div>;
}

export interface PageProps {
  children: ReactNode;
  className?: string;
}

/** Vertical page container: PageHeader then PageBody, sharing horizontal padding. */
export function Page({ children, className }: PageProps) {
  return <div className={cx("od-page", className)}>{children}</div>;
}

export interface StackProps {
  gap?: "xs" | "sm" | "md" | "lg";
  direction?: "column" | "row";
  align?: "start" | "center" | "end" | "stretch" | "baseline";
  justify?: "start" | "center" | "end" | "between";
  wrap?: boolean;
  children: ReactNode;
  className?: string;
}

/** Layout helper so pages never need one-off CSS for spacing. */
export function Stack({ gap = "md", direction = "column", align, justify, wrap, children, className }: StackProps) {
  return (
    <div
      className={cx(
        "od-stack",
        `od-stack--${direction}`,
        `od-stack--gap-${gap}`,
        align && `od-stack--align-${align}`,
        justify && `od-stack--justify-${justify}`,
        wrap && "od-stack--wrap",
        className,
      )}
    >
      {children}
    </div>
  );
}
