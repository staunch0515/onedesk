// @vitest-environment jsdom
import "../../design/testing/jsdom-setup";
import { act, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createMockClient } from "../protocol/mock";
import { kernelLikeClient, renderInShell } from "../testing/harness";
import { useWorkbench, type Actions } from "./context";

function setup(count: number) {
  const base = createMockClient({ fresh: true, quiet: true });
  const execute = vi.fn(async () => []);
  const refs = { outgoing: async () => [], incoming: async () => Array.from({ length: count }, (_, i) => ({ source: { id: `s${i}`, name: "S" }, field: "body.text", text: "x", state: "ok" as const })) };
  const client = kernelLikeClient(base, { refs, command: { ...base.command, execute } });
  let actions!: Actions;
  const Grab = () => {
    actions = useWorkbench().actions;
    return null;
  };
  const { store } = renderInShell(client, <Grab />);
  return { execute, store, actions: () => actions };
}

describe("deleting something that is referred to", () => {
  it("asks first and says how many items refer to it", async () => {
    const { execute, store, actions } = setup(2);
    await act(async () => actions().command("node.delete", { tree: "resources", nodeKey: "n1" }));
    expect(execute).not.toHaveBeenCalled();
    expect(store.get().confirmCommand?.danger).toBe(true);
    expect(JSON.stringify(store.get().confirmCommand?.message)).toContain("2 other item(s)");
  });

  it("deletes at once when nothing refers to it", async () => {
    const { execute, store, actions } = setup(0);
    await act(async () => actions().command("node.delete", { tree: "resources", nodeKey: "n1" }));
    await waitFor(() => expect(execute).toHaveBeenCalled());
    expect(store.get().confirmCommand).toBeNull();
  });
});
