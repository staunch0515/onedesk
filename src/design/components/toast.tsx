import * as ToastPrimitive from "@radix-ui/react-toast";
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { cx } from "./cx";
import { Icon } from "./icon";
import { IconButton } from "./icon-button";
import "./toast.css";

export type ToastTone = "neutral" | "info" | "success" | "warning" | "danger";

export interface ToastOptions {
  title: ReactNode;
  description?: ReactNode;
  tone?: ToastTone;
  /** One action button. `altText` describes how to do it without the toast (Radix a11y requirement). */
  action?: { label: string; altText: string; onClick: () => void };
  /** Milliseconds; defaults to the provider's duration. */
  duration?: number;
}

interface ToastEntry extends ToastOptions {
  id: number;
  open: boolean;
}

interface ToastApi {
  toast: (options: ToastOptions) => number;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const ICONS: Record<ToastTone, string | null> = {
  neutral: null,
  info: "info",
  success: "circle-check",
  warning: "triangle-alert",
  danger: "circle-alert",
};

export interface ToastProviderProps {
  children: ReactNode;
  /** aria-label of each toast's close button; hidden when omitted. */
  closeLabel?: string;
  /** Accessible name of the toast region; `{hotkey}` is replaced by Radix (F8). */
  viewportLabel?: string;
  /** Default display time in ms. */
  duration?: number;
}

export function ToastProvider({ children, closeLabel, viewportLabel, duration = 5000 }: ToastProviderProps) {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((list) => list.map((t) => (t.id === id ? { ...t, open: false } : t)));
  }, []);

  const toast = useCallback((options: ToastOptions) => {
    const id = nextId.current++;
    // Closed toasts are unmounted by Radix after their exit animation; prune them on the next add.
    setToasts((list) => [...list.filter((t) => t.open), { ...options, id, open: true }]);
    return id;
  }, []);

  const api = useMemo(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      <ToastPrimitive.Provider duration={duration} swipeDirection="right">
        {children}
        {toasts.map((t) => {
          const tone = t.tone ?? "neutral";
          const icon = ICONS[tone];
          return (
            <ToastPrimitive.Root
              key={t.id}
              open={t.open}
              duration={t.duration}
              type={tone === "danger" ? "foreground" : "background"}
              onOpenChange={(open) => (open ? undefined : dismiss(t.id))}
              className={cx("od-toast", `od-toast--${tone}`)}
            >
              {icon && <Icon name={icon} size="md" className="od-toast__icon" />}
              <div className="od-toast__content">
                <ToastPrimitive.Title className="od-toast__title">{t.title}</ToastPrimitive.Title>
                {t.description && <ToastPrimitive.Description className="od-toast__description">{t.description}</ToastPrimitive.Description>}
              </div>
              {t.action && (
                <ToastPrimitive.Action altText={t.action.altText} asChild>
                  <button type="button" className="od-toast__action" onClick={t.action.onClick}>
                    {t.action.label}
                  </button>
                </ToastPrimitive.Action>
              )}
              {closeLabel && (
                <ToastPrimitive.Close asChild>
                  <IconButton icon="x" label={closeLabel} size="sm" className="od-toast__close" />
                </ToastPrimitive.Close>
              )}
            </ToastPrimitive.Root>
          );
        })}
        <ToastPrimitive.Viewport className="od-toast-viewport" label={viewportLabel} />
      </ToastPrimitive.Provider>
    </ToastContext.Provider>
  );
}

/** `const { toast } = useToast(); toast({ title, tone: "success" })`. Must be inside ToastProvider. */
export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error("useToast 必须在 ToastProvider 内使用");
  return api;
}
