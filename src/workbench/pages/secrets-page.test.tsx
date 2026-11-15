// @vitest-environment jsdom
import "../../design/testing/jsdom-setup";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SecretInfo } from "../protocol";
import { createMockClient } from "../protocol/mock";
import { kernelLikeClient, renderInShell } from "../testing/harness";
import type { TabState } from "../state/store";
import { SECRETS_TARGET, SecretsPage } from "./secrets-page";

const tab: TabState = { id: "t1", target: SECRETS_TARGET, title: "", icon: "key-round", pinned: false, envId: null, params: {} };

function setup() {
  let items: SecretInfo[] = [{ name: "api-token", updatedAt: 1_700_000_000_000, usedBy: ["Web tool"] }];
  const secrets = {
    list: vi.fn(async () => items),
    set: vi.fn(async (name: string) => void (items = [...items.filter((s) => s.name !== name), { name, updatedAt: 2, usedBy: [] }])),
    delete: vi.fn(async (name: string) => void (items = items.filter((s) => s.name !== name))),
  };
  renderInShell(kernelLikeClient(createMockClient({ fresh: true, quiet: true }), { secrets }), <SecretsPage tab={tab} />);
  return secrets;
}

describe("secrets page", () => {
  it("lists names and users, never a value, and writes a new one with the box emptied afterwards", async () => {
    const secrets = setup();
    expect(await screen.findByText("api-token")).toBeTruthy();
    expect(screen.getByText("Web tool")).toBeTruthy();
    const value = screen.getByLabelText("Value") as HTMLInputElement;
    expect(value.type).toBe("password");
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "db-pass" } });
    fireEvent.change(value, { target: { value: "s3cret" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(secrets.set).toHaveBeenCalledWith("db-pass", "s3cret"));
    expect((screen.getByLabelText("Value") as HTMLInputElement).value).toBe("");
    expect(await screen.findByText("db-pass")).toBeTruthy();
    expect(document.body.innerHTML).not.toContain("s3cret");
  });

  it("changes a value from a dialog and deletes after confirming", async () => {
    const secrets = setup();
    fireEvent.click(await screen.findByRole("button", { name: "Change value" }));
    const dialog = await screen.findByRole("dialog");
    const box = within(dialog).getByLabelText("Value") as HTMLInputElement;
    expect(box.value).toBe("");
    expect(box.type).toBe("password");
    fireEvent.change(box, { target: { value: "new-value" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(secrets.set).toHaveBeenCalledWith("api-token", "new-value"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    const confirm = await screen.findByRole("dialog");
    expect(secrets.delete).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(secrets.delete).toHaveBeenCalledWith("api-token"));
  });
});
