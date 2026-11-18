import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";
import { cx } from "./cx";
import { Icon } from "./icon";
import { IconButton } from "./icon-button";
import { Progress } from "./spinner";
import { Tooltip } from "./tooltip";
import "./workbench.css";

/* ------------------------------------------------------------------ frame */

export interface WorkbenchFrameProps {
  topbar: ReactNode;
  /** Activity bar, side panel, splitter and main area, left to right. */
  children: ReactNode;
  statusBar: ReactNode;
  /** Floating panels anchored above the status bar (task panel). */
  floating?: ReactNode;
  className?: string;
}

/** Window layout modelled on VS Code (I.8): top bar, a body row, status bar. */
export function WorkbenchFrame({ topbar, children, statusBar, floating, className }: WorkbenchFrameProps) {
  return (
    <div className={cx("od-wb", className)}>
      <header className="od-wb__topbar">{topbar}</header>
      <div className="od-wb__body">
        {children}
        {floating && <div className="od-wb__floating">{floating}</div>}
      </div>
      <footer className="od-wb__status">{statusBar}</footer>
    </div>
  );
}

export interface WorkbenchMainProps {
  /** Tab strip. */
  tabs: ReactNode;
  children: ReactNode;
  label?: string;
}

/** Editor area: tab strip on top, the active page below. */
export function WorkbenchMain({ tabs, children, label }: WorkbenchMainProps) {
  return (
    <main className="od-wb__main" aria-label={label}>
      {tabs}
      <div className="od-wb__page">{children}</div>
    </main>
  );
}

/* ------------------------------------------------------------------ activity bar */

export interface ActivityItem {
  key: string;
  icon: string;
  label: string;
  shortcut?: string[];
  /** Small count over the icon. */
  badge?: number;
}

export interface ActivityBarProps {
  items: ActivityItem[];
  /** Items pinned to the bottom (settings). */
  footer?: ActivityItem[];
  activeKey: string | null;
  onSelect: (key: string) => void;
  label: string;
}

/** Narrow icon column at the far left; picks what the side panel shows. */
export function ActivityBar({ items, footer, activeKey, onSelect, label }: ActivityBarProps) {
  const render = (item: ActivityItem) => (
    <Tooltip key={item.key} content={item.label} shortcut={item.shortcut} side="right">
      <button
        type="button"
        className={cx("od-activity__item", activeKey === item.key && "od-activity__item--active")}
        aria-label={item.label}
        aria-pressed={activeKey === item.key}
        onClick={() => onSelect(item.key)}
      >
        <Icon name={item.icon} size="lg" />
        {item.badge !== undefined && item.badge > 0 && <span className="od-activity__badge">{item.badge > 99 ? "99+" : item.badge}</span>}
      </button>
    </Tooltip>
  );
  return (
    <nav className="od-activity" aria-label={label}>
      <div className="od-activity__group">{items.map(render)}</div>
      {footer && footer.length > 0 && <div className="od-activity__group">{footer.map(render)}</div>}
    </nav>
  );
}

/* ------------------------------------------------------------------ side panel */

export interface SidePanelProps {
  title: ReactNode;
  /** Icon buttons in the title row (expand all, collapse all, new group). */
  actions?: ReactNode;
  /** Filter field under the title row. */
  filter?: ReactNode;
  children: ReactNode;
  label?: string;
}

/** Side panel: title row with the tree toolbar, filter, then the tree (I.0h). */
export function SidePanel({ title, actions, filter, children, label }: SidePanelProps) {
  return (
    <aside className="od-side" aria-label={label}>
      <div className="od-side__header">
        <h2 className="od-side__title">{title}</h2>
        {actions && <div className="od-side__actions">{actions}</div>}
      </div>
      {filter && <div className="od-side__filter">{filter}</div>}
      <div className="od-side__body">{children}</div>
    </aside>
  );
}

/* ------------------------------------------------------------------ status bar */

export interface StatusBarProps {
  start?: ReactNode;
  center?: ReactNode;
  end?: ReactNode;
  label?: string;
}

export function StatusBar({ start, center, end, label }: StatusBarProps) {
  return (
    <div className="od-statusbar" role="status" aria-label={label}>
      <div className="od-statusbar__start">{start}</div>
      <div className="od-statusbar__center">{center}</div>
      <div className="od-statusbar__end">{end}</div>
    </div>
  );
}

export interface StatusItemProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "title" | "onClick"> {
  icon?: string;
  children?: ReactNode;
  /** Tooltip. */
  title?: string;
  tone?: "default" | "accent" | "success" | "warning" | "danger";
  /** Spins the icon (running). */
  busy?: boolean;
  pressed?: boolean;
  onClick?: () => void;
  ref?: Ref<HTMLButtonElement>;
}

/** One entry in the status bar; a button when it has `onClick`. Extra props pass through so it can be a menu trigger. */
export function StatusItem({ icon, children, title, tone = "default", busy, pressed, onClick, ref, ...rest }: StatusItemProps) {
  const content = (
    <>
      {icon && <Icon name={icon} size="sm" className={busy ? "od-status-item__icon--busy" : undefined} />}
      {children !== undefined && children !== null && <span className="od-status-item__text">{children}</span>}
    </>
  );
  const className = cx("od-status-item", `od-status-item--${tone}`);
  const interactive = Boolean(onClick) || Object.keys(rest).length > 0;
  // An icon-only item has no text to name it: the tooltip text is its accessible name.
  const iconOnlyName = children === undefined || children === null ? title : undefined;
  const node = interactive ? (
    <button ref={ref} type="button" className={cx(className, "od-status-item--button")} aria-pressed={pressed} aria-label={iconOnlyName} onClick={onClick} {...rest}>
      {content}
    </button>
  ) : (
    <span className={className}>{content}</span>
  );
  return title ? <Tooltip content={title}>{node}</Tooltip> : node;
}

/* ------------------------------------------------------------------ pane (layout helper) */

export interface PaneProps {
  direction?: "row" | "column";
  /** Take the remaining space of the parent and allow shrinking. */
  grow?: boolean;
  scroll?: boolean;
  /** Keep its own height when the parent is shorter than its children (no squeezing). */
  fixed?: boolean;
  /** A filling pane never gets shorter than a usable editor, even among stacked sections. */
  fillMin?: boolean;
  pad?: "none" | "sm" | "md" | "lg";
  gap?: "none" | "xs" | "sm" | "md" | "lg";
  surface?: "none" | "surface" | "app" | "subtle";
  /** Hairline on one side. */
  border?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end" | "stretch";
  justify?: "start" | "center" | "end" | "between";
  /** Cap the content width for forms and prose. */
  width?: "full" | "form";
  wrap?: boolean;
  children?: ReactNode;
  className?: string;
}

/** Flex container for workbench layouts, so pages never need one-off CSS. */
export function Pane({
  direction = "column",
  grow,
  scroll,
  fixed,
  fillMin,
  pad = "none",
  gap = "none",
  surface = "none",
  border,
  align,
  justify,
  width,
  wrap,
  children,
  className,
}: PaneProps) {
  return (
    <div
      className={cx(
        "od-pane",
        `od-pane--${direction}`,
        grow && "od-pane--grow",
        scroll && "od-pane--scroll",
        fixed && "od-pane--fixed",
        fillMin && "od-pane--fill-min",
        pad !== "none" && `od-pane--pad-${pad}`,
        gap !== "none" && `od-pane--gap-${gap}`,
        surface !== "none" && `od-pane--${surface}`,
        border && `od-pane--border-${border}`,
        align && `od-pane--align-${align}`,
        justify && `od-pane--justify-${justify}`,
        width === "form" && "od-pane--form",
        wrap && "od-pane--wrap",
        className,
      )}
    >
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ floating panel + task rows */

export interface FloatingPanelProps {
  title: ReactNode;
  /** Buttons in the header, before the close button. */
  actions?: ReactNode;
  onClose: () => void;
  closeLabel: string;
  children: ReactNode;
  label?: string;
}

/** Non-modal panel docked above the status bar's right end (task panel, §8). */
export function FloatingPanel({ title, actions, onClose, closeLabel, children, label }: FloatingPanelProps) {
  return (
    <section className="od-float-panel" aria-label={label}>
      <header className="od-float-panel__header">
        <h2 className="od-float-panel__title">{title}</h2>
        <div className="od-float-panel__actions">
          {actions}
          <IconButton icon="x" label={closeLabel} size="sm" onClick={onClose} />
        </div>
      </header>
      <div className="od-float-panel__body">{children}</div>
    </section>
  );
}

export type TaskStatus = "running" | "success" | "error" | "cancelled";

export interface TaskItemProps {
  title: ReactNode;
  /** Second line: action · environment · time. */
  subtitle?: ReactNode;
  status: TaskStatus;
  /** 0–100; undefined while running = indeterminate. */
  progress?: number;
  /** Progress message or result summary. */
  detail?: ReactNode;
  /** Icon buttons at the right (cancel, open). */
  actions?: ReactNode;
  onOpen?: () => void;
  statusLabel: string;
}

const TASK_ICON: Record<TaskStatus, string> = {
  running: "loader",
  success: "circle-check",
  error: "circle-alert",
  cancelled: "circle-slash",
};

export function TaskItem({ title, subtitle, status, progress, detail, actions, onOpen, statusLabel }: TaskItemProps) {
  return (
    <div className={cx("od-task", `od-task--${status}`)}>
      <Icon name={TASK_ICON[status]} size="md" className={cx("od-task__icon", status === "running" && "od-task__icon--busy")} label={statusLabel} />
      <div className="od-task__main">
        {onOpen ? (
          <button type="button" className="od-task__title od-task__title--link" onClick={onOpen}>
            {title}
          </button>
        ) : (
          <span className="od-task__title">{title}</span>
        )}
        {subtitle && <span className="od-task__subtitle">{subtitle}</span>}
        {status === "running" && <Progress value={progress} label={statusLabel} className="od-task__progress" />}
        {detail && <span className="od-task__detail">{detail}</span>}
      </div>
      {actions && <div className="od-task__actions">{actions}</div>}
    </div>
  );
}
