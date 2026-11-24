import type { InputHTMLAttributes, ReactNode, Ref } from "react";
import { cx } from "./cx";
import { useFieldControl } from "./form-field";
import { Icon } from "./icon";
import "./input.css";

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size"> {
  size?: "sm" | "md";
  /** lucide icon name shown inside the field, before the text. */
  icon?: string;
  /** Element at the end of the field (unit, Kbd, small IconButton). */
  trailing?: ReactNode;
  /** Use the monospace font (URLs, code, headers). */
  mono?: boolean;
  /** A number: the text is right-aligned with digits of equal width (D472). */
  numeric?: boolean;
  invalid?: boolean;
  ref?: Ref<HTMLInputElement>;
}

export function Input({ size = "md", icon, trailing, mono, numeric, invalid, className, disabled, readOnly, ref, ...rest }: InputProps) {
  const field = useFieldControl({
    id: rest.id,
    "aria-describedby": rest["aria-describedby"],
    "aria-invalid": invalid ?? rest["aria-invalid"],
    required: rest.required,
  });
  return (
    <span
      className={cx(
        "od-input",
        `od-input--${size}`,
        field.invalid && "od-input--invalid",
        disabled && "od-input--disabled",
        readOnly && "od-input--readonly",
        className,
      )}
    >
      {icon && <Icon name={icon} size={size === "sm" ? "sm" : "md"} className="od-input__icon" />}
      <input
        ref={ref}
        {...rest}
        id={field.id}
        aria-describedby={field["aria-describedby"]}
        aria-invalid={field["aria-invalid"]}
        required={field.required}
        disabled={disabled}
        readOnly={readOnly}
        className={cx("od-input__control", mono && "od-mono", numeric && "od-input__control--numeric")}
      />
      {trailing && <span className="od-input__trailing">{trailing}</span>}
    </span>
  );
}
