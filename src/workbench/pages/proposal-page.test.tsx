// @vitest-environment jsdom
import "../../design/testing/jsdom-setup";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PageDescriptor } from "../protocol";
import type { ProposalReviewParams, ProposalView } from "../protocol/generated";
import { createMockClient } from "../protocol/mock";
import { kernelLikeClient, renderInShell } from "../testing/harness";
import type { TabState } from "../state/store";
import { ProposalPage } from "./proposal-page";

const tab: TabState = { id: "t1", target: "resource:p1", title: "", icon: "git-pull-request", pinned: false, envId: null, params: {} };
const descriptor = { target: tab.target, title: "Tighten", icon: "git-pull-request", found: true, state: "ok", breadcrumb: [], page: "proposal", view: [], actions: [], resultTabs: [], usesEnv: false, hasInfo: true, readOnly: true, recompute: false, values: {}, autosave: false, resourceId: "p1" } as unknown as PageDescriptor;

function proposal(): ProposalView {
  return {
    id: "p1",
    title: "Tighten chapter 1",
    comment: "Shorter",
    proposer: "ai:tester",
    status: "pending",
    at: 1_700_000_000_000,
    items: [
      { index: 0, op: "update", resourceId: "a", name: "Chapter 1", kind: "k", location: ["", "Book"], rev: 2, currentRev: 2, stale: false, gone: false, fields: [{ path: "body.text", label: "Text", kind: "longtext", before: "one\ntwo", current: "one\ntwo", proposed: "one\ntwo!", changed: false }] },
      { index: 1, op: "create", resourceId: "book", name: "Summary", kind: "k", location: ["Book"], stale: false, gone: false, fields: [{ path: "name", before: null, current: null, proposed: "Summary", changed: false }, { path: "body.text", label: "Text", before: null, current: null, proposed: "In short.", changed: false }] },
      { index: 2, op: "delete", resourceId: "d", name: "Draft", kind: "k", location: [], rev: 1, currentRev: 1, stale: false, gone: false, fields: [] },
      { index: 3, op: "update", resourceId: "b", name: "Chapter 2", kind: "k", location: [], rev: 1, currentRev: 3, stale: true, gone: false, fields: [{ path: "body.text", label: "Text", before: "old", current: "by user", proposed: "by AI", changed: true }] },
    ],
  };
}

function setup() {
  let p = proposal();
  const review = vi.fn(async (params: ProposalReviewParams) => {
    p = { ...p, items: p.items.map((i) => (params.items.some((d) => d.index === i.index) ? { ...i, result: params.items.find((d) => d.index === i.index)!.decision === "accept" ? "accepted" : "rejected" } : i)) };
    p.status = p.items.every((i) => i.result) ? "partial" : "partial";
    return p;
  });
  const client = kernelLikeClient(createMockClient({ fresh: true, quiet: true }), {
    proposal: { get: vi.fn(async () => p), review, withdraw: vi.fn(), count: vi.fn(async () => ({ pending: 1, ids: ["p1"] })), create: vi.fn() },
  });
  renderInShell(client, <ProposalPage tab={tab} descriptor={descriptor} />);
  return { review };
}

const block = async (name: RegExp) => (await screen.findByRole("heading", { name })).closest("section")!;

describe("proposal page (D487 §29.2)", () => {
  it("shows who proposed, each item compared with what is there now, and the original that changed since", async () => {
    setup();
    expect(await screen.findByText(/AI client tester/)).toBeTruthy();
    expect(screen.getByText("Shorter")).toBeTruthy();
    const first = await block(/1\. Change · Chapter 1/);
    expect(first.querySelector(".od-diff__mark--added")!.textContent).toBe("!");
    const stale = await block(/4\. Change · Chapter 2/);
    expect(within(stale).getByText("Original changed")).toBeTruthy();
    expect(stale.querySelector(".od-diff__cell--removed")!.textContent).toBe("by user");
    const del = await block(/3\. Delete · Draft/);
    expect(within(del).getByText(/moves it to Deleted/)).toBeTruthy();
  });

  it("accepts one, rejects one, and accepts a new page after editing it, against the revision shown", async () => {
    const { review } = setup();
    const first = await block(/1\. Change · Chapter 1/);
    fireEvent.click(within(first).getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(review).toHaveBeenCalledWith({ id: "p1", items: [{ index: 0, decision: "accept", basis: 2 }] }));
    expect(await within(await block(/1\. Change/)).findByText("Accepted")).toBeTruthy();
    fireEvent.click(within(await block(/3\. Delete/)).getByRole("button", { name: "Reject" }));
    await waitFor(() => expect(review).toHaveBeenLastCalledWith({ id: "p1", items: [{ index: 2, decision: "reject", basis: 1 }] }));
    const add = await block(/2\. Add · Summary/);
    fireEvent.click(within(add).getByRole("button", { name: "Edit" }));
    fireEvent.change(within(add).getByLabelText("Edit Text"), { target: { value: "In short, better." } });
    fireEvent.click(within(add).getByRole("button", { name: "Accept as edited" }));
    await waitFor(() => expect(review).toHaveBeenLastCalledWith({ id: "p1", items: [{ index: 1, decision: "accept", values: { name: "Summary", "body.text": "In short, better." } }] }));
  });

  it("accepts the stale one only with the revision now there", async () => {
    const { review } = setup();
    const stale = await block(/4\. Change · Chapter 2/);
    fireEvent.click(within(stale).getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(review).toHaveBeenCalledWith({ id: "p1", items: [{ index: 3, decision: "accept", basis: 3 }] }));
  });
});
