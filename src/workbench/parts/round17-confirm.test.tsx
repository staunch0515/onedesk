// @vitest-environment jsdom
import "../../design/testing/jsdom-setup";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createMockClient } from "../protocol/mock";
import { kernelLikeClient, renderInShell } from "../testing/harness";
import { useWorkbench } from "../state/context";
import { CommandDialogs } from "./command-dialogs";

function Probe({ effect }: { effect: unknown }) {
  const { actions } = useWorkbench();
  return <button onClick={() => actions.runEffects([effect as never])}>ask</button>;
}

function setup(effect: unknown) {
  const mock = createMockClient({ fresh: true, quiet: true });
  const execute = vi.fn(async () => []);
  const client = kernelLikeClient(mock, { command: { ...mock.command, execute } as never });
  renderInShell(client, <><Probe effect={effect} /><CommandDialogs /></>);
  act(() => void fireEvent.click(screen.getByText("ask")));
  return execute;
}


describe("confirming a permanent delete (X18)", () => {
  it("shows the plugin's own sentence and runs only after the danger button, with confirmed: true", async () => {
    const execute = setup({ type: "confirm", message: { "en-US": "Delete report.txt permanently? This cannot be undone." }, command: "files:purge", danger: true });
    expect(await screen.findByText(/This cannot be undone\./)).toBeTruthy();
    expect(execute).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(execute).toHaveBeenCalledWith("files:purge", expect.objectContaining({ args: { confirmed: true } })));
  });

  it("cancel runs nothing", async () => {
    const execute = setup({ type: "confirm", message: { "en-US": "Sure?" }, command: "files:purge", danger: true });
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("replacing a granted folder (X18)", () => {
  it("a pick-folder effect with `replace` calls plugin.replaceFolder instead of grantFolder", async () => {
    const mock = createMockClient({ fresh: true, quiet: true });
    const replaceFolder = vi.fn(async (plugin: string, _path: string, n: string) => ({ plugin, folders: [n, "/other"] }));
    const grantFolder = vi.fn(async (plugin: string, p: string) => ({ plugin, folders: [p] }));
    const client = kernelLikeClient(mock, {
      plugin: { ...mock.plugin, replaceFolder, grantFolder } as never,
      platform: { pickFolder: async () => "/new" } as never,
    });
    renderInShell(client, <Probe effect={{ type: "pick-folder", plugin: "p", replace: "/old" }} />);
    fireEvent.click(screen.getByText("ask"));
    await waitFor(() => expect(replaceFolder).toHaveBeenCalledWith("p", "/old", "/new"));
    expect(grantFolder).not.toHaveBeenCalled();
    // The toast names the folder that now stands in the old one's place, not the last one in the list.
    expect(await screen.findByText(/\/new/)).toBeTruthy();
  });
});
