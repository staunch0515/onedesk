import type { Ref } from "react";
import { cx } from "./cx";
import { DropdownMenu } from "./dropdown-menu";
import { useFieldControl } from "./form-field";
import { Icon } from "./icon";
import type { SelectOption } from "./select";
import "./select.css";

export interface MultiSelectProps {
  options: SelectOption[];
  /** The chosen option values. */
  value: string[];
  /** Called with the chosen values in the order of `options`. */
  onValueChange?: (value: string[]) => void;
  placeholder?: string;
  size?: "sm" | "md";
  disabled?: boolean;
  invalid?: boolean;
  id?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
  className?: string;
  ref?: Ref<HTMLButtonElement>;
}

/**
 * Several of a list of options at once (D477): looks like `Select`; the list has a check box per option and stays
 * open while ticking. The box shows the chosen names, or the placeholder.
 */
export function MultiSelect({ options, value, onValueChange, placeholder, size = "md", disabled, invalid, className, ref, ...aria }: MultiSelectProps) {
  const field = useFieldControl({ id: aria.id, "aria-describedby": aria["aria-describedby"], "aria-invalid": invalid });
  const chosen = options.filter((o) => value.includes(o.value));
  const toggle = (v: string, on: boolean) => onValueChange?.(options.map((o) => o.value).filter((x) => (x === v ? on : value.includes(x))));
  const trigger = (
    <button
      ref={ref}
      type="button"
      id={field.id}
      disabled={disabled}
      aria-label={aria["aria-label"]}
      aria-describedby={field["aria-describedby"]}
      aria-invalid={field["aria-invalid"]}
      data-placeholder={chosen.length === 0 ? "" : undefined}
      className={cx("od-select", `od-select--${size}`, field.invalid && "od-select--invalid", className)}
    >
      <span className="od-select__value">{chosen.length > 0 ? chosen.map((o) => o.label).join(", ") : placeholder}</span>
      <span className="od-select__chevron">
        <Icon name="chevrons-up-down" size="sm" />
      </span>
    </button>
  );
  if (disabled) return trigger;
  return (
    <DropdownMenu
      trigger={trigger}
      items={options.map((o) => ({ type: "checkbox" as const, key: o.value, label: o.label, checked: value.includes(o.value), disabled: o.disabled, onCheckedChange: (on: boolean) => toggle(o.value, on) }))}
    />
  );
}
