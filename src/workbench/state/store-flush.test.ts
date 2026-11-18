import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "./store";

describe("the layout save waits for a quiet moment, but a page that goes away flushes it", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("a closed tab is written at once by flush(), once, and the timer does not write it again", () => {
    const save = vi.fn();
    const store = createStore(null, save);
    store.set({ tabs: [{ id: "a", target: "resource:a", title: "A", icon: "file", pinned: false, envId: null, params: {} }], activeTabId: "a" });
    vi.advanceTimersByTime(300);
    expect(save).toHaveBeenCalledTimes(1);
    store.set({ tabs: [] , activeTabId: null }); // the user closes the tab, then the page reloads within the quiet moment
    expect(save).toHaveBeenCalledTimes(1); // still waiting: this is the lost write
    store.flush();
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1]![0].tabs).toEqual([]);
    vi.advanceTimersByTime(1000);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("flush with nothing waiting writes nothing", () => {
    const save = vi.fn();
    const store = createStore(null, save);
    store.flush();
    expect(save).not.toHaveBeenCalled();
  });
});
