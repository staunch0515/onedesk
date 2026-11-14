import { createContext, useContext, useId, type ReactNode } from "react";
import { cx } from "./cx";
import { Icon } from "./icon";
import "./form-field.css";

interface FieldContextValue {
  id: string;
  describedBy: string | undefined;
  invalid: boolean;
  required: boolean;
}

const FieldContext = createContext<FieldContextValue | null>(null);

/**
 * Wiring for controls placed inside a FormField: id, aria-describedby, aria-invalid, required.
 * Explicit props on the control win.
 */
export function useFieldControl(props: {
  id?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean | "true" | "false" | "grammar" | "spelling";
  required?: boolean;
}) {
  const field = useContext(FieldContext);
  const invalid = props["aria-invalid"] ?? (field?.invalid ? true : undefined);
  return {
    id: props.id ?? field?.id,
    "aria-describedby": props["aria-describedby"] ?? field?.describedBy,
    "aria-invalid": invalid,
    required: props.required ?? (field?.required || undefined),
    invalid: invalid !== undefined && invalid !== false && invalid !== "false",
  };
}

export interface FormFieldProps {
  label: ReactNode;
  /** Helper text under the label's control. */
  description?: ReactNode;
  /** Error message; marks the control invalid and replaces nothing — description stays visible. */
  error?: ReactNode;
  required?: boolean;
  /** Mark shown after a required label (e.g. `*`); passed in so the component holds no copy. */
  requiredMark?: ReactNode;
  /** Right-aligned element in the label row (e.g. a link or counter). */
  labelAside?: ReactNode;
  /** Use an explicit id when the control is not a design-system control. */
  id?: string;
  className?: string;
  children: ReactNode;
}

export function FormField({
  label,
  description,
  error,
  required = false,
  requiredMark,
  labelAside,
  id,
  className,
  children,
}: FormFieldProps) {
  const autoId = useId();
  const controlId = id ?? `od-field-${autoId}`;
  const descriptionId = description ? `${controlId}-description` : undefined;
  const errorId = error ? `${controlId}-error` : undefined;
  const describedBy = [descriptionId, errorId].filter(Boolean).join(" ") || undefined;
  return (
    <FieldContext.Provider value={{ id: controlId, describedBy, invalid: Boolean(error), required }}>
      <div className={cx("od-field", error ? "od-field--invalid" : undefined, className)}>
        <div className="od-field__label-row">
          <label className="od-field__label" htmlFor={controlId}>
            {label}
            {required && requiredMark && (
              <span className="od-field__required" aria-hidden="true">
                {requiredMark}
              </span>
            )}
          </label>
          {labelAside && <span className="od-field__aside">{labelAside}</span>}
        </div>
        {children}
        {description && (
          <p className="od-field__description" id={descriptionId}>
            {description}
          </p>
        )}
        {error && (
          <p className="od-field__error" id={errorId}>
            <Icon name="circle-alert" size="sm" />
            <span>{error}</span>
          </p>
        )}
      </div>
    </FieldContext.Provider>
  );
}
