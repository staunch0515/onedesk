// @vitest-environment jsdom
import "../../design/testing/jsdom-setup";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { EnvParam, EnvView, PageDescriptor, SearchHit } from "../protocol";
import { createMockClient } from "../protocol/mock";
import { kernelLikeClient, renderInShell } from "../testing/harness";
import type { TabState } from "../state/store";
import { EnvPage, valueForType } from "./env-page";

const tab: TabState = { id: "t1", target: "resource:env1", title: "", icon: "layers", pinned: false, envId: null, params: {} };
const descriptor = { target: tab.target, title: "Staging", icon: "layers", found: true, state: "ok", breadcrumb: [{ label: "Staging", tree: "environments", key: "env1" }], page: "env", view: [], actions: [], resultTabs: [], usesEnv: false, hasInfo: false, readOnly: false, recompute: false, values: {}, autosave: false, resourceId: "env1" } as unknown as PageDescriptor;

const param = (over: Partial<EnvParam>): EnvParam => ({ name: "datasource", type: "ref", value: "ds1", display: "Warehouse", sourceId: "root", sourceName: "Production", own: false, declaredBy: [], ...over }) as EnvParam;
const hit = (id: string, title: string): SearchHit => ({ target: `resource:${id}`, title, icon: "database", subtitle: "Data / " + title, state: "ok" });

function setup(params: EnvParam[]) {
  const view: EnvView = { id: "env1", name: "Staging", description: "", chain: [], params, children: [], rev: 3 } as EnvView;
  const set = vi.fn(async () => undefined);
  const rename = vi.fn(async () => undefined);
  const base = kernelLikeClient(createMockClient({ fresh: true, quiet: true }), {});
  const client = {
    ...base,
    params: { ...base.params, env: async () => view, set, rename, known: async () => [] },
    search: { query: async (text: string) => (text.toLowerCase().includes("ware") ? [hit("ds2", "Warehouse 2"), { ...hit("x", "Note"), target: "node:plugins/x" }] : []) },
  };
  renderInShell(client, <EnvPage tab={tab} descriptor={descriptor} />);
  return { set, rename };
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
    await waitFor(() => expect(set).toHaveBeenCalledWith("env1", "datasource", "ds2", "3", undefined));
  });

  it("adds a reference parameter in the last row: type Resource, then the resource picked from a search (D472)", async () => {
    const { set } = setup([]);
    const name = (await screen.findByLabelText("New parameter")) as HTMLInputElement;
    expect(name.value).toBe("");
    // The new row is the table's last row.
    expect(name.closest("tr")).not.toBeNull();
    fireEvent.change(name, { target: { value: "datasource" } });
    fireEvent.click(screen.getByRole("combobox", { name: "Type of the new parameter" }));
    fireEvent.click(await screen.findByRole("option", { name: "Resource" }));
    fireEvent.click(screen.getByRole("button", { name: "Choose…" }));
    const picker = await screen.findByRole("dialog");
    fireEvent.change(within(picker).getByLabelText("Search by name"), { target: { value: "ware" } });
    fireEvent.click(await within(picker).findByText("Warehouse 2"));
    await waitFor(() => expect(set).toHaveBeenCalledWith("env1", "datasource", "ds2", "3", "ref"));
  });

  it("adds any parameter by typing its name and value in the table's last row, Enter adds it (D470); a name with spaces or one already set is refused", async () => {
    const { set } = setup([param({ name: "region", type: "text", value: "eu", own: true, display: undefined })]);
    const name = await screen.findByLabelText("New parameter");
    const value = screen.getByRole("textbox", { name: "Value" }) as HTMLInputElement;
    const add = () => screen.getByRole("button", { name: "Add this parameter" }) as HTMLButtonElement;
    expect(add().disabled).toBe(true);
    fireEvent.change(name, { target: { value: "tenant id" } });
    expect(screen.getByText("A name has no spaces or braces.")).toBeTruthy();
    fireEvent.change(name, { target: { value: "region" } });
    expect(screen.getByText("This environment already sets that parameter.")).toBeTruthy();
    expect(add().disabled).toBe(true);
    fireEvent.change(name, { target: { value: "tenant_id" } });
    fireEvent.change(value, { target: { value: "1001" } });
    fireEvent.keyDown(value, { key: "Enter" });
    await waitFor(() => expect(set).toHaveBeenCalledWith("env1", "tenant_id", "1001", "3", "text"));
    // no dialog, no list of the workspace's own parameter names
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText("network.allow")).toBeNull();
  });

  it("has no description of its own: the description is in the info panel only (D470)", async () => {
    setup([]);
    await screen.findByLabelText("New parameter");
    expect(screen.queryByRole("textbox", { name: /description/i })).toBeNull();
  });

  it("a parameter set here is renamed in its row; an inherited one is not (D472)", async () => {
    const { rename } = setup([param({ name: "region", type: "text", value: "eu", own: true, display: undefined }), param({ name: "datasource" })]);
    const box = (await screen.findByRole("textbox", { name: "Name of region" })) as HTMLInputElement;
    expect(screen.queryByRole("textbox", { name: "Name of datasource" })).toBeNull();
    fireEvent.change(box, { target: { value: "area" } });
    fireEvent.keyDown(box, { key: "Enter" });
    fireEvent.blur(box);
    await waitFor(() => expect(rename).toHaveBeenCalledWith("env1", "region", "area", "3"));
  });

  it("a parameter set here gets another type from its row; the value follows the type (D472)", async () => {
    const { set } = setup([param({ name: "debug", type: "text", value: "true", own: true, display: undefined })]);
    fireEvent.click(await screen.findByRole("combobox", { name: "Type of debug" }));
    fireEvent.click(await screen.findByRole("option", { name: "Yes / no" }));
    await waitFor(() => expect(set).toHaveBeenCalledWith("env1", "debug", "true", "3", "boolean"));
    expect(valueForType({ type: "text", value: "x" }, "boolean")).toBe("false");
    expect(valueForType({ type: "text", value: "x" }, "ref")).toBe("");
    expect(valueForType({ type: "ref", value: "id1", display: "Warehouse" }, "text")).toBe("Warehouse");
    expect(valueForType({ type: "text", value: "12" }, "number")).toBe("12");
  });

  it("“Comes from” shows how the value is set from the top environment down; never set above, it is only a label (D472)", async () => {
    const layers = [
      { envId: "root", name: "Default", value: "12", effective: false },
      { envId: "mid", name: "Production", value: "14", effective: true },
    ];
    setup([param({ name: "price", type: "text", value: "15", own: true, display: undefined, layers }), param({ name: "solo", type: "text", value: "a", own: true, display: undefined })]);
    const trigger = await screen.findByRole("button", { name: /^This environment — / });
    expect(screen.getAllByRole("button", { name: /^This environment/ })).toHaveLength(1);
    fireEvent.click(trigger);
    const chain = await screen.findByRole("list", { name: "How price is set, from the top environment down" });
    const levels = within(chain).getAllByRole("listitem");
    expect(levels.map((l) => l.firstElementChild!.textContent)).toEqual(["Default", "Production", "Staging (this environment)In effect"]);
    expect(levels[0]!.textContent).toContain("12");
    expect(levels[2]!.textContent).toContain("15");
  });
});
