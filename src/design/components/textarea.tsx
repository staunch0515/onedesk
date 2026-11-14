import type { Ref, TextareaHTMLAttributes } from "react";
import { cx } from "./cx";
import { useFieldControl } from "./form-field";
import "./textarea.css";

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  mono?: boolean;
  invalid?: boolean;
  /** Allow vertical resizing (default true). */
  resizable?: boolean;
  ref?: Ref<HTMLTextAreaElement>;
}

export function Textarea({ mono, invalid, resizable = true, className, rows = 4, ref, ...rest }: TextareaProps) {
  const field = useFieldControl({
    id: rest.id,
    "aria-describedby": rest["aria-describedby"],
    "aria-invalid": invalid ?? rest["aria-invalid"],
    required: rest.required,
  });
  return (
    <textarea
      ref={ref}
      rows={rows}
      {...rest}
      id={field.id}
      aria-describedby={field["aria-describedby"]}
      aria-invalid={field["aria-invalid"]}
      required={field.required}
      className={cx(
        "od-textarea",
        field.invalid && "od-textarea--invalid",
        !resizable && "od-textarea--fixed",
        mono && "od-mono",
        className,
      )}
    />
  );
}
