// Phase 1: renders the design-system gallery. Replaced by the shell in phase 2 (see docs/handoff/).
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider, ToastProvider, type Density, type ThemePreference } from "./design";
import { Gallery } from "./design/gallery/Gallery";

// ?theme=light|dark&density=compact — used by the screenshot script; the gallery can switch at runtime too.
const params = new URLSearchParams(window.location.search);
const theme = (["system", "light", "dark"].includes(params.get("theme") ?? "") ? params.get("theme") : "system") as ThemePreference;
const density = (params.get("density") === "compact" ? "compact" : "comfortable") as Density;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider defaultTheme={theme} defaultDensity={density}>
      <ToastProvider closeLabel="关闭" viewportLabel="通知 ({hotkey})">
        <Gallery />
      </ToastProvider>
    </ThemeProvider>
  </StrictMode>,
);
