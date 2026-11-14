import { describe, expect, it } from "vitest";
import { createFakeHost } from "./fake-host";

describe("fake host", () => {
  it("emits resource events for create, update and delete", async () => {
    const host = createFakeHost();
    const seen: string[] = [];
    host.events.on("resource.created", () => seen.push("created"));
    host.events.on("resource.updated", () => seen.push("updated"));
    host.events.on("resource.deleted", (e) => seen.push(`deleted:${e.kind}`));
    const r = await host.resources.create({ kind: "k", name: "a" });
    await host.resources.update(r.id, { name: "b" });
    await host.resources.delete(r.id);
    expect(seen).toEqual(["created", "updated", "deleted:k"]);
  });

  it("rejects action output that fails ActionOutputSchema or mismatches the declared type", async () => {
    const host = createFakeHost();
    host.actions.register({ id: "bad", label: "x", output: "text", run: () => ({ type: "link", href: "file:///x" }) });
    host.actions.register({ id: "wrong", label: "x", output: "text", run: () => ({ type: "link", href: "https://a.io" }) });
    host.actions.register({ id: "ok", label: "x", output: "text", run: () => ({ type: "text", text: "hi" }) });
    expect((await host.runAction("bad", undefined)).error?.code).toBe("internal");
    expect((await host.runAction("wrong", undefined)).error?.message).toContain("不符");
    expect((await host.runAction("ok", undefined)).output).toEqual({ type: "text", text: "hi", format: "plain" });
  });

  it("settings.get prefers explicit values over manifest defaults", async () => {
    const manifest = { id: "a.b", name: "x", version: "1.0.0", apiVersion: "1", settings: [{ name: "n", label: "n", type: "number" as const, default: 1 }] };
    expect(await createFakeHost({ manifest }).settings.get("n")).toBe(1);
    expect(await createFakeHost({ manifest, settings: { n: 2 } }).settings.get("n")).toBe(2);
  });
});
