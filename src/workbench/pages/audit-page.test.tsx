// @vitest-environment jsdom
import "../../design/testing/jsdom-setup";
import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AuditRow, PageDescriptor } from "../protocol";
import { createMockClient } from "../protocol/mock";
import { kernelLikeClient, renderInShell } from "../testing/harness";
import type { TabState } from "../state/store";
import { AuditPage } from "./audit-page";

const tab: TabState = { id: "t1", target: "core:audit", title: "", icon: "history", pinned: false, envId: null, params: {} };
const descriptor = { target: tab.target, title: "Audit", icon: "history", found: true, state: "ok", breadcrumb: [], page: "audit", view: [], actions: [], resultTabs: [], usesEnv: false, hasInfo: false, readOnly: false, recompute: false, values: {}, autosave: false } as unknown as PageDescriptor;

const row = (id: string, result: AuditRow["result"]): AuditRow => ({ id, at: Date.now(), actor: "plugin:x", source: "plugin", operation: "transfer.download", target: "127.0.0.1", result, detail: "{}" }) as AuditRow;

describe("audit page results (round 9, D369)", () => {
  it("shows cancelled and timeout as their own results (no cast: the generated type has them)", async () => {
    const base = kernelLikeClient(createMockClient({ fresh: true, quiet: true }), {});
    const list = vi.fn(async () => [row("1", "cancelled"), row("2", "timeout"), row("3", "error")]);
    renderInShell({ ...base, audit: { ...base.audit, list } }, <AuditPage tab={tab} descriptor={descriptor} />);
    expect((await screen.findAllByText("Cancelled")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Timed out").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Error").length).toBeGreaterThan(0);
  });
});
