import { describe, expect, it } from "vitest";
import type { EventMessage } from "../generated";
import { KernelError } from "../errors";
import { createKernelClient } from "./real-client";
import type { Transport } from "./transport";

function fakeTransport(answers: Record<string, (params: unknown) => unknown>) {
  const calls: Array<{ method: string; params: unknown }> = [];
  const handlers = new Set<(e: EventMessage) => void>();
  const transport: Transport = {
    async request(method, params) {
      calls.push({ method, params });
      const answer = answers[method];
      if (!answer) throw new KernelError("unknownMethod", { method });
      const out = answer(params);
      if (out instanceof KernelError) throw out;
      return out;
    },
    onEvent(h) {
      handlers.add(h);
      return () => handlers.delete(h);
    },
    close() {},
  };
  return { transport, calls, emit: (e: EventMessage) => handlers.forEach((h) => h(e)) };
}

const hello = () => ({ protocol: "1", workspace: { id: "w", name: "W" } });

describe("kernel client", () => {
  it("refuses a kernel that speaks another protocol version", async () => {
    const { transport } = fakeTransport({ hello: () => ({ protocol: "2", workspace: { id: "w", name: "W" } }) });
    await expect(createKernelClient(transport)).rejects.toMatchObject({ code: "versionMismatch" });
  });

  it("sends hello first and leaves out null and undefined params", async () => {
    const { transport, calls } = fakeTransport({ hello, "tree.children": () => ({ nodes: [] }) });
    const client = await createKernelClient(transport);
    await client.tree.children("resources", null);
    expect(calls[0]).toEqual({ method: "hello", params: { protocol: "1" } });
    expect(calls[1]).toEqual({ method: "tree.children", params: { tree: "resources" } });
  });

  it("sends the locale and unsaved draft with page.resolve, but no null environment", async () => {
    const { transport, calls } = fakeTransport({ hello, "page.resolve": () => ({}) });
    const client = await createKernelClient(transport, () => "zh-CN");
    await client.page.resolve("resource:1", { envId: null, draft: { name: "x" } });
    expect(calls[1]?.params).toEqual({ target: "resource:1", context: { draft: { name: "x" }, locale: "zh-CN" } });
  });

  it("passes kernel errors through with their code", async () => {
    const { transport } = fakeTransport({ hello, "page.save": () => new KernelError("conflict", { field: "name" }) });
    const client = await createKernelClient(transport);
    await expect(client.page.save("resource:1", { name: "a" }, "3")).rejects.toMatchObject({ code: "conflict", params: { field: "name" } });
  });

  it("delivers events by topic with their payload", async () => {
    const { transport, emit } = fakeTransport({ hello });
    const client = await createKernelClient(transport);
    const seen: Array<[string, unknown]> = [];
    const off = client.events.subscribe("tree:resources", (t, p) => seen.push([t, p]));
    emit({ topic: "tree:resources", payload: { a: 1 } });
    emit({ topic: "tree:other" });
    off();
    emit({ topic: "tree:resources" });
    expect(seen).toEqual([["tree:resources", { a: 1 }]]);
  });

  it("makes every subscriber read again after the connection is restored", async () => {
    const { transport, emit } = fakeTransport({ hello });
    const client = await createKernelClient(transport);
    const topics: string[] = [];
    client.events.subscribe("tree:resources", (t) => topics.push(t));
    client.events.subscribe("resource:7", (t) => topics.push(t));
    emit({ topic: "connection", payload: "lost" });
    expect(topics).toEqual([]);
    expect(client.connection()).toBe("lost");
    emit({ topic: "connection", payload: "restored" });
    expect(topics.sort()).toEqual(["resource:7", "tree:resources"]);
  });

  it("hands the interface language to commands", async () => {
    const { transport, calls } = fakeTransport({ hello, "command.execute": () => [] });
    const client = await createKernelClient(transport, () => "zh-CN");
    await client.command.execute("a:b", { tree: "t", nodeKey: null });
    expect(calls[1]).toEqual({ method: "command.execute", params: { id: "a:b", context: { locale: "zh-CN", tree: "t" } } });
  });

  it("sends the environment revision as basis with parameter changes, and nothing when there is none", async () => {
    const { transport, calls } = fakeTransport({ hello, "params.set": () => null, "params.unset": () => null, "params.acknowledge": () => null });
    const client = await createKernelClient(transport);
    await client.params.set("e1", "host", "db", "7");
    await client.params.unset("e1", "host", "7");
    await client.params.acknowledge("e1", "host");
    expect(calls.slice(1).map((c) => c.params)).toEqual([
      { node: "e1", name: "host", value: "db", basis: "7" },
      { node: "e1", name: "host", basis: "7" },
      { node: "e1", name: "host" },
    ]);
  });
});
