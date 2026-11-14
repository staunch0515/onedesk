import type { ReactNode } from "react";
import { cx } from "./cx";
import { Icon } from "./icon";
import { Kbd } from "./kbd";
import "./app-shell.css";

export interface AppShellProps {
  /** Usually a <Sidebar>. Spans the full window height on the left. */
  sidebar: ReactNode;
  /** Usually a <TopBar>. Sits above the content area. */
  topbar?: ReactNode;
  children: ReactNode;
  /** Accessible name of the main region. */
  mainLabel?: string;
  className?: string;
}

/** Window layout: fixed sidebar on the left, top bar and scrolling content on the right. */
export function AppShell({ sidebar, topbar, children, mainLabel, className }: AppShellProps) {
  return (
    <div className={cx("od-app", className)}>
      <div className="od-app__sidebar">{sidebar}</div>
      {topbar && <div className="od-app__topbar">{topbar}</div>}
      <main className={cx("od-app__main", !topbar && "od-app__main--full")} aria-label={mainLabel}>
        {children}
      </main>
    </div>
  );
}

export interface TopBarProps {
  /** Left: breadcrumb or context. */
  start?: ReactNode;
  /** Centre: global search. */
  center?: ReactNode;
  /** Right: primary global actions. */
  end?: ReactNode;
  className?: string;
}

export function TopBar({ start, center, end, className }: TopBarProps) {
  return (
    <header className={cx("od-topbar", className)}>
      <div className="od-topbar__start">{start}</div>
      <div className="od-topbar__center">{center}</div>
      <div className="od-topbar__end">{end}</div>
    </header>
  );
}

export interface SearchTriggerProps {
  placeholder: string;
  /** e.g. `["⌘", "K"]`. */
  shortcut?: string[];
  onClick: () => void;
  className?: string;
}

/** Looks like a search field; opens the command palette. */
export function SearchTrigger({ placeholder, shortcut, onClick, className }: SearchTriggerProps) {
  return (
    <button type="button" className={cx("od-search-trigger", className)} onClick={onClick} aria-haspopup="dialog">
      <Icon name="search" size="sm" />
      <span className="od-search-trigger__text">{placeholder}</span>
      {shortcut && <Kbd keys={shortcut} />}
    </button>
  );
}
