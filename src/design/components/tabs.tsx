import * as TabsPrimitive from "@radix-ui/react-tabs";
import type { ReactNode } from "react";
import { cx } from "./cx";
import { Icon } from "./icon";
import "./tabs.css";

export interface TabItem {
  value: string;
  label: ReactNode;
  icon?: string;
  /** Small count after the label. */
  count?: number;
  disabled?: boolean;
  content: ReactNode;
}

export interface TabsProps {
  items: TabItem[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  /** Accessible name of the tab list. */
  label?: string;
  /** Extra content at the end of the tab bar (e.g. a small action). */
  trailing?: ReactNode;
  className?: string;
}

/** Underlined tabs. Arrow keys move between tabs and activate them (Radix roving focus). */
export function Tabs({ items, value, defaultValue, onValueChange, label, trailing, className }: TabsProps) {
  return (
    <TabsPrimitive.Root
      className={cx("od-tabs", className)}
      value={value}
      defaultValue={defaultValue ?? items[0]?.value}
      onValueChange={onValueChange}
    >
      <div className="od-tabs__bar">
        <TabsPrimitive.List className="od-tabs__list" aria-label={label}>
          {items.map((item) => (
            <TabsPrimitive.Trigger key={item.value} value={item.value} disabled={item.disabled} className="od-tabs__trigger">
              {item.icon && <Icon name={item.icon} size="sm" />}
              <span>{item.label}</span>
              {item.count !== undefined && <span className="od-tabs__count od-tabular">{item.count}</span>}
            </TabsPrimitive.Trigger>
          ))}
        </TabsPrimitive.List>
        {trailing && <div className="od-tabs__trailing">{trailing}</div>}
      </div>
      {items.map((item) => (
        <TabsPrimitive.Content key={item.value} value={item.value} className="od-tabs__panel">
          {item.content}
        </TabsPrimitive.Content>
      ))}
    </TabsPrimitive.Root>
  );
}
