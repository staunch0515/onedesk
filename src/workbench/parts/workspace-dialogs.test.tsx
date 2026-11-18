// @vitest-environment jsdom
import "../../design/testing/jsdom-setup";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockClient } from "../protocol/mock";
import { renderInShell } from "../testing/harness";
import { WorkspaceDialogs, type WorkspaceDialog } from "./workspace-dialogs";

afterEach(() => vi.restoreAllMocks());

function Host({ first }: { first: WorkspaceDialog }) {
  const [dialog, setDialog] = useState<WorkspaceDialog>(first);
  return <WorkspaceDialogs dialog={dialog} setDialog={setDialog} />;
}

describe("workspace dialogs (D400)", () => {
  it("the demo has two workspaces; the list shows them and the one in use cannot be deleted", async () => {
    const client = createMockClient({ fresh: true, quiet: true });
    renderInShell(client, <Host first={{ kind: "manage" }} />);
    await screen.findByText("个人 Personal");
    expect(screen.getAllByRole("row").length).toBe(3); // header + 2
    const deletes = screen.getAllByRole("button", { name: /^Delete / });
    expect(deletes.filter((b) => (b as HTMLButtonElement).disabled).length).toBe(1);
  });

  it("creates a workspace with a trimmed name and refuses an empty or over-long one", async () => {
    const client = createMockClient({ fresh: true, quiet: true });
    const create = vi.spyOn(client.workspace, "create");
    renderInShell(client, <Host first={{ kind: "create" }} />);
    const input = await screen.findByRole("textbox");
    const ok = screen.getByRole("button", { name: "Create" }) as HTMLButtonElement;
    expect(ok.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "x".repeat(101) } });
    expect(ok.disabled).toBe(true);
    expect(screen.getByText("At most 100 characters.")).toBeTruthy();
    fireEvent.change(input, { target: { value: "  Team  " } });
    expect(ok.disabled).toBe(false);
    fireEvent.click(ok);
    await waitFor(() => expect(create).toHaveBeenCalledWith("Team"));
    expect((await client.workspace.list()).map((w) => w.name)).toContain("Team");
  });

  it("delete says where the workspace goes and refuses nothing for another workspace", async () => {
    const client = createMockClient({ fresh: true, quiet: true });
    const personal = (await client.workspace.list()).find((w) => !w.current)!;
    renderInShell(client, <Host first={{ kind: "delete", entry: personal }} />);
    await screen.findByText(/moved to the trash folder inside the data directory/);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(async () => expect((await client.workspace.list()).length).toBe(1));
  });

  it("the demo refuses to delete the workspace in use, as the main process does", async () => {
    const client = createMockClient({ fresh: true, quiet: true });
    const current = (await client.workspace.list()).find((w) => w.current)!;
    await expect(client.workspace.remove(current.id)).rejects.toMatchObject({ code: "conflict", params: { reason: "inUse" } });
  });
});
