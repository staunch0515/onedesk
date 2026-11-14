/** Kernel event bus. Handler exceptions never reach the emitter (one bad listener must not break the others). */
import type { KernelEvent } from "./contracts";

type Handler = (event: KernelEvent) => void;

export class EventBus {
  private readonly byType = new Map<KernelEvent["type"], Set<Handler>>();
  private readonly any = new Set<Handler>();

  on<T extends KernelEvent["type"]>(type: T, handler: (e: Extract<KernelEvent, { type: T }>) => void): () => void {
    let set = this.byType.get(type);
    if (!set) {
      set = new Set();
      this.byType.set(type, set);
    }
    const handlers = set;
    const h = handler as Handler;
    handlers.add(h);
    return () => {
      handlers.delete(h);
    };
  }

  onAny(handler: Handler): () => void {
    this.any.add(handler);
    return () => {
      this.any.delete(handler);
    };
  }

  emit(event: KernelEvent): void {
    const handlers = [...(this.byType.get(event.type) ?? []), ...this.any];
    for (const handler of handlers) {
      try {
        handler(event);
      } catch (e) {
        console.error("事件处理出错", event.type, e);
      }
    }
  }
}
