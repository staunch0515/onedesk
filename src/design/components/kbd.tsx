import { cx } from "./cx";
import "./kbd.css";

export interface KbdProps {
  /** Keys of one shortcut, e.g. `["⌘", "K"]`. */
  keys: string[];
  /** `inverse` is used inside tooltips (dark chip on light text and vice versa). */
  tone?: "default" | "inverse";
  className?: string;
}

export function Kbd({ keys, tone = "default", className }: KbdProps) {
  return (
    <span className={cx("od-kbd-group", `od-kbd-group--${tone}`, className)}>
      {keys.map((key, i) => (
        <kbd key={`${key}-${i}`} className="od-kbd">
          {key}
        </kbd>
      ))}
    </span>
  );
}
