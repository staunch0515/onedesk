import { Fragment, type ReactNode } from "react";
import { Button } from "./button";
import { cx } from "./cx";
import { DropdownMenu, type MenuEntry } from "./dropdown-menu";
import { Icon } from "./icon";
import { IconButton } from "./icon-button";
import { Tooltip } from "./tooltip";
import "./page-frame.css";

/* ------------------------------------------------------------------ page frame */

export interface PageFrameProps {
  /** Title bar (PageTitleBar): the breadcrumb row and the actions row. */
  header: ReactNode;
  /** Message strip under the header (conflict, read-only, missing plugin). */
  notice?: ReactNode;
  /** Content row: the page content and, optionally, splitter + info panel. */
  children: ReactNode;
  /** Splitter + result area under the content. */
  panel?: ReactNode;
}

/** The fixed frame every tab page shares (§9, D465): breadcrumb + actions, content (+ info), result area. */
export function PageFrame({ header, notice, children, panel }: PageFrameProps) {
  return (
    <div className="od-pf">
      {header}
      {notice && <div className="od-pf__notice">{notice}</div>}
      <div className="od-pf__content">{children}</div>
      {panel}
    </div>
  );
}

export interface BreadcrumbItem {
  key: string;
  label: string;
  icon?: string;
  onClick?: () => void;
}

export interface PageTitleBarProps {
  icon: string;
  title: ReactNode;
  /** The path to the page's object in its tree, without the object itself. */
  crumbs?: BreadcrumbItem[];
  /** Accessible name of the breadcrumb row. */
  crumbsLabel: string;
  /** Badges right after the title (kind, state, unsaved). */
  meta?: ReactNode;
  /** First in the actions row, set apart by a hairline (the environment selector). */
  lead?: ReactNode;
  /** Action bar, after `lead`, on the left. */
  actions?: ReactNode;
  /** Right end of the actions row (the info toggle). */
  aside?: ReactNode;
}

/**
 * The top of a page (D465). Row one: the path, then the object's name in bold (the page's `h1`) and its badges. Row two
 * (only when it has something): `lead`, then the actions on the left, `aside` at the right end. Both rows have the tab
 * strip's size (`--chrome-*`).
 */
export function PageTitleBar({ icon, title, crumbs = [], crumbsLabel, meta, lead, actions, aside }: PageTitleBarProps) {
  return (
    <header className="od-titlebar">
      <div className="od-titlebar__row">
        <nav className="od-titlebar__crumbs" aria-label={crumbsLabel}>
          {crumbs.map((item) => (
            <Fragment key={item.key}>
              {item.onClick ? (
                <button type="button" className="od-crumbs__item od-crumbs__item--link" onClick={item.onClick}>
                  {item.icon && <Icon name={item.icon} size="sm" />}
                  <span className="od-crumbs__label">{item.label}</span>
                </button>
              ) : (
                <span className="od-crumbs__item">
                  {item.icon && <Icon name={item.icon} size="sm" />}
                  <span className="od-crumbs__label">{item.label}</span>
                </span>
              )}
              <Icon name="chevron-right" size="xs" className="od-crumbs__sep" />
            </Fragment>
          ))}
          <span className="od-titlebar__current" aria-current="page">
            <Icon name={icon} size="sm" className="od-titlebar__icon" />
            <h1 className="od-titlebar__title">{title}</h1>
          </span>
          {meta && <div className="od-titlebar__meta">{meta}</div>}
        </nav>
      </div>
      {(lead || actions || aside) && (
        <div className="od-titlebar__actions-row">
          {lead && <div className="od-titlebar__lead">{lead}</div>}
          {actions && <div className="od-titlebar__actions">{actions}</div>}
          {aside && <div className="od-titlebar__aside">{aside}</div>}
        </div>
      )}
    </header>
  );
}

/** Fixed-width slot in the title bar's aside for a compact control (the environment selector). */
export function TitleBarSlot({ children }: { children: ReactNode }) {
  return <div className="od-titlebar__slot">{children}</div>;
}

export interface ActionBarItem {
  key: string;
  label: string;
  icon?: string;
  /** The main action (filled button). */
  primary?: boolean;
  danger?: boolean;
  disabled?: boolean;
  loading?: boolean;
  shortcut?: string[];
  onSelect: () => void;
}

export interface ActionBarProps {
  items: ActionBarItem[];
  /** Buttons shown before the rest go into "More" (I.0h: three to four). */
  max?: number;
  moreLabel: string;
  label?: string;
}

/** A page's action area. Position, style and the overflow rule are the frame's; the items are the page's. */
export function ActionBar({ items, max = 4, moreLabel, label }: ActionBarProps) {
  const shown = items.slice(0, max);
  const rest = items.slice(max);
  const menu: MenuEntry[] = rest.map((item) => ({
    key: item.key,
    label: item.label,
    icon: item.icon,
    danger: item.danger,
    disabled: item.disabled,
    shortcut: item.shortcut,
    onSelect: item.onSelect,
  }));
  return (
    <div className="od-actionbar" role="toolbar" aria-label={label}>
      {shown.map((item) => {
        const button = (
          <Button
            key={item.key}
            size="sm"
            variant={item.primary ? "primary" : item.danger ? "danger" : "secondary"}
            icon={item.icon}
            disabled={item.disabled}
            loading={item.loading}
            onClick={item.onSelect}
          >
            {item.label}
          </Button>
        );
        return item.shortcut ? (
          <Tooltip key={item.key} content={item.label} shortcut={item.shortcut} side="bottom">
            {button}
          </Tooltip>
        ) : (
          button
        );
      })}
      {rest.length > 0 && <DropdownMenu align="end" items={menu} trigger={<IconButton icon="ellipsis" label={moreLabel} size="sm" variant="secondary" />} />}
    </div>
  );
}

/* ------------------------------------------------------------------ info panel */

export interface InfoPanelProps {
  title: ReactNode;
  onClose?: () => void;
  closeLabel?: string;
  children: ReactNode;
  label?: string;
  /** Which side of the content it is on (the close icon points that way; D465). Default left. */
  side?: "left" | "right";
}

/** Info panel beside the page content (§9.3). Its width is set by the Sized wrapper and never follows the content. */
export function InfoPanel({ title, onClose, closeLabel, children, label, side = "left" }: InfoPanelProps) {
  return (
    <aside className="od-info" aria-label={label}>
      <div className="od-info__header">
        <h2 className="od-info__title">{title}</h2>
        {onClose && closeLabel && <IconButton icon={side === "left" ? "panel-left-close" : "panel-right-close"} label={closeLabel} size="sm" onClick={onClose} />}
      </div>
      <div className="od-info__body">{children}</div>
    </aside>
  );
}

export interface InfoFieldProps {
  label: ReactNode;
  children: ReactNode;
}

export function InfoField({ label, children }: InfoFieldProps) {
  return (
    <div className="od-info__field">
      <div className="od-info__label">{label}</div>
      <div className="od-info__value">{children}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ bottom panel */

export interface PanelTab {
  value: string;
  label: ReactNode;
  icon?: string;
  count?: number;
}

export interface BottomPanelProps {
  tabs: PanelTab[];
  value: string;
  onValueChange: (value: string) => void;
  /** Right end of the bar: summary text, then icon buttons (clear, collapse). */
  summary?: ReactNode;
  trailing?: ReactNode;
  /** Collapsed: only the bar remains. */
  collapsed?: boolean;
  children?: ReactNode;
  label: string;
}

/** Result area under the content (§9.5): sub-tabs chosen by the page, frame-owned toolbar. */
export function BottomPanel({ tabs, value, onValueChange, summary, trailing, collapsed, children, label }: BottomPanelProps) {
  return (
    <section className={cx("od-panel", collapsed && "od-panel--collapsed")} aria-label={label}>
      <div className="od-panel__bar">
        <div className="od-panel__tabs" role="tablist" aria-label={label}>
          {tabs.map((tab) => (
            <button
              key={tab.value}
              type="button"
              role="tab"
              aria-selected={tab.value === value}
              className={cx("od-panel__tab", tab.value === value && "od-panel__tab--active")}
              onClick={() => onValueChange(tab.value)}
            >
              {tab.icon && <Icon name={tab.icon} size="sm" />}
              {tab.label}
              {tab.count !== undefined && <span className="od-panel__count">{tab.count}</span>}
            </button>
          ))}
        </div>
        {summary && <div className="od-panel__summary">{summary}</div>}
        {trailing && <div className="od-panel__trailing">{trailing}</div>}
      </div>
      {!collapsed && (
        <div className="od-panel__body" role="tabpanel">
          {children}
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ field strip */

export interface FieldStripProps {
  children: ReactNode;
  label: string;
}

/** One-line (wrapping) strip of compact fields above an editor, e.g. query parameters. */
export function FieldStrip({ children, label }: FieldStripProps) {
  return (
    <div className="od-strip" role="group" aria-label={label}>
      {children}
    </div>
  );
}

export interface StripFieldProps {
  label: string;
  /** Explanation shown as an info icon with a tooltip after the label (I.7). */
  hint?: string;
  /** Where the value comes from when the user has not typed one ("From environment X"); shown as a small marker with a tooltip. */
  source?: string;
  wide?: boolean;
  /** Takes the room the other fields leave (a long text such as an address). */
  fill?: boolean;
  htmlFor?: string;
  /** Marks the label with a required star (the star is decoration; the control carries the state). */
  required?: boolean;
  children: ReactNode;
}

export function StripField({ label, hint, source, wide, fill, htmlFor, required, children }: StripFieldProps) {
  return (
    <div className={cx("od-strip__field", wide && "od-strip__field--wide", fill && "od-strip__field--fill")}>
      <div className="od-strip__label-row">
        <label className="od-strip__label od-mono" htmlFor={htmlFor}>
          {label}
          {required && <span aria-hidden="true"> *</span>}
        </label>
        {hint && (
          <Tooltip content={hint}>
            <span className="od-strip__hint" tabIndex={0}>
              <Icon name="info" size="xs" label={hint} />
            </span>
          </Tooltip>
        )}
        {source && (
          <Tooltip content={source}>
            <span className="od-strip__source" tabIndex={0}>
              <Icon name="layers" size="xs" label={source} />
            </span>
          </Tooltip>
        )}
      </div>
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ fact row */

export interface FactItem {
  key: string;
  label: ReactNode;
  value: ReactNode;
}

/** Horizontal run of small label/value pairs (run header, plugin facts). */
export function FactRow({ items }: { items: FactItem[] }) {
  return (
    <dl className="od-facts">
      {items.map((item) => (
        <div key={item.key} className="od-facts__item">
          <dt className="od-facts__label">{item.label}</dt>
          <dd className="od-facts__value">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
