// @vitest-environment jsdom
import "../../design/testing/jsdom-setup";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PageDescriptor } from "../protocol";
import type { IdentityInfo } from "../protocol/generated";
import { createMockClient } from "../protocol/mock";
import { kernelLikeClient, renderInShell } from "../testing/harness";
import type { TabState } from "../state/store";
import { ContactPage, IDENTITY_TARGET, IdentityPage } from "./identity-page";

const tab: TabState = { id: "t1", target: IDENTITY_TARGET, title: "", icon: "fingerprint", pinned: false, envId: null, params: {} };
const FP = "38CD CCC6 92DE 4055 3D82 EC04 13A2 A8EE";

describe("my identity (D487 §33)", () => {
  it("is made by the user with a name; then shows its fingerprint and exports its card to a path", async () => {
    let id: IdentityInfo | null = null;
    const identity = {
      get: vi.fn(async () => id),
      create: vi.fn(async (p: { name?: string; org?: string }) => (id = { name: p.name!, org: p.org ?? "", publicKey: "ab".repeat(32), fingerprint: FP, createdAt: 1_700_000_000_000 })),
      update: vi.fn(),
      delete: vi.fn(),
      exportCard: vi.fn(async () => undefined),
    };
    renderInShell(kernelLikeClient(createMockClient({ fresh: true, quiet: true }), { identity, contact: { importCard: vi.fn(), setChecked: vi.fn(), exportCard: vi.fn() } }), <IdentityPage tab={tab} />);
    const make = await screen.findByRole("button", { name: "Make my identity" });
    expect((make as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Teacher Zhang" } });
    fireEvent.click(make);
    await waitFor(() => expect(identity.create).toHaveBeenCalledWith({ name: "Teacher Zhang", org: "" }));
    expect(await screen.findByText(FP)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Export identity card" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByRole("textbox", { name: "File path" }), { target: { value: "/tmp/zhang.odid" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Use" }));
    await waitFor(() => expect(identity.exportCard).toHaveBeenCalledWith("/tmp/zhang.odid"));
  });
});

describe("a contact (D487 §33)", () => {
  it("is marked checked only after confirming the fingerprint was compared", async () => {
    let checked = false;
    const res = () => ({ id: "c1", kind: "core:contact", kindLabel: "core:contact", icon: "id-card", tree: "contacts", parentId: null, description: "", tags: [], location: [], state: "ok", origin: "original", rev: 1, name: "Teacher Zhang", body: { fingerprint: FP, org: "School", checked, source: "card", card: {} } });
    const setChecked = vi.fn(async (_id: string, on: boolean) => void (checked = on));
    const mock = createMockClient({ fresh: true, quiet: true });
    const client = kernelLikeClient(mock, { contact: { importCard: vi.fn(), setChecked, exportCard: vi.fn() }, resource: { ...mock.resource, get: async () => res() as never } });
    const descriptor = { target: "resource:c1", title: "Teacher Zhang", icon: "id-card", found: true, state: "ok", breadcrumb: [], page: "contact", view: [], actions: [], resultTabs: [], usesEnv: false, hasInfo: true, readOnly: true, recompute: false, values: {}, autosave: false, resourceId: "c1" } as unknown as PageDescriptor;
    renderInShell(client, <ContactPage tab={{ ...tab, target: "resource:c1" }} descriptor={descriptor} />);
    expect(await screen.findByText(FP)).toBeTruthy();
    expect(screen.getAllByText("Not checked").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("switch", { name: "I have checked this fingerprint" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain(FP);
    expect(setChecked).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Yes, it is the same" }));
    await waitFor(() => expect(setChecked).toHaveBeenCalledWith("c1", true));
  });
});
