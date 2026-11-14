// Renders the application shell. The design-system gallery stays available with `?gallery` (D105).
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider, ToastProvider, type Density, type ThemePreference } from "./design";
import { Gallery } from "./design/gallery/Gallery";
import { Start } from "./shell/start";

const params = new URLSearchParams(window.location.search);
const root = createRoot(document.getElementById("root")!);

if (params.has("gallery")) {
  // ?gallery&theme=light|dark&density=compact — used by screenshot scripts.
  const theme = (["system", "light", "dark"].includes(params.get("theme") ?? "") ? params.get("theme") : "system") as ThemePreference;
  const density = (params.get("density") === "compact" ? "compact" : "comfortable") as Density;
  root.render(
    <StrictMode>
      <ThemeProvider defaultTheme={theme} defaultDensity={density}>
        <ToastProvider closeLabel="关闭" viewportLabel="通知 ({hotkey})">
          <Gallery />
        </ToastProvider>
      </ThemeProvider>
    </StrictMode>,
  );
} else {
  root.render(
    <StrictMode>
      <Start />
    </StrictMode>,
  );
}
