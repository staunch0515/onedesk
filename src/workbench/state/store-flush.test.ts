import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "./store";

describe("the layout save waits for a quiet moment, but a page that goes away flushes it", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("a closed tab is written at once by flush(), once, and the timer does not write it again", () => {
    const save = vi.fn();
    const store = createStore(null, save);
    save.mockClear();
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
    save.mockClear();
    store.flush();
    expect(save).not.toHaveBeenCalled();
  });

  it("keeps page parameters in memory but never writes or restores them", () => {
    const save = vi.fn();
    const store = createStore(
      {
        tabs: [{ id: "a", target: "resource:a", title: "A", icon: "file", pinned: false, envId: null, params: { connection: "postgres://user:secretpw@host/db" } }],
        activeTabId: "a",
      },
      save,
    );

    // Older persisted values are cleared as soon as the saved layout is loaded.
    expect(store.get().tabs[0]?.params).toEqual({});
    expect(save.mock.calls.at(-1)?.[0].tabs[0]?.params).toEqual({});

    const secret = "postgres://user:secretpw@host/db";
    store.set({ tabs: [{ ...store.get().tabs[0]!, params: { connection: secret } }] });
    expect(store.get().tabs[0]?.params).toEqual({ connection: secret });
    store.flush();
    expect(save.mock.calls.at(-1)?.[0].tabs[0]?.params).toEqual({});
    expect(JSON.stringify(save.mock.calls)).not.toContain("secretpw");
  });
});
