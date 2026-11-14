import * as SwitchPrimitive from "@radix-ui/react-switch";
import { useId, type ReactNode, type Ref } from "react";
import { cx } from "./cx";
import { useFieldControl } from "./form-field";
import "./switch.css";

export interface SwitchProps {
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
  /** Inline label to the right. Omit when the Switch sits inside a FormField or has an aria-label. */
  label?: ReactNode;
  description?: ReactNode;
  id?: string;
  name?: string;
  "aria-label"?: string;
  className?: string;
  ref?: Ref<HTMLButtonElement>;
}

export function Switch({ label, description, className, id, ref, ...rest }: SwitchProps) {
  const field = useFieldControl({ id });
  const autoId = useId();
  const switchId = field.id ?? `od-switch-${autoId}`;
  const descriptionId = description ? `${switchId}-description` : field["aria-describedby"];
  const control = (
    <SwitchPrimitive.Root
      ref={ref}
      id={switchId}
      aria-describedby={descriptionId}
      className={cx("od-switch", !label && className)}
      {...rest}
    >
      <SwitchPrimitive.Thumb className="od-switch__thumb" />
    </SwitchPrimitive.Root>
  );
  if (!label) return control;
  return (
    <div className={cx("od-switch-row", rest.disabled && "od-switch-row--disabled", className)}>
      {control}
      <div className="od-switch-row__text">
        <label htmlFor={switchId} className="od-switch-row__label">
          {label}
        </label>
        {description && (
          <p id={descriptionId} className="od-switch-row__description">
            {description}
          </p>
        )}
      </div>
    </div>
  );
}
