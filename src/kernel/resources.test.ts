import { beforeEach, describe, expect, it } from "vitest";
import type { KernelEvent } from "./contracts";
import { createTestKernel } from "./testing";
import type { TestKernel } from "./testing";
import { SAMPLE_ID, SAMPLE_KIND, createSamplePlugin } from "./testing/sample";

const URL = "https://example.com";
let t: TestKernel;
let events: KernelEvent[];

beforeEach(async () => {
  t = await createTestKernel({ plugins: [createSamplePlugin().source] });
  events = [];
  t.kernel.events.onAny((e) => events.push(e));
});

const draft = (name: string, extra: Record<string, unknown> = {}) => ({ kind: SAMPLE_KIND, name, body: { url: URL }, ...extra });

describe("资源增删改查", () => {
  it("新建时补全默认值、分配 id、发出事件", async () => {
    const r = await t.kernel.resources.create({ ...draft("  首页  "), id: "mine", origin: "copied", tags: ["a", "a", "b"] });
    expect(r).toMatchObject({ name: "首页", group: "", tags: ["a", "b"], description: "", visibility: "private", aiVisible: false, version: 1, origin: "original" });
    expect(r.id).not.toBe("mine");
    expect(r.createdAt).toBe(r.updatedAt);
    expect(await t.kernel.resources.get(r.id)).toEqual(r);
    expect(events).toContainEqual({ type: "resource.created", resource: r });
  });

  it("名称为空或类型未注册时拒绝", async () => {
    await expect(t.kernel.resources.create(draft("   "))).rejects.toMatchObject({ code: "validation", fields: { name: "名称不能为空" } });
    await expect(t.kernel.resources.create({ kind: "missing", name: "x" })).rejects.toMatchObject({ code: "unavailable" });
  });

  it("更新只改给出的字段，版本加一", async () => {
    const r = await t.kernel.resources.create(draft("a", { description: "d", tags: ["x"] }));
    const u = await t.kernel.resources.update(r.id, { name: "b", group: "工作", aiVisible: true, visibility: "public" });
    expect(u).toMatchObject({ name: "b", group: "工作", description: "d", tags: ["x"], aiVisible: true, visibility: "public", version: 2, createdAt: r.createdAt });
    expect(u.updatedAt > r.updatedAt).toBe(true);
    expect(await t.kernel.resources.get(r.id)).toEqual(u);
    expect(events).toContainEqual({ type: "resource.updated", resource: u });
  });

  it("乐观并发：版本不符时报冲突，数据不变", async () => {
    const r = await t.kernel.resources.create(draft("a"));
    await t.kernel.resources.update(r.id, { name: "b", expectedVersion: 1 });
    await expect(t.kernel.resources.update(r.id, { name: "c", expectedVersion: 1 })).rejects.toMatchObject({ code: "conflict" });
    expect((await t.kernel.resources.get(r.id))?.name).toBe("b");
    const ok = await t.kernel.resources.update(r.id, { name: "c", expectedVersion: 2 });
    expect(ok.version).toBe(3);
  });

  it("乐观并发：读取之后被别人改掉，写入也报冲突", async () => {
    const r = await t.kernel.resources.create(draft("a"));
    const realSelect = t.platform.db.select.bind(t.platform.db);
    let once = true;
    t.platform.db.select = async (sql, params) => {
      const rows = await realSelect(sql, params);
      if (once && sql.includes("FROM resources WHERE id")) {
        once = false;
        t.db.run("UPDATE resources SET version = version + 1 WHERE id = ?", [r.id]);
      }
      return rows as never;
    };
    await expect(t.kernel.resources.update(r.id, { name: "b" })).rejects.toMatchObject({ code: "conflict" });
  });

  it("更新和删除不存在的资源报 not_found", async () => {
    await expect(t.kernel.resources.update("nope", { name: "x" })).rejects.toMatchObject({ code: "not_found" });
    await expect(t.kernel.resources.delete("nope")).rejects.toMatchObject({ code: "not_found" });
    expect(await t.kernel.resources.get("nope")).toBeNull();
  });

  it("删除后查不到并发出事件", async () => {
    const r = await t.kernel.resources.create(draft("a"));
    await t.kernel.resources.delete(r.id);
    expect(await t.kernel.resources.get(r.id)).toBeNull();
    expect(events).toContainEqual({ type: "resource.deleted", id: r.id, kind: SAMPLE_KIND });
    expect(t.kernel.plugins.list()[0]?.resourceCount).toBe(0);
  });

  it("补丁格式不对时拒绝", async () => {
    const r = await t.kernel.resources.create(draft("a"));
    await expect(t.kernel.resources.update(r.id, { name: " " })).rejects.toMatchObject({ code: "validation" });
    await expect(t.kernel.resources.update(r.id, { visibility: "secret" as never })).rejects.toMatchObject({ code: "validation" });
  });
});

describe("body 校验", () => {
  const bad: Array<[string, Record<string, unknown>, string]> = [
    ["缺少必填", {}, "url"],
    ["必填为空串", { url: "" }, "url"],
    ["网址协议不允许", { url: "javascript:alert(1)" }, "url"],
    ["网址不是字符串", { url: 1 }, "url"],
    ["网址无法解析", { url: "http://" }, "url"],
    ["文本不是字符串", { url: URL, note: 1 }, "note"],
    ["数字不是数字", { url: URL, count: "1" }, "count"],
    ["数字不是有限数", { url: URL, count: Number.POSITIVE_INFINITY }, "count"],
    ["布尔不是布尔", { url: URL, flag: "yes" }, "flag"],
    ["选项不在范围", { url: URL, mode: "c" }, "mode"],
    ["选项不是字符串", { url: URL, mode: 1 }, "mode"],
    ["引用不是字符串", { url: URL, ref: 1 }, "ref"],
    ["参数不是列表", { url: URL, params: "x" }, "params"],
    ["参数名不合法", { url: URL, params: [{ name: "1x" }] }, "params"],
    ["参数名重复", { url: URL, params: [{ name: "a" }, { name: "a" }] }, "params"],
    ["kind.validate 的错误", { url: URL, note: "bad" }, "note"],
  ];
  it.each(bad)("拒绝：%s", async (_label, body, field) => {
    expect(Object.keys(t.kernel.resources.validate(SAMPLE_KIND, body))).toEqual([field]);
    await expect(t.kernel.resources.create({ kind: SAMPLE_KIND, name: "x", body })).rejects.toMatchObject({ code: "validation" });
  });

  it("合法 body 通过；可选字段可以为空", async () => {
    const body = { url: "mailto:a@example.com", note: "", count: 0, flag: false, mode: "a", ref: "id-1", params: [{ name: "a", default: "1" }], extra: { any: 1 } };
    expect(t.kernel.resources.validate(SAMPLE_KIND, body)).toEqual({});
    const r = await t.kernel.resources.create({ kind: SAMPLE_KIND, name: "x", body });
    expect(r.body).toEqual(body);
  });

  it("schema 错误和 kind.validate 错误合并到 fields，键是 body 字段名", async () => {
    const error = await t.kernel.resources.create({ kind: SAMPLE_KIND, name: "x", body: { note: "bad" } }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "validation", fields: { url: "网址不能为空", note: "备注不能是 bad" } });
    expect((error as Error).message).toBe("网址不能为空；备注不能是 bad");
  });

  it("更新时校验新的 body；不带 body 的更新不校验", async () => {
    const r = await t.kernel.resources.create(draft("a"));
    await expect(t.kernel.resources.update(r.id, { body: { url: "ftp://x" } })).rejects.toMatchObject({ code: "validation", fields: { url: expect.any(String) } });
    await t.kernel.plugins.disable(SAMPLE_ID);
    expect((await t.kernel.resources.update(r.id, { name: "b" })).name).toBe("b");
    await expect(t.kernel.resources.update(r.id, { body: { url: URL } })).rejects.toMatchObject({ code: "unavailable" });
  });

  it("未注册的类型无法校验，返回空对象", () => {
    expect(t.kernel.resources.validate("missing", {})).toEqual({});
  });
});

describe("查询、标签、分组、集合", () => {
  beforeEach(async () => {
    await t.kernel.resources.create(draft("一", { tags: ["工作", "a"], group: "甲" }));
    await t.kernel.resources.create(draft("二", { tags: ["工作"], group: "乙" }));
    await t.kernel.resources.create(draft("三", { tags: ["工"], group: "甲" }));
    await t.kernel.resources.create(draft("四"));
  });
  const names = (list: Array<{ name: string }>) => list.map((r) => r.name);

  it("默认按更新时间倒序，支持 limit 和 offset", async () => {
    expect(names(await t.kernel.resources.list())).toEqual(["四", "三", "二", "一"]);
    expect(names(await t.kernel.resources.list({ limit: 2 }))).toEqual(["四", "三"]);
    expect(names(await t.kernel.resources.list({ limit: 2, offset: 1 }))).toEqual(["三", "二"]);
    expect(names(await t.kernel.resources.list({ offset: 3 }))).toEqual(["一"]);
    expect(names(await t.kernel.resources.list({ limit: 0 }))).toEqual([]);
  });

  it("按标签精确匹配（“工”不会匹配“工作”）、按分组、按类型，条件取交集", async () => {
    expect(names(await t.kernel.resources.list({ tag: "工作" }))).toEqual(["二", "一"]);
    expect(names(await t.kernel.resources.list({ tag: "工" }))).toEqual(["三"]);
    expect(names(await t.kernel.resources.list({ group: "甲" }))).toEqual(["三", "一"]);
    expect(names(await t.kernel.resources.list({ group: "甲", tag: "工作" }))).toEqual(["一"]);
    expect(names(await t.kernel.resources.list({ group: "" }))).toEqual(["四"]);
    expect(names(await t.kernel.resources.list({ kind: SAMPLE_KIND }))).toHaveLength(4);
    expect(await t.kernel.resources.list({ kind: "other" })).toEqual([]);
  });

  it("统计标签和分组", async () => {
    expect(await t.kernel.resources.tags()).toEqual([{ tag: "工作", count: 2 }, { tag: "工", count: 1 }, { tag: "a", count: 1 }]);
    expect(await t.kernel.resources.groups()).toEqual(["甲", "乙"].sort((a, b) => a.localeCompare(b, "zh-CN")));
  });

  it("集合：按标签、按类型；增删改查与事件", async () => {
    const byTag = await t.kernel.collections.create({ name: " 工作相关 ", rule: { type: "tag", value: "工作" } });
    const byKind = await t.kernel.collections.create({ name: "全部示例", rule: { type: "kind", value: SAMPLE_KIND } });
    expect(byTag.name).toBe("工作相关");
    expect(await t.kernel.collections.list()).toEqual([byTag, byKind]);
    expect(await t.kernel.collections.get(byTag.id)).toEqual(byTag);
    expect(await t.kernel.collections.get("nope")).toBeNull();
    expect(names(await t.kernel.collections.resources(byTag.id))).toEqual(["二", "一"]);
    expect(names(await t.kernel.collections.resources(byKind.id))).toHaveLength(4);
    expect(names(await t.kernel.resources.list({ collectionId: byTag.id, group: "甲" }))).toEqual(["一"]);

    const updated = await t.kernel.collections.update(byTag.id, { rule: { type: "tag", value: "a" } });
    expect(updated).toMatchObject({ name: "工作相关", rule: { type: "tag", value: "a" } });
    expect((await t.kernel.collections.update(byTag.id, { name: "新名字" })).name).toBe("新名字");
    expect(names(await t.kernel.collections.resources(byTag.id))).toEqual(["一"]);

    await t.kernel.collections.delete(byTag.id);
    expect(await t.kernel.collections.get(byTag.id)).toBeNull();
    await expect(t.kernel.collections.resources(byTag.id)).rejects.toMatchObject({ code: "not_found" });
    expect(events.filter((e) => e.type === "collection.changed")).toHaveLength(5);
  });

  it("集合：非法输入和不存在的 id", async () => {
    await expect(t.kernel.collections.create({ name: " ", rule: { type: "tag", value: "a" } })).rejects.toMatchObject({ code: "validation" });
    await expect(t.kernel.collections.create({ name: "x", rule: { type: "smart" as never, value: "a" } })).rejects.toMatchObject({ code: "validation" });
    await expect(t.kernel.collections.create({ name: "x", rule: { type: "tag", value: "" } })).rejects.toMatchObject({ code: "validation" });
    await expect(t.kernel.collections.update("nope", { name: "x" })).rejects.toMatchObject({ code: "not_found" });
    await expect(t.kernel.collections.delete("nope")).rejects.toMatchObject({ code: "not_found" });
  });

  it("插件停用后默认查不到它的资源，includeDisabled 可以", async () => {
    await t.kernel.plugins.disable(SAMPLE_ID);
    expect(await t.kernel.resources.list()).toEqual([]);
    expect(await t.kernel.resources.tags()).toEqual([]);
    expect(await t.kernel.resources.groups()).toEqual([]);
    expect(await t.kernel.resources.list({ includeDisabled: true })).toHaveLength(4);
  });
});

describe("偏好设置与事件", () => {
  it("读写 JSON 值并发出事件；undefined 删除", async () => {
    expect(await t.kernel.prefs.get("menu.order")).toBeUndefined();
    await t.kernel.prefs.set("menu.order", ["a", "b"]);
    await t.kernel.prefs.set("menu.order", ["b", "a"]);
    expect(await t.kernel.prefs.get<string[]>("menu.order")).toEqual(["b", "a"]);
    await t.kernel.prefs.set("menu.order", undefined);
    expect(await t.kernel.prefs.get("menu.order")).toBeUndefined();
    await expect(t.kernel.prefs.set("", 1)).rejects.toMatchObject({ code: "validation" });
    expect(events.filter((e) => e.type === "prefs.changed")).toHaveLength(3);
  });

  it("取消订阅后不再收到；处理函数抛错不影响其他订阅者", async () => {
    const seen: string[] = [];
    const off = t.kernel.events.on("prefs.changed", () => {
      throw new Error("boom");
    });
    const off2 = t.kernel.events.on("prefs.changed", (e) => seen.push(e.key));
    const quiet = console.error;
    console.error = () => undefined;
    await t.kernel.prefs.set("a", 1);
    console.error = quiet;
    off();
    off2();
    await t.kernel.prefs.set("b", 1);
    expect(seen).toEqual(["a"]);
  });

  it("默认上下文与密钥透传", async () => {
    expect(t.kernel.context.workspace.id).toBe("local");
    await t.kernel.secrets.set("k", "v");
    expect(await t.kernel.secrets.list()).toEqual(["k"]);
    expect(await t.kernel.secrets.get("k")).toBe("v");
    await t.kernel.secrets.delete("k");
    expect(await t.kernel.secrets.get("k")).toBeUndefined();
  });
});
