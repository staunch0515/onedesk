import { beforeEach, describe, expect, it } from "vitest";
import type { HostApi, Resource } from "../plugin-api";
import type { KernelEvent } from "./contracts";
import { createTestKernel } from "./testing";
import type { TestKernel } from "./testing";
import { SAMPLE_ID, SAMPLE_KIND, createSamplePlugin } from "./testing/sample";

/**
 * D10: a global action (no `kinds`) gets the resource in its context, so passing a resourceId must not let a
 * plugin read a kind outside its scope (own kinds + kinds of `requires.plugins`).
 *
 * Plugins here: sample (owns the resource), reader (requires sample), chain (requires reader only), stranger.
 */
const READER = "org.test.reader";
const CHAIN = "org.test.chain";
const STRANGER = "org.test.stranger";

let t: TestKernel;
let hosts: Record<string, HostApi>;
let peeked: string[];
let secret: Resource;
let events: KernelEvent[];

function peeker(id: string, kind: string, requires: string[]) {
  return createSamplePlugin({
    manifest: { id, provides: { kinds: [kind], actions: ["peek"] }, requires: { plugins: requires } },
    activate: (host) => {
      hosts[id] = host;
      host.resources.registerKind({ id: kind, name: kind, schema: [], views: [], describe: () => ({ summary: "", usage: "" }) });
      host.actions.register({
        id: "peek",
        label: "偷看",
        output: "text",
        run: (context) => {
          peeked.push(`${id}:${context.resource?.name ?? "无"}`);
          return { type: "text", text: JSON.stringify(context.resource?.body ?? null) };
        },
      });
    },
  }).source;
}

beforeEach(async () => {
  hosts = {};
  peeked = [];
  t = await createTestKernel({
    plugins: [createSamplePlugin().source, peeker(READER, "reader-item", [SAMPLE_ID]), peeker(CHAIN, "chain-item", [READER]), peeker(STRANGER, "stranger-item", [])],
  });
  secret = await t.kernel.resources.create({ kind: SAMPLE_KIND, name: "机密", body: { url: "https://example.com/secret" } });
  events = [];
  t.kernel.events.onAny((e) => events.push(e));
});

describe("全局动作收到 resourceId 时的读取范围（D10）", () => {
  it("审查复现：无关插件的全局动作读不到别的插件的资源", async () => {
    const result = await t.kernel.actions.run(`${STRANGER}/peek`, { resourceId: secret.id });
    expect(result).toMatchObject({ status: "error", error: { code: "permission", message: expect.stringContaining(SAMPLE_KIND) } });
    expect(result.output).toBeUndefined();
    expect(peeked).toEqual([]);
    expect(events.some((e) => e.type === "action.started")).toBe(false);
  });

  it("声明了 requires.plugins 的插件可以；自己的 kind 可以；不带资源也可以", async () => {
    expect(await t.kernel.actions.run(`${READER}/peek`, { resourceId: secret.id })).toMatchObject({ status: "success", output: { text: JSON.stringify(secret.body) } });
    const own = await t.kernel.resources.create({ kind: "stranger-item", name: "自己的" });
    expect(await t.kernel.actions.run(`${STRANGER}/peek`, { resourceId: own.id })).toMatchObject({ status: "success" });
    expect(await t.kernel.actions.run(`${STRANGER}/peek`, {})).toMatchObject({ status: "success", output: { text: "null" } });
    expect(await t.kernel.actions.run(`${SAMPLE_ID}/hello`, { resourceId: secret.id })).toMatchObject({ status: "success" });
    expect(peeked).toEqual([`${READER}:机密`, `${STRANGER}:自己的`, `${STRANGER}:无`]);
  });

  it("读取范围不传递：chain 只声明了 reader，读不到 sample 的资源", async () => {
    expect(await t.kernel.actions.run(`${CHAIN}/peek`, { resourceId: secret.id })).toMatchObject({ status: "error", error: { code: "permission" } });
    expect(peeked).toEqual([]);
  });

  it("host.actions.run：自己的全局动作同样受限", async () => {
    expect(await hosts[STRANGER]!.actions.run(`${STRANGER}/peek`, { resourceId: secret.id })).toMatchObject({ status: "error", error: { code: "permission" } });
    expect(await hosts[READER]!.actions.run(`${READER}/peek`, { resourceId: secret.id })).toMatchObject({ status: "success" });
    expect(peeked).toEqual([`${READER}:机密`]);
  });

  it("host.actions.run：不能借别的插件的动作读自己无权读的资源", async () => {
    // reader 能读 sample 的资源，但调用者 chain 不能。
    const result = await hosts[CHAIN]!.actions.run(`${READER}/peek`, { resourceId: secret.id });
    expect(result).toMatchObject({ status: "error", action: `${READER}/peek`, resourceId: secret.id, error: { code: "permission", message: expect.stringContaining(CHAIN) } });
    expect(peeked).toEqual([]);
    expect(events).toEqual([]);
    // 对自己能读的资源照常可以。
    const item = await t.kernel.resources.create({ kind: "reader-item", name: "reader 的" });
    expect(await hosts[CHAIN]!.actions.run(`${READER}/peek`, { resourceId: item.id })).toMatchObject({ status: "success" });
    // 资源不存在时交给内核返回 not_found。
    expect(await hosts[CHAIN]!.actions.run(`${READER}/peek`, { resourceId: "nope" })).toMatchObject({ status: "error", error: { code: "not_found" } });
  });

  it("绑定 kind 的动作不受影响", async () => {
    expect(await hosts[READER]!.actions.run(`${SAMPLE_ID}/echo`, { resourceId: secret.id, input: { text: "x" } })).toMatchObject({ status: "success" });
  });
});
