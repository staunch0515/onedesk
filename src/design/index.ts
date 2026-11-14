/**
 * OneDesk design system. Import from "src/design" only; components reference tokens.css variables.
 * Importing this module also loads the tokens and the global base styles.
 */
import "./tokens.css";
import "./base.css";

export { cx } from "./components/cx";
export { ThemeProvider, useTheme, type Density, type ThemePreference, type ThemeState, type ThemeProviderProps } from "./components/theme-provider";
export { Icon, hasIcon, resolveIcon, type IconProps, type IconSize } from "./components/icon";
export { Button, type ButtonProps, type ButtonVariant, type ButtonSize } from "./components/button";
export { IconButton, type IconButtonProps } from "./components/icon-button";
export { Tooltip, type TooltipProps } from "./components/tooltip";
export { Popover, type PopoverProps } from "./components/popover";
export { Kbd, type KbdProps } from "./components/kbd";
export { Spinner, Progress, type SpinnerProps, type ProgressProps } from "./components/spinner";
export { FormField, useFieldControl, type FormFieldProps } from "./components/form-field";
export { Input, type InputProps } from "./components/input";
export { Textarea, type TextareaProps } from "./components/textarea";
export { Select, type SelectProps, type SelectOption, type SelectGroup } from "./components/select";
export { Switch, type SwitchProps } from "./components/switch";
export { Checkbox, type CheckboxProps } from "./components/checkbox";
export { Table, type TableProps, type TableColumn, type TableColumnWidth } from "./components/table";
export { Dialog, DialogClose, type DialogProps } from "./components/dialog";
export { Drawer, type DrawerProps } from "./components/drawer";
export { Tabs, type TabsProps, type TabItem } from "./components/tabs";
export { Badge, type BadgeProps, type Tone } from "./components/badge";
export { Banner, type BannerProps, type BannerTone } from "./components/banner";
export { ToastProvider, useToast, type ToastOptions, type ToastProviderProps, type ToastTone } from "./components/toast";
export { DropdownMenu, type DropdownMenuProps, type MenuEntry } from "./components/dropdown-menu";
export { LoadingState, EmptyState, ErrorState, type LoadingStateProps, type EmptyStateProps, type ErrorStateProps } from "./components/states";
export { AppShell, TopBar, SearchTrigger, type AppShellProps, type TopBarProps, type SearchTriggerProps } from "./components/app-shell";
export { Sidebar, NavGroup, NavItem, DragHandle, type SidebarProps, type NavGroupProps, type NavItemProps, type DragHandleProps } from "./components/sidebar";
export { Page, PageHeader, PageBody, Stack, type PageProps, type PageHeaderProps, type PageBodyProps, type StackProps } from "./components/page";
export { Section, type SectionProps } from "./components/section";
export { Text, type TextProps } from "./components/text";
export { CommandPalette, type CommandPaletteProps, type CommandGroup, type CommandItem } from "./components/command-palette";
export { Markdown, type MarkdownProps } from "./components/markdown";
