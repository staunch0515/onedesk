import type { EventHandler } from "../types";

/** Topic → handlers. After the connection was lost and restored, everyone reads again (§12 `connection`). */
export class EventBus {
  private readonly handlers = new Map<string, Set<EventHandler>>();

  subscribe(topic: string, handler: EventHandler): () => void {
    let set = this.handlers.get(topic);
    if (!set) this.handlers.set(topic, (set = new Set()));
    set.add(handler);
    return () => void set.delete(handler);
  }

  emit(topic: string, payload?: unknown): void {
    for (const h of [...(this.handlers.get(topic) ?? [])]) h(topic, payload);
  }

  /** Calls every handler with its own topic, as if that topic had just changed. */
  refreshAll(except = "connection"): void {
    for (const [topic, set] of [...this.handlers]) if (topic !== except) for (const h of [...set]) h(topic);
  }
}
