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

const message = { "en-US": "report.txt already exists." };

describe("same-name conflict choice (X18)", () => {
  it("offers overwrite, skip and keep both, and sends the chosen one back with the command", async () => {
    const execute = setup({ type: "confirm", message, command: "files:paste", choices: [{ id: "overwrite" }, { id: "skip" }, { id: "keepBoth" }], choiceArg: "conflict" });
    expect(await screen.findByRole("button", { name: "Overwrite" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Skip" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep both" }));
    await waitFor(() => expect(execute).toHaveBeenCalledWith("files:paste", expect.objectContaining({ args: { confirmed: true, conflict: "keepBoth" } })));
  });

  it("cancel runs nothing", async () => {
    const execute = setup({ type: "confirm", message, command: "files:paste", choices: [{ id: "overwrite" }, { id: "skip" }] });
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("permanent delete asks twice and says it cannot be undone", () => {
  it("shows the warning and runs only after the danger button", async () => {
    const execute = setup({ type: "confirm", message: { "en-US": "Delete report.txt permanently?" }, command: "files:purge", danger: true, irreversible: true });
    expect(await screen.findByText(/Delete report.txt permanently\? This cannot be undone\./)).toBeTruthy();
    expect(execute).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(execute).toHaveBeenCalledWith("files:purge", expect.objectContaining({ args: { confirmed: true } })));
  });
});

describe("replacing a granted folder (X18)", () => {
  it("a pick-folder effect with `replace` calls plugin.replaceFolder instead of grantFolder", async () => {
    const mock = createMockClient({ fresh: true, quiet: true });
    const replaceFolder = vi.fn(async (plugin: string, _path: string, n: string) => ({ plugin, folders: [n] }));
    const grantFolder = vi.fn(async (plugin: string, p: string) => ({ plugin, folders: [p] }));
    const client = kernelLikeClient(mock, {
      plugin: { ...mock.plugin, replaceFolder, grantFolder } as never,
      platform: { pickFolder: async () => "/new" } as never,
    });
    renderInShell(client, <Probe effect={{ type: "pick-folder", plugin: "p", replace: "/old" }} />);
    fireEvent.click(screen.getByText("ask"));
    await waitFor(() => expect(replaceFolder).toHaveBeenCalledWith("p", "/old", "/new"));
    expect(grantFolder).not.toHaveBeenCalled();
  });
});
