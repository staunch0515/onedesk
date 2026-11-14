import * as lucide from "lucide-react";
import { icons, type LucideIcon } from "lucide-react";
import { cx } from "./cx";
import "./icon.css";

export type IconSize = "xs" | "sm" | "md" | "lg";

export interface IconProps {
  /** lucide icon name in kebab-case (as written in plugin manifests), e.g. `file-text`. PascalCase also accepted. */
  name: string;
  size?: IconSize;
  /** Accessible label. Without it the icon is decorative (`aria-hidden`). */
  label?: string;
  className?: string;
}

const FALLBACK = "circle-dashed";

function toPascal(name: string): string {
  return name
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

// The module namespace also carries lucide's alias exports (e.g. `trash-2`, `triangle-alert`, `alert-circle`,
// renamed in lucide 1.x), so names written in older manifests keep working. `icons` only has canonical names.
const namespace = lucide as unknown as Record<string, unknown>;
const NON_ICON_EXPORTS = new Set(["Icon", "createLucideIcon", "icons", "LucideProvider"]);

function lookup(key: string): LucideIcon | undefined {
  const canonical = (icons as Record<string, LucideIcon>)[key];
  if (canonical) return canonical;
  if (NON_ICON_EXPORTS.has(key) || key.startsWith("Lucide") || key.endsWith("Icon")) return undefined;
  const alias = namespace[key];
  return typeof alias === "object" && alias !== null ? (alias as LucideIcon) : undefined;
}

/** Resolves a lucide icon by name (kebab-case or PascalCase, aliases included); unknown names give `undefined`. */
export function resolveIcon(name: string): LucideIcon | undefined {
  return lookup(toPascal(name)) ?? lookup(name);
}

export function hasIcon(name: string): boolean {
  return resolveIcon(name) !== undefined;
}

/**
 * Renders a lucide icon by name with the shared stroke width and size tokens (D32).
 * Unknown names render a neutral placeholder instead of throwing, so a bad manifest never breaks a page.
 */
export function Icon({ name, size = "md", label, className }: IconProps) {
  const Component = resolveIcon(name) ?? resolveIcon(FALLBACK)!;
  return (
    <Component
      className={cx("od-icon", `od-icon--${size}`, className)}
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? "img" : undefined}
      focusable="false"
      data-icon={name}
    />
  );
}
