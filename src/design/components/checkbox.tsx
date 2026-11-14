import { useEffect, useRef, type InputHTMLAttributes, type ReactNode } from "react";
import { cx } from "./cx";
import { useFieldControl } from "./form-field";
import { Icon } from "./icon";
import "./checkbox.css";

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "onChange"> {
  label?: ReactNode;
  description?: ReactNode;
  indeterminate?: boolean;
  onCheckedChange?: (checked: boolean) => void;
}

/** Native checkbox (keyboard and form behaviour for free) with token-based visuals. */
export function Checkbox({ label, description, indeterminate = false, onCheckedChange, className, disabled, id, ...rest }: CheckboxProps) {
  const ref = useRef<HTMLInputElement>(null);
  const field = useFieldControl({ id });
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  const box = (
    <span className="od-checkbox__box">
      <input
        ref={ref}
        type="checkbox"
        id={field.id}
        disabled={disabled}
        aria-checked={indeterminate ? "mixed" : undefined}
        className="od-checkbox__input"
        onChange={(e) => onCheckedChange?.(e.currentTarget.checked)}
        {...rest}
      />
      <Icon name={indeterminate ? "minus" : "check"} size="sm" className="od-checkbox__mark" />
    </span>
  );
  if (!label) return <span className={cx("od-checkbox", className)}>{box}</span>;
  return (
    <label className={cx("od-checkbox", "od-checkbox--labelled", disabled && "od-checkbox--disabled", className)}>
      {box}
      <span className="od-checkbox__text">
        <span className="od-checkbox__label">{label}</span>
        {description && <span className="od-checkbox__description">{description}</span>}
      </span>
    </label>
  );
}
