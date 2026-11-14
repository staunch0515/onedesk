/**
 * Composition root (D51/D92): the only shell file that imports src/platform.
 * Picks the platform (Tauri or browser preview) → app.status() → (blocked on migrationError) → scans external
 * plugins → createKernel → plugins.load. In the browser preview the first start seeds a few sample resources.
 */
import { createKernel } from "../kernel";
import type { AppStatus, Kernel, Platform, PluginSource, ScannedPlugin } from "../kernel/contracts";
import type { PluginModule } from "../plugin-api";
import { builtinPluginSources } from "../plugins";
import { t } from "./i18n";
import { seedSampleData } from "./sample-data";
import type { ShellServices } from "./services";

export type BootResult =
  | { type: "ready"; kernel: Kernel; services: ShellServices }
  | { type: "blocked"; status: AppStatus; services: ShellServices };

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function createPlatform(): Promise<{ platform: Platform; mode: ShellServices["mode"] }> {
  if (isTauri()) {
    const { createTauriPlatform } = await import("../platform/tauri");
    return { platform: createTauriPlatform(), mode: "tauri" };
  }
  const { createBrowserPlatform } = await import("../platform/browser");
  return { platform: await createBrowserPlatform(), mode: "browser" };
}

function servicesFor(platform: Platform, mode: ShellServices["mode"]): ShellServices {
  return {
    mode,
    status: () => platform.app.status(),
    openExternal: (url) => platform.system.openExternal(url),
    pickFolder: (title) => platform.files.pickFolder(title),
    exportWrite: (parentDir, files) => platform.files.exportWrite(parentDir, files),
    importRead: (dir) => platform.files.importRead(dir),
  };
}

/** Loads a self-contained ES module from source text through a Blob URL (D01/D55) and returns its default export. */
async function importFromSource(source: string): Promise<PluginModule> {
  const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  try {
    const mod = (await import(/* @vite-ignore */ url)) as { default?: PluginModule };
    if (!mod.default) throw new Error(t("boot.entryNoDefault"));
    return mod.default;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Turns a scanned folder into a PluginSource; scan-level problems are passed on as `error` (D52). */
export function externalPluginSource(scanned: ScannedPlugin, load: (source: string) => Promise<PluginModule> = importFromSource): PluginSource {
  let manifest: unknown = null;
  let error = scanned.error ?? undefined;
  if (scanned.manifestText !== null) {
    try {
      manifest = JSON.parse(scanned.manifestText);
    } catch (e) {
      error ??= t("boot.manifestInvalid", { reason: e instanceof Error ? e.message : String(e) });
    }
  }
  const source: PluginSource = {
    origin: "external",
    location: scanned.dir,
    manifest,
    load: async () => {
      if (scanned.entrySource === null) throw new Error(t("boot.entryMissing"));
      return load(scanned.entrySource);
    },
  };
  if (error !== undefined) source.error = error;
  return source;
}

export async function boot(): Promise<BootResult> {
  const { platform, mode } = await createPlatform();
  const services = servicesFor(platform, mode);
  const status = await platform.app.status();
  if (status.migrationError) return { type: "blocked", status, services };

  const scanned = await platform.plugins.scan();
  const kernel = await createKernel({ platform });
  await kernel.plugins.load([...builtinPluginSources(), ...scanned.map((s) => externalPluginSource(s))]);
  if (mode === "browser") await seedSampleData(kernel);
  return { type: "ready", kernel, services };
}
