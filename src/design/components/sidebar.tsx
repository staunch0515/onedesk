import { useId, useState, type HTMLAttributes, type ReactNode, type Ref } from "react";
import { cx } from "./cx";
import { Icon } from "./icon";
import { Tooltip } from "./tooltip";
import "./sidebar.css";

export interface SidebarProps {
  /** Accessible name of the navigation landmark. */
  label: string;
  /** Top area (app name, workspace switcher). Same height as the top bar. */
  header?: ReactNode;
  /** Bottom area (settings, plugins). */
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function Sidebar({ label, header, footer, children, className }: SidebarProps) {
  return (
    <nav className={cx("od-sidebar", className)} aria-label={label}>
      {header && <div className="od-sidebar__header">{header}</div>}
      <div className="od-sidebar__body">{children}</div>
      {footer && <div className="od-sidebar__footer">{footer}</div>}
    </nav>
  );
}

export interface NavGroupProps {
  /** Group title. Omit for an untitled top section. */
  label?: ReactNode;
  /** Collapsible groups toggle with click, Enter or Space. Default true when a label is given. */
  collapsible?: boolean;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Small actions on the right of the title (e.g. an IconButton to add). */
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function NavGroup({ label, collapsible = Boolean(label), open, defaultOpen = true, onOpenChange, actions, children, className }: NavGroupProps) {
  const [innerOpen, setInnerOpen] = useState(defaultOpen);
  const isOpen = open ?? innerOpen;
  const listId = useId();
  const toggle = () => {
    const next = !isOpen;
    if (open === undefined) setInnerOpen(next);
    onOpenChange?.(next);
  };
  return (
    <section className={cx("od-nav-group", className)}>
      {label && (
        <div className="od-nav-group__header">
          {collapsible ? (
            <button type="button" className="od-nav-group__toggle" aria-expanded={isOpen} aria-controls={listId} onClick={toggle}>
              <span className="od-nav-group__label">{label}</span>
              <Icon name="chevron-right" size="sm" className={cx("od-nav-group__chevron", isOpen && "od-nav-group__chevron--open")} />
            </button>
          ) : (
            <span className="od-nav-group__toggle od-nav-group__toggle--static">
              <span className="od-nav-group__label">{label}</span>
            </span>
          )}
          {actions && <span className="od-nav-group__actions">{actions}</span>}
        </div>
      )}
      <ul id={listId} className="od-nav-group__list" role="list" hidden={!isOpen}>
        {children}
      </ul>
    </section>
  );
}

export interface NavItemProps extends Omit<HTMLAttributes<HTMLLIElement>, "onSelect"> {
  label: ReactNode;
  /** lucide icon name. */
  icon?: string;
  selected?: boolean;
  /** Greyed out (e.g. resource of a disabled plugin) but still focusable and selectable, so the reason can be shown. */
  disabled?: boolean;
  /** Warning text; shows a warning icon with this text as tooltip and accessible label. */
  warning?: string;
  /** Trailing count or short meta. */
  meta?: ReactNode;
  /** Drag handle slot (e.g. <DragHandle {...listeners} />); shown on hover/focus. */
  dragHandle?: ReactNode;
  /** Trailing actions shown on hover/focus (e.g. an IconButton opening a DropdownMenu). */
  actions?: ReactNode;
  onSelect?: () => void;
  /** Ref to the <li> (sortable wrappers need it). */
  ref?: Ref<HTMLLIElement>;
}

/**
 * One menu entry. Extra props (style for drag transforms, data-*, ref) go to the <li>, so a sortable
 * wrapper can position it — D31 allows inline `transform` only for drag sorting.
 */
export function NavItem({ label, icon, selected = false, disabled = false, warning, meta, dragHandle, actions, onSelect, className, ref, ...rest }: NavItemProps) {
  return (
    <li
      ref={ref}
      className={cx("od-nav-item", selected && "od-nav-item--selected", disabled && "od-nav-item--disabled", dragHandle !== undefined && "od-nav-item--draggable", className)}
      {...rest}
    >
      {dragHandle !== undefined && <span className="od-nav-item__handle">{dragHandle}</span>}
      <button
        type="button"
        className="od-nav-item__button"
        aria-current={selected ? "page" : undefined}
        aria-disabled={disabled || undefined}
        onClick={onSelect}
      >
        {icon && <Icon name={icon} size="md" className="od-nav-item__icon" />}
        <span className="od-nav-item__label">{label}</span>
      </button>
      {warning && (
        <Tooltip content={warning} side="right">
          <span className="od-nav-item__warning" role="img" aria-label={warning} tabIndex={0}>
            <Icon name="triangle-alert" size="sm" />
          </span>
        </Tooltip>
      )}
      {meta !== undefined && <span className="od-nav-item__meta od-tabular">{meta}</span>}
      {actions && <span className="od-nav-item__actions">{actions}</span>}
    </li>
  );
}

export interface DragHandleProps extends HTMLAttributes<HTMLButtonElement> {
  /** Accessible name, e.g. "拖动排序" from i18n. */
  label: string;
  ref?: Ref<HTMLButtonElement>;
}

/** Grip button for drag sorting; spread dnd-kit `attributes` and `listeners` onto it. */
export function DragHandle({ label, className, ref, ...rest }: DragHandleProps) {
  return (
    <button ref={ref} type="button" aria-label={label} className={cx("od-drag-handle", className)} {...rest}>
      <Icon name="grip-vertical" size="sm" />
    </button>
  );
}
