/**
 * jsdom gaps that Radix / cmdk rely on. Import at the top of component tests
 * (vite.config.ts is outside this module's scope, so there is no global setup file).
 */
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => cleanup());

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const g = globalThis as unknown as Record<string, unknown>;
if (!g.ResizeObserver) g.ResizeObserver = ResizeObserverStub;

const proto = Element.prototype as unknown as Record<string, unknown>;
if (!proto.scrollIntoView) proto.scrollIntoView = function scrollIntoView() {};
if (!proto.hasPointerCapture) proto.hasPointerCapture = () => false;
if (!proto.releasePointerCapture) proto.releasePointerCapture = () => {};

if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}
