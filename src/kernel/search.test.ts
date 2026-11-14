import { beforeEach, describe, expect, it } from "vitest";
import { buildSearchText, searchTerms } from "./search";
import { createTestKernel } from "./testing";
import type { TestKernel } from "./testing";
import { SAMPLE_ID, SAMPLE_KIND, createSamplePlugin } from "./testing/sample";

let t: TestKernel;
const names = (list: Array<{ name: string }>) => list.map((r) => r.name);

beforeEach(async () => {
  t = await createTestKernel({ plugins: [createSamplePlugin().source] });
});

const add = (name: string, extra: Record<string, unknown> = {}, body: Record<string, unknown> = {}) =>
  t.kernel.resources.create({ kind: SAMPLE_KIND, name, body: { url: "https://example.com", ...body }, ...extra });

describe("搜索", () => {
  beforeEach(async () => {
    await add("GitHub 主页", { tags: ["代码"], description: "代码托管" });
    await add("周报模板", { tags: ["写作"] }, { note: "本周完成了 GitHub 迁移", params: [{ name: "week_no" }] });
    await add("接口文档", { description: "内部 API 说明" }, { url: "https://docs.example.com/api" });
  });

  it("按名称（不区分大小写）", async () => {
    expect(names(await t.kernel.search("github 主页"))).toEqual(["GitHub 主页"]);
    expect(names(await t.kernel.search("GITHUB"))).toEqual(["GitHub 主页", "周报模板"]);
  });

  it("按标签", async () => {
    expect(names(await t.kernel.search("写作"))).toEqual(["周报模板"]);
  });

  it("按描述和正文（含嵌套的字符串）", async () => {
    expect(names(await t.kernel.search("api"))).toEqual(["接口文档"]);
    expect(names(await t.kernel.search("迁移"))).toEqual(["周报模板"]);
    expect(names(await t.kernel.search("week_no"))).toEqual(["周报模板"]);
    expect(names(await t.kernel.search("docs.example.com"))).toEqual(["接口文档"]);
  });

  it("中文子串", async () => {
    expect(names(await t.kernel.search("报模"))).toEqual(["周报模板"]);
    expect(names(await t.kernel.search("托管"))).toEqual(["GitHub 主页"]);
  });

  it("多词取交集，词可以落在不同字段", async () => {
    expect(names(await t.kernel.search("github 写作"))).toEqual(["周报模板"]);
    expect(names(await t.kernel.search("github   代码"))).toEqual(["GitHub 主页"]);
    expect(await t.kernel.search("github 不存在")).toEqual([]);
  });

  it("名称命中优先，其次按更新时间倒序", async () => {
    // “周报模板”更新得更晚，但 github 只出现在它的正文里。
    expect(names(await t.kernel.search("github"))).toEqual(["GitHub 主页", "周报模板"]);
    expect(names(await t.kernel.search("example"))).toEqual(["接口文档", "周报模板", "GitHub 主页"]);
  });

  it("更新后搜索内容同步", async () => {
    const [r] = await t.kernel.search("接口文档");
    await t.kernel.resources.update(r!.id, { name: "开放平台", description: "" });
    expect(await t.kernel.search("接口文档")).toEqual([]);
    expect(names(await t.kernel.search("开放"))).toEqual(["开放平台"]);
  });

  it("空查询返回最近的资源；limit 生效；可按类型过滤", async () => {
    expect(names(await t.kernel.search("  "))).toEqual(["接口文档", "周报模板", "GitHub 主页"]);
    expect(names(await t.kernel.search("", { limit: 1 }))).toEqual(["接口文档"]);
    expect(names(await t.kernel.search("example", { limit: 2 }))).toHaveLength(2);
    expect(await t.kernel.search("github", { kinds: ["other"] })).toEqual([]);
    expect(await t.kernel.search("github", { kinds: [SAMPLE_KIND] })).toHaveLength(2);
  });

  it("插件停用后默认搜不到，includeDisabled 可以", async () => {
    await t.kernel.plugins.disable(SAMPLE_ID);
    expect(await t.kernel.search("github")).toEqual([]);
    expect(await t.kernel.search("github", { includeDisabled: true })).toHaveLength(2);
  });

  it("查询里的 SQL 特殊字符按普通文字处理", async () => {
    await add("100% 完成'; DROP TABLE resources; --");
    expect(names(await t.kernel.search("100%"))).toHaveLength(1);
    expect(names(await t.kernel.search("'; drop"))).toHaveLength(1);
    expect(await t.kernel.search("_报模板")).toEqual([]);
  });
});

describe("search_text", () => {
  it("名称在第一行，全部小写，包含标签和 body 里的所有字符串", () => {
    const text = buildSearchText({ name: "Hello\nWorld", description: "Desc", tags: ["T1", "t2"], body: { a: "X", n: 1, list: [{ b: "Y" }], e: "" } });
    expect(text).toBe("hello world\ndesc\nt1 t2\nx\ny");
  });

  it("拆词去重", () => {
    expect(searchTerms("  A  b a ")).toEqual(["a", "b"]);
    expect(searchTerms("   ")).toEqual([]);
  });
});

describe("性能", () => {
  it("1 万条资源搜索 < 200ms", async () => {
    const words = ["项目", "周报", "接口", "github", "文档", "客户", "发布", "预算", "计划", "会议"];
    t.db.run("BEGIN");
    const stmt = t.db.prepare(
      `INSERT INTO resources (id, kind, name, group_name, tags, description, body, created_at, updated_at, search_text)
       VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, ?)`,
    );
    for (let i = 0; i < 10_000; i++) {
      const name = `${words[i % 10]}资料 ${i}`;
      const tags = [words[(i + 3) % 10]!];
      const description = `这是第 ${i} 条，关于${words[(i + 5) % 10]}的说明`;
      const body = { url: `https://example.com/item/${i}`, note: `正文内容 ${"lorem ipsum 多一些文字 ".repeat(8)}${i % 97 === 0 ? "稀有词" : ""}` };
      const at = new Date(1_700_000_000_000 + i * 1000).toISOString();
      stmt.run([`perf-${i}`, SAMPLE_KIND, name, JSON.stringify(tags), description, JSON.stringify(body), at, at, buildSearchText({ name, description, tags, body })]);
    }
    stmt.free();
    t.db.run("COMMIT");

    const queries = ["稀有词", "github", "周报 客户", "资料 9999", "不存在的词", "example.com"];
    await t.kernel.search("预热");
    // Each query runs 7 times and all timings are printed. The assertion uses the best run of each query: that is
    // the cost of the search itself, while slower runs measure whatever else the machine is doing (other test
    // workers, compilers). The slowest single run is printed too so regressions stay visible.
    const timings: Record<string, string> = {};
    let slowestQuery = 0;
    let slowestRun = 0;
    for (const q of queries) {
      const runs: number[] = [];
      let count = 0;
      for (let i = 0; i < 7; i++) {
        const start = performance.now();
        count = (await t.kernel.search(q)).length;
        runs.push(performance.now() - start);
      }
      slowestQuery = Math.max(slowestQuery, Math.min(...runs));
      slowestRun = Math.max(slowestRun, ...runs);
      timings[q] = `${runs.map((ms) => ms.toFixed(1)).join(" / ")} ms（${count} 条）`;
    }
    console.info(`[性能] 1 万条资源搜索：最慢的查询 ${slowestQuery.toFixed(1)}ms（各取最好的一次），单次最慢 ${slowestRun.toFixed(1)}ms`, timings);
    expect((await t.kernel.search("稀有词")).length).toBe(100);
    expect(names(await t.kernel.search("资料 9999"))).toEqual(["会议资料 9999"]);
    expect(slowestQuery).toBeLessThan(200);
  }, 60_000);
});
