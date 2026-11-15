// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { createMockClient } from "./index";

describe("mock: round 5", () => {
  it("lists the known parameters with their layers", async () => {
    const client = createMockClient({ fresh: true, quiet: true });
    const known = await client.params.known();
    expect(known.find((k) => k.name === "protection.readonly")).toMatchObject({ type: "boolean", merge: "deny", layers: ["config", "env"] });
    expect(known.find((k) => k.name === "ui.language")?.layers).toEqual(["config"]);
  });

  it("finds [[name]] references in both directions and marks a missing target", async () => {
    const client = createMockClient({ fresh: true, quiet: true });
    const target = await client.resource.get("q-orders-today");
    const note = await client.resource.get("n-runbook");
    expect(target && note).toBeTruthy();
    const text = Object.keys(note!.body).find((k) => typeof note!.body[k] === "string") ?? "text";
    await client.page.save("resource:n-runbook", { [`body.${text}`]: `see [[${target!.name}]] and [[No such thing]]` });
    const out = (await client.refs.outgoing("n-runbook")).filter((r) => r.field === `body.${text}`);
    expect(out.map((r) => [r.text, r.state])).toEqual([[target!.name, "ok"], ["No such thing", "missing"]]);
    expect((await client.refs.incoming("q-orders-today")).map((r) => r.source.id)).toContain("n-runbook");
    await client.resource.delete("q-orders-today");
    expect((await client.refs.outgoing("n-runbook")).find((r) => r.text === target!.name)?.state).toBe("deleted");
    expect(await client.refs.incoming("q-orders-today")).toEqual([]);
  });

  it("refuses saving, running and exporting under the protection parameters, naming the reason", async () => {
    const client = createMockClient({ fresh: true, quiet: true });
    const cfg = (await client.tree.children("config", null)).nodes[0]!;
    await client.params.set(cfg.key, "protection.readonly", "true");
    const page = await client.page.resolve("resource:q-orders-today", {});
    expect(page.restrictions).toEqual(["readonly"]);
    await expect(client.page.save("resource:q-orders-today", { name: "x" })).rejects.toMatchObject({ code: "denied", params: { reason: "readonly" } });
    await client.params.set(cfg.key, "protection.readonly", "false");
    await client.params.set(cfg.key, "protection.no_export", "true");
    await expect(client.workspace.export("/tmp/x")).rejects.toMatchObject({ params: { reason: "noExport" } });
  });
});
