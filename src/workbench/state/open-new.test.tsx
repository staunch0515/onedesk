// @vitest-environment jsdom
import "../../design/testing/jsdom-setup";
import { act } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createMockClient } from "../protocol/mock";
import { useWorkbench } from "./context";
import { renderInShell } from "../testing/harness";

describe("opening a not-yet-created target with initial state (D414)", () => {
  it("puts the state into the first draft; an existing target takes it as page parameters", () => {
    let api: ReturnType<typeof useWorkbench> | undefined;
    const Probe = () => {
      api = useWorkbench();
      return null;
    };
    const { store } = renderInShell(createMockClient({ fresh: true, quiet: true }), <Probe />);
    act(() => api!.actions.open("new:q:sql?parent=g", { params: { "body.sql": "select 1" } }));
    const s = store.get();
    const tab = s.tabs.find((t) => t.target.startsWith("new:"))!;
    expect(s.drafts[tab.id]).toEqual({ "body.sql": "select 1" });
    expect(tab.params).toEqual({});
  });
});
