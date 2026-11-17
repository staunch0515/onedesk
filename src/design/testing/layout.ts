import { vi } from "vitest";

/**
 * jsdom has no layout. This gives every element a viewport height and answers the row-height tokens, so the windowing of
 * trees and tables (D373) can be tested. Call the returned function to restore.
 */
export function fakeLayout(options: { viewport: number; tokens: Record<string, string> }): () => void {
  const height = vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(options.viewport);
  const real = window.getComputedStyle.bind(window);
  const style = vi.spyOn(window, "getComputedStyle").mockImplementation((el: Element, pseudo?: string | null) => {
    const base = real(el, pseudo);
    return new Proxy(base, {
      get(target, key) {
        if (key === "getPropertyValue") return (name: string) => options.tokens[name] ?? target.getPropertyValue(name);
        const v = Reflect.get(target, key);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
  });
  return () => {
    height.mockRestore();
    style.mockRestore();
  };
}
