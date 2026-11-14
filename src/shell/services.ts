import type { AppStatus } from "../kernel/contracts";

/**
 * Platform capabilities the shell needs beyond the kernel (folder picker, export files, app status, opening links).
 * Built by the composition root (bootstrap.ts) — the only shell file allowed to import src/platform.
 */
export interface ShellServices {
  mode: "tauri" | "browser";
  status(): Promise<AppStatus>;
  openExternal(url: string): Promise<void>;
  pickFolder(title: string): Promise<string | null>;
  exportWrite(parentDir: string, files: Array<{ name: string; content: string }>): Promise<string>;
  importRead(dir: string): Promise<{ resources: string; collections: string; manifest: string }>;
}
