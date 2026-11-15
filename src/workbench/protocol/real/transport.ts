import type { EventMessage } from "../generated";

/** One way to reach the main process. Two implementations: Tauri (desktop) and WebSocket (browser against devhost). */
export interface Transport {
  /** Resolves with the result; rejects with a KernelError. */
  request(method: string, params?: unknown): Promise<unknown>;
  /** Every event of the workspace addressed to this client, as sent by the kernel and the main process. */
  onEvent(handler: (event: EventMessage) => void): () => void;
  /** Opens the system folder dialog (desktop only). */
  pickFolder?(): Promise<string | null>;
  close(): void;
}

export { KernelError, toKernelError } from "../errors";
