import { createKernelClient, type KernelClient } from "./real-client";
import { createTauriTransport, isTauri } from "./tauri-transport";
import type { Transport } from "./transport";
import { createWsTransport } from "./ws-transport";

export type { Transport } from "./transport";
export type { KernelClient } from "./real-client";

/**
 * Picks the connection (week1-protocol §2): Tauri window, else `?kernel=ws://…&token=…`, else none
 * (pure demo data). Throws when a connection was asked for but cannot be made.
 */
export async function connectKernel(query: URLSearchParams, locale: () => string): Promise<KernelClient | null> {
  let transport: Transport | null = null;
  if (isTauri()) transport = await createTauriTransport();
  else if (query.get("kernel")) transport = await createWsTransport(query.get("kernel")!, query.get("token") ?? "", browserClientId(), query.get("workspace"));
  if (!transport) return null;
  try {
    return await createKernelClient(transport, locale);
  } catch (error) {
    transport.close();
    throw error;
  }
}

/** One id per browser tab: the kernel keeps interface state per client (§9.2). */
function browserClientId(): string {
  try {
    const key = "onedesk.client";
    const known = sessionStorage.getItem(key);
    if (known) return known;
    const fresh = `web-${Math.random().toString(36).slice(2, 10)}`;
    sessionStorage.setItem(key, fresh);
    return fresh;
  } catch {
    return `web-${Math.random().toString(36).slice(2, 10)}`;
  }
}
