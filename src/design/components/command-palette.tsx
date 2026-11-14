import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Command, defaultFilter } from "cmdk";
import type { ReactNode } from "react";
import { cx } from "./cx";
import { Icon } from "./icon";
import { Kbd } from "./kbd";
import { Spinner } from "./spinner";
import "./command-palette.css";

export interface CommandItem {
  id: string;
  label: string;
  /** Secondary text on the right side of the label (kind, group). */
  description?: string;
  /** lucide icon name. */
  icon?: string;
  /** Keys hint, e.g. `["⌘", "N"]`. */
  shortcut?: string[];
  /** Extra search terms (tags, body text). */
  keywords?: string[];
  disabled?: boolean;
  onSelect: () => void;
}

export interface CommandGroup {
  id: string;
  heading: string;
  items: CommandItem[];
}

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groups: CommandGroup[];
  /** Accessible dialog title (visually hidden). */
  label: string;
  placeholder?: string;
  /** Shown when nothing matches. */
  emptyText: ReactNode;
  /** Controlled search text (e.g. to run a kernel search as the user types). */
  search?: string;
  onSearchChange?: (search: string) => void;
  /**
   * `true` (default): cmdk filters items by label + keywords.
   * `false`: items are already filtered by the caller (kernel search).
   */
  filter?: boolean;
  /** Shows a spinner while results load. */
  loading?: boolean;
  loadingLabel?: string;
  /** Accessible name of the result list (cmdk defaults to the English "Suggestions"). */
  listLabel?: string;
  /** Footer hint row, e.g. key legends. */
  footer?: ReactNode;
  /** Close after an item is selected (default true). */
  closeOnSelect?: boolean;
}

/** Match on label/description/keywords only — never on the internal `group:id` value. */
const matchKeywords = (_value: string, search: string, keywords?: string[]) => defaultFilter("", search, keywords);

/** ⌘K palette: search resources, run actions, switch pages. Arrow keys move, Enter runs, Escape closes. */
export function CommandPalette({
  open,
  onOpenChange,
  groups,
  label,
  placeholder,
  emptyText,
  search,
  onSearchChange,
  filter = true,
  loading = false,
  loadingLabel,
  listLabel,
  footer,
  closeOnSelect = true,
}: CommandPaletteProps) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="od-palette__overlay" />
        <DialogPrimitive.Content className="od-palette" aria-describedby={undefined}>
          <DialogPrimitive.Title className="od-visually-hidden">{label}</DialogPrimitive.Title>
          <Command label={label} shouldFilter={filter} filter={matchKeywords} loop className="od-palette__command">
            <div className="od-palette__search">
              <Icon name="search" size="md" className="od-palette__search-icon" />
              <Command.Input className="od-palette__input" placeholder={placeholder} value={search} onValueChange={onSearchChange} />
              {loading && <Spinner size="sm" label={loadingLabel} />}
            </div>
            <Command.List className="od-palette__list" label={listLabel} aria-busy={loading || undefined}>
              {!loading && <Command.Empty className="od-palette__empty">{emptyText}</Command.Empty>}
              {groups
                .filter((g) => g.items.length > 0)
                .map((group) => (
                  <Command.Group key={group.id} heading={group.heading} className="od-palette__group">
                    {group.items.map((item) => (
                      <Command.Item
                        key={item.id}
                        value={`${group.id}:${item.id}`}
                        keywords={[item.label, ...(item.description ? [item.description] : []), ...(item.keywords ?? [])]}
                        disabled={item.disabled}
                        onSelect={() => {
                          item.onSelect();
                          if (closeOnSelect) onOpenChange(false);
                        }}
                        className={cx("od-palette__item")}
                      >
                        {item.icon && <Icon name={item.icon} size="md" className="od-palette__item-icon" />}
                        <span className="od-palette__item-label">{item.label}</span>
                        {item.description && <span className="od-palette__item-description">{item.description}</span>}
                        {item.shortcut && <Kbd keys={item.shortcut} className="od-palette__item-shortcut" />}
                      </Command.Item>
                    ))}
                  </Command.Group>
                ))}
            </Command.List>
            {footer && <div className="od-palette__footer">{footer}</div>}
          </Command>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
