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

/** Resolves a lucide icon by name; unknown names resolve to `undefined`. */
export function resolveIcon(name: string): LucideIcon | undefined {
  const table = icons as Record<string, LucideIcon>;
  return table[toPascal(name)] ?? table[name];
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
