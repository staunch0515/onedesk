import * as SelectPrimitive from "@radix-ui/react-select";
import type { CSSProperties, Ref } from "react";
import { cx } from "./cx";
import { useFieldControl } from "./form-field";
import { Icon } from "./icon";
import "./select.css";

export interface SelectOption {
  /** Must be non-empty (Radix reserves "" for "no value"). */
  value: string;
  label: string;
  icon?: string;
  disabled?: boolean;
  /** Nesting level in a tree of options (0 = top); indents the item in the list, not the chosen value. */
  depth?: number;
}

export interface SelectGroup {
  label: string;
  options: SelectOption[];
}

export interface SelectProps {
  options: Array<SelectOption | SelectGroup>;
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  placeholder?: string;
  size?: "sm" | "md";
  disabled?: boolean;
  invalid?: boolean;
  required?: boolean;
  name?: string;
  id?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
  className?: string;
  ref?: Ref<HTMLButtonElement>;
}

function isGroup(o: SelectOption | SelectGroup): o is SelectGroup {
  return "options" in o;
}

function Item({ option }: { option: SelectOption }) {
  return (
    <SelectPrimitive.Item
      className="od-select__item"
      value={option.value}
      disabled={option.disabled}
      style={option.depth ? ({ "--od-select-depth": option.depth } as CSSProperties) : undefined} // od-allow-inline-style: nesting level of this option
    >
      {option.icon && <Icon name={option.icon} size="md" className="od-select__item-icon" />}
      <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator className="od-select__check">
        <Icon name="check" size="md" />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  );
}

export function Select({
  options,
  value,
  defaultValue,
  onValueChange,
  placeholder,
  size = "md",
  disabled,
  invalid,
  required,
  name,
  className,
  ref,
  ...aria
}: SelectProps) {
  const field = useFieldControl({
    id: aria.id,
    "aria-describedby": aria["aria-describedby"],
    "aria-invalid": invalid,
    required,
  });
  return (
    <SelectPrimitive.Root
      value={value}
      defaultValue={defaultValue}
      onValueChange={onValueChange}
      disabled={disabled}
      required={field.required}
      name={name}
    >
      <SelectPrimitive.Trigger
        ref={ref}
        id={field.id}
        aria-label={aria["aria-label"]}
        aria-describedby={field["aria-describedby"]}
        aria-invalid={field["aria-invalid"]}
        className={cx("od-select", `od-select--${size}`, field.invalid && "od-select--invalid", className)}
      >
        <span className="od-select__value">
          <SelectPrimitive.Value placeholder={placeholder} />
        </span>
        <SelectPrimitive.Icon className="od-select__chevron">
          <Icon name="chevrons-up-down" size="sm" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content className="od-select__content" position="popper" sideOffset={4} collisionPadding={8}>
          <SelectPrimitive.Viewport className="od-select__viewport">
            {options.map((o, i) =>
              isGroup(o) ? (
                <SelectPrimitive.Group key={`g-${o.label}`}>
                  {i > 0 && <SelectPrimitive.Separator className="od-select__separator" />}
                  <SelectPrimitive.Label className="od-select__label">{o.label}</SelectPrimitive.Label>
                  {o.options.map((opt) => (
                    <Item key={opt.value} option={opt} />
                  ))}
                </SelectPrimitive.Group>
              ) : (
                <Item key={o.value} option={o} />
              ),
            )}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}
