import type { EventMessage } from "../generated";

/** One way to reach the main process. Two implementations: Tauri (desktop) and WebSocket (browser against devhost). */
export interface Transport {
  /** Resolves with the result; rejects with a KernelError. */
  request(method: string, params?: unknown): Promise<unknown>;
  /** Every event of the workspace addressed to this client, as sent by the kernel and the main process. */
  onEvent(handler: (event: EventMessage) => void): () => void;
  /** Opens the system folder dialog (desktop only). */
  pickFolder?(): Promise<string | null>;
  /** Opens the system open-file dialog limited to plugin package files, `.odplugin`/`.zip` (desktop only, D456). */
  pickPackageFile?(): Promise<string | null>;
  /** D487 §21: a resource package file, `.odpack` (system dialog). */
  pickResourcePackage?(): Promise<string | null>;
  /** D487 §33: the open dialog for an identity card (`.odid`). */
  pickIdentityCard?(): Promise<string | null>;
  /** D484 §16: an image file (system dialog). */
  pickImageFile?(): Promise<string | null>;
  /** Opens the system "save as" dialog with a suggested file name (desktop only). */
  pickSaveFile?(name?: string): Promise<string | null>;
  /** Opens an address with the system's default browser (desktop only; the main process checks the protocol). */
  openExternal?(url: string): Promise<void>;
  /** Opens a window (desktop) or a browser tab for a workspace (D403); the new one belongs to that workspace. */
  openWindow?(workspaceId: string): Promise<void>;
  close(): void;
}

export { KernelError, toKernelError } from "../errors";
