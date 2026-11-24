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
export { MultiSelect, type MultiSelectProps } from "./components/multi-select";
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
export { isOpenableUrl, normalizeLinkHref } from "./components/open-url";
export { MarkdownText, renderMarkdown, type MarkdownTextProps, type ReferenceState } from "./components/markdown-text";
export { TextLink, type TextLinkProps } from "./components/text-link";
export { TextBlock, type TextBlockProps } from "./components/text-block";
export { TerminalText, type TerminalLine, type TerminalTextProps, type TerminalTone } from "./components/terminal-text";
export { KeyValueList, type KeyValueListProps, type KeyValueItem } from "./components/key-value-list";
export { LineageList, type LineageItem } from "./components/lineage-list";

// ---- Workbench (stage 0): layout and generic parts for the VS Code-style shell
export { beginPointerDrag, setDragCursor, type DragCursor, type PointerDragHandlers } from "./components/pointer-drag";
export { Splitter, Sized, type SplitterProps, type SizedProps } from "./components/splitter";
export { DragGhost, type DragGhostProps } from "./components/drag-ghost";
export { Tree, type TreeProps, type TreeRow, type TreeNodeState, type TreeDropPosition } from "./components/tree";
export { TabStrip, type TabStripProps, type TabStripItem } from "./components/tab-strip";
export { DataGrid, type DataGridProps, type DataGridColumn, type DataGridSort, type DataGridValue } from "./components/data-grid";
export { CodeEditor, type CodeEditorProps, type CodeToken, type CodeTokenKind } from "./components/code-editor";
export { ContextMenu, type ContextMenuProps } from "./components/context-menu";
export { OptionList, SearchBox, type OptionListProps, type OptionListItem, type SearchBoxProps } from "./components/option-list";
export {
  WorkbenchFrame,
  WorkbenchMain,
  ActivityBar,
  SidePanel,
  StatusBar,
  StatusItem,
  Pane,
  FloatingPanel,
  TaskItem,
  type WorkbenchFrameProps,
  type WorkbenchMainProps,
  type ActivityBarProps,
  type ActivityItem,
  type SidePanelProps,
  type StatusBarProps,
  type StatusItemProps,
  type PaneProps,
  type FloatingPanelProps,
  type TaskItemProps,
  type TaskStatus,
} from "./components/workbench";
export {
  PageFrame,
  PageTitleBar,
  TitleBarSlot,
  ActionBar,
  InfoPanel,
  InfoField,
  BottomPanel,
  FieldStrip,
  StripField,
  FactRow,
  type PageFrameProps,
  type BreadcrumbItem,
  type PageTitleBarProps,
  type ActionBarProps,
  type ActionBarItem,
  type InfoPanelProps,
  type InfoFieldProps,
  type BottomPanelProps,
  type PanelTab,
  type FieldStripProps,
  type StripFieldProps,
  type FactItem,
} from "./components/page-frame";
