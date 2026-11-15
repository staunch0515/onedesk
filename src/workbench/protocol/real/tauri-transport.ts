import type { EventMessage } from "../generated";
import { toKernelError } from "../errors";
import type { Transport } from "./transport";

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Desktop window: Tauri command `protocol_request` and event `protocol-event` (week1-protocol §2). */
export async function createTauriTransport(): Promise<Transport> {
  const { invoke } = await import("@tauri-apps/api/core");
  const { listen } = await import("@tauri-apps/api/event");
  const handlers = new Set<(event: EventMessage) => void>();
  const unlisten = await listen<EventMessage>("protocol-event", (e) => handlers.forEach((h) => h(e.payload)));
  return {
    async request(method, params) {
      try {
        return await invoke("protocol_request", { method, params: params ?? null });
      } catch (error) {
        throw toKernelError(error);
      }
    },
    onEvent(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    async pickFolder() {
      return (await invoke<string | null>("pick_folder")) ?? null;
    },
    close() {
      unlisten();
      handlers.clear();
    },
  };
}
