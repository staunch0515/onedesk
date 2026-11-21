// @vitest-environment jsdom
import "../../design/testing/jsdom-setup";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { EnvParam, EnvView, PageDescriptor, SearchHit } from "../protocol";
import { createMockClient } from "../protocol/mock";
import { kernelLikeClient, renderInShell } from "../testing/harness";
import type { TabState } from "../state/store";
import { EnvPage } from "./env-page";

const tab: TabState = { id: "t1", target: "resource:env1", title: "", icon: "layers", pinned: false, envId: null, params: {} };
const descriptor = { target: tab.target, title: "Staging", icon: "layers", found: true, state: "ok", breadcrumb: [{ label: "Staging", tree: "environments", key: "env1" }], page: "env", view: [], actions: [], resultTabs: [], usesEnv: false, hasInfo: false, readOnly: false, recompute: false, values: {}, autosave: false, resourceId: "env1" } as unknown as PageDescriptor;

const param = (over: Partial<EnvParam>): EnvParam => ({ name: "datasource", type: "ref", value: "ds1", display: "Warehouse", sourceId: "root", sourceName: "Production", own: false, declaredBy: [], ...over }) as EnvParam;
const hit = (id: string, title: string): SearchHit => ({ target: `resource:${id}`, title, icon: "database", subtitle: "Data / " + title, state: "ok" });

function setup(params: EnvParam[]) {
  const view: EnvView = { id: "env1", name: "Staging", description: "", chain: [], params, children: [], rev: 3 } as EnvView;
  const set = vi.fn(async () => undefined);
  const base = kernelLikeClient(createMockClient({ fresh: true, quiet: true }), {});
  const client = {
    ...base,
    params: { ...base.params, env: async () => view, set, known: async () => [] },
    search: { query: async (text: string) => (text.toLowerCase().includes("ware") ? [hit("ds2", "Warehouse 2"), { ...hit("x", "Note"), target: "node:plugins/x" }] : []) },
  };
  renderInShell(client, <EnvPage tab={tab} descriptor={descriptor} />);
  return { set };
}

describe("environment reference parameters (G3)", () => {
  it("shows the inherited reference with the layer it comes from, and picks another resource for this environment", async () => {
    const { set } = setup([param({})]);
    expect(await screen.findByDisplayValue("Warehouse")).toBeTruthy();
    expect(screen.getByText(/Production/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Search by name"), { target: { value: "ware" } });
    fireEvent.click(await within(dialog).findByText("Warehouse 2"));
    await waitFor(() => expect(set).toHaveBeenCalledWith("env1", "datasource", "ds2", "3"));
  });

  it("adds a reference parameter under a name of its own, with the resource picked from a search", async () => {
    const { set } = setup([]);
    await screen.findByText("Staging", {}, { timeout: 2000 }).catch(() => null);
    fireEvent.click(await screen.findByRole("button", { name: /Add parameter/i }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("combobox"));
    fireEvent.click(await screen.findByRole("option", { name: "Resource reference" }));
    // No name is suggested (the shell knows no plugin's parameter names); Add stays off until one is typed.
    const name = within(dialog).getByLabelText("Parameter name") as HTMLInputElement;
    expect(name.value).toBe("");
    fireEvent.change(name, { target: { value: "datasource" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Choose…" }));
    const picker = (await screen.findAllByRole("dialog")).at(-1)!;
    fireEvent.change(within(picker).getByLabelText("Search by name"), { target: { value: "ware" } });
    fireEvent.click(await within(picker).findByText("Warehouse 2"));
    fireEvent.click(await within(dialog).findByRole("button", { name: "Add" }));
    await waitFor(() => expect(set).toHaveBeenCalledWith("env1", "datasource", "ds2", "3", "ref"));
  });
});
