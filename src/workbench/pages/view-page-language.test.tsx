// @vitest-environment jsdom
import "../../design/testing/jsdom-setup";
import { act } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createMockClient } from "../protocol/mock";
import type { TabState } from "../state/store";
import { kernelLikeClient, renderInShell } from "../testing/harness";
import { ViewPage } from "./view-page";
import type { PageDescriptor } from "../protocol";

const tab: TabState = { id: "t1", target: "resource:r1", title: "R", icon: "file", pinned: false, envId: null, params: {}, basis: "1" };
const descriptor = { target: tab.target, title: "R", icon: "file", found: true, state: "ok", breadcrumb: [], page: "view", resourceId: "r1", basis: "1", view: [], actions: [], resultTabs: [], usesEnv: false, hasInfo: false, readOnly: false, recompute: false, values: {}, autosave: false } as unknown as PageDescriptor;

describe("a plugin page and the interface language (round 11 leftover)", () => {
  it("asks for the page again when the language changes, and not otherwise", async () => {
    const client = kernelLikeClient(createMockClient({ fresh: true, quiet: true }), {});
    const { store, rerender } = renderInShell(client, <ViewPage tab={tab} descriptor={descriptor} />);
    store.set({ tabs: [tab], activeTabId: "t1" });
    const reloads = () => store.get().tabs.find((t) => t.id === "t1")?.reload ?? 0;
    await act(async () => rerender(<ViewPage tab={tab} descriptor={descriptor} />));
    expect(reloads()).toBe(0);
    await act(async () => rerender(<ViewPage tab={tab} descriptor={descriptor} />, "zh-CN"));
    expect(reloads()).toBe(1);
  });
});
