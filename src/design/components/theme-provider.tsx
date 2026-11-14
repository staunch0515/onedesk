import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type ThemePreference = "system" | "light" | "dark";
export type Density = "comfortable" | "compact";

export interface ThemeState {
  theme: ThemePreference;
  /** The theme actually shown (system preference resolved). */
  resolvedTheme: "light" | "dark";
  density: Density;
  setTheme: (theme: ThemePreference) => void;
  setDensity: (density: Density) => void;
}

const ThemeContext = createContext<ThemeState | null>(null);

export interface ThemeProviderProps {
  /** Initial preference (e.g. read from app_settings by the caller). Default "system". */
  defaultTheme?: ThemePreference;
  defaultDensity?: Density;
  /** Controlled mode: pass theme/density and update them in the change callbacks. */
  theme?: ThemePreference;
  density?: Density;
  /** Persistence is the caller's job (D34: app_settings); this component never touches storage. */
  onThemeChange?: (theme: ThemePreference) => void;
  onDensityChange?: (density: Density) => void;
  /** Element receiving the attributes; defaults to <html>. */
  target?: HTMLElement;
  children: ReactNode;
}

const DARK_QUERY = "(prefers-color-scheme: dark)";

function systemPrefersDark(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(DARK_QUERY).matches;
}

/**
 * Writes `data-theme` / `data-density` on <html> (D34). For "system" the `data-theme` attribute is
 * removed so tokens.css follows prefers-color-scheme without JavaScript.
 */
export function ThemeProvider({
  defaultTheme = "system",
  defaultDensity = "comfortable",
  theme: themeProp,
  density: densityProp,
  onThemeChange,
  onDensityChange,
  target,
  children,
}: ThemeProviderProps) {
  const [innerTheme, setInnerTheme] = useState<ThemePreference>(defaultTheme);
  const [innerDensity, setInnerDensity] = useState<Density>(defaultDensity);
  const [systemDark, setSystemDark] = useState(systemPrefersDark);
  const theme = themeProp ?? innerTheme;
  const density = densityProp ?? innerDensity;

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(DARK_QUERY);
    const update = () => setSystemDark(mq.matches);
    mq.addEventListener?.("change", update);
    return () => mq.removeEventListener?.("change", update);
  }, []);

  useEffect(() => {
    const el = target ?? document.documentElement;
    if (theme === "system") el.removeAttribute("data-theme");
    else el.setAttribute("data-theme", theme);
    el.setAttribute("data-density", density);
  }, [theme, density, target]);

  const setTheme = useCallback(
    (next: ThemePreference) => {
      if (themeProp === undefined) setInnerTheme(next);
      onThemeChange?.(next);
    },
    [themeProp, onThemeChange],
  );
  const setDensity = useCallback(
    (next: Density) => {
      if (densityProp === undefined) setInnerDensity(next);
      onDensityChange?.(next);
    },
    [densityProp, onDensityChange],
  );

  const value = useMemo<ThemeState>(
    () => ({
      theme,
      resolvedTheme: theme === "system" ? (systemDark ? "dark" : "light") : theme,
      density,
      setTheme,
      setDensity,
    }),
    [theme, systemDark, density, setTheme, setDensity],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeState {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useTheme 必须在 ThemeProvider 内使用");
  return value;
}
