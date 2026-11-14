import { describe, expect, it } from "vitest";
import type { HostApi, NetworkRequestInit, NetworkResponse } from "../plugin-api";
import { MAX_REDIRECTS, isNetworkAllowed, parseNetworkPattern } from "./host-api";
import { createTestKernel, pluginSource } from "./testing";
import { SAMPLE_ID, createSamplePlugin, sampleManifest } from "./testing/sample";

const reply = (status: number, headers: Record<string, string> = {}, body = ""): NetworkResponse => ({ status, statusText: "", headers, body, durationMs: 1 });

/** A kernel whose network answers from a table: url → response (unknown urls answer 200 "ok"). */
async function withNetwork(routes: Record<string, NetworkResponse>, network: string[] = ["api.example.com", "*.example.org"]) {
  const plugin = createSamplePlugin({ manifest: { requires: { network } } });
  const t = await createTestKernel({ plugins: [plugin.source], fetch: async (url) => routes[url] ?? reply(200, {}, "ok") });
  const sent = () => t.requests.map((r) => [r.init?.method ?? "GET", r.url]);
  return { t, host: plugin.host(), sent };
}

describe("重定向不能绕过网络白名单（D13）", () => {
  it("平台被要求不要自动跟随重定向；目标在白名单内时由宿主逐跳检查后跟随", async () => {
    const { t, host, sent } = await withNetwork({
      "https://api.example.com/a": reply(302, { location: "/b" }),
      "https://api.example.com/b": reply(301, { location: "https://cdn.example.org/c" }),
    });
    expect(await host.network.fetch("https://api.example.com/a")).toMatchObject({ status: 200, body: "ok" });
    expect(sent()).toEqual([["GET", "https://api.example.com/a"], ["GET", "https://api.example.com/b"], ["GET", "https://cdn.example.org/c"]]);
    expect(t.requests.every((r) => (r.init as NetworkRequestInit & { redirect?: string }).redirect === "manual")).toBe(true);
  });

  it.each([
    ["未声明的主机", "https://evil.com/steal"],
    ["未声明的端口", "https://api.example.com:8443/x"],
    ["非 http 协议", "file:///etc/passwd"],
    ["协议相对地址指向别的主机", "//evil.com/x"],
    ["无法解析的地址", "http://"],
  ])("重定向到%s：拒绝，且不会发出第二个请求", async (_label, location) => {
    const { host, sent } = await withNetwork({ "https://api.example.com/a": reply(302, { location }) });
    await expect(host.network.fetch("https://api.example.com/a")).rejects.toMatchObject({ code: "permission", message: expect.stringContaining("重定向") });
    expect(sent()).toEqual([["GET", "https://api.example.com/a"]]);
  });

  it("第二跳才跳出白名单也会被拒绝", async () => {
    const { host, sent } = await withNetwork({
      "https://api.example.com/a": reply(307, { location: "https://api.example.com/b" }),
      "https://api.example.com/b": reply(307, { location: "https://evil.com/" }),
    });
    await expect(host.network.fetch("https://api.example.com/a")).rejects.toMatchObject({ code: "permission" });
    expect(sent()).toHaveLength(2);
  });

  it("303 以及 POST 遇到 301/302 改为不带正文的 GET；307/308 保留方法和正文", async () => {
    const { t, host, sent } = await withNetwork({
      "https://api.example.com/303": reply(303, { location: "/done" }),
      "https://api.example.com/302": reply(302, { location: "/done" }),
      "https://api.example.com/307": reply(307, { location: "/done" }),
    });
    await host.network.fetch("https://api.example.com/303", { method: "PUT", body: "x" });
    await host.network.fetch("https://api.example.com/302", { method: "post", body: "x" });
    await host.network.fetch("https://api.example.com/307", { method: "POST", body: "x" });
    expect(sent()).toEqual([
      ["PUT", "https://api.example.com/303"],
      ["GET", "https://api.example.com/done"],
      ["post", "https://api.example.com/302"],
      ["GET", "https://api.example.com/done"],
      ["POST", "https://api.example.com/307"],
      ["POST", "https://api.example.com/done"],
    ]);
    expect(t.requests.map((r) => r.init?.body)).toEqual(["x", undefined, "x", undefined, "x", "x"]);
  });

  it("跨源重定向时去掉 Authorization 和 Cookie，同源保留", async () => {
    const { t, host } = await withNetwork({
      "https://api.example.com/same": reply(302, { location: "/next" }),
      "https://api.example.com/cross": reply(302, { location: "https://cdn.example.org/next" }),
    });
    const headers = { Authorization: "Bearer s3cret", cookie: "sid=1", Accept: "text/plain" };
    await host.network.fetch("https://api.example.com/same", { headers });
    await host.network.fetch("https://api.example.com/cross", { headers });
    expect(t.requests.map((r) => r.init?.headers)).toEqual([headers, headers, headers, { Accept: "text/plain" }]);
  });

  it("重定向次数过多时报错；没有 Location 的 3xx 和 304 原样返回", async () => {
    const { host, sent } = await withNetwork({
      "https://api.example.com/loop": reply(302, { location: "/loop" }),
      "https://api.example.com/odd": reply(300),
      "https://api.example.com/cached": reply(304, { location: "https://evil.com/" }),
    });
    await expect(host.network.fetch("https://api.example.com/loop")).rejects.toMatchObject({ code: "unavailable", message: expect.stringContaining("重定向次数过多") });
    expect(sent()).toHaveLength(MAX_REDIRECTS + 1);
    expect((await host.network.fetch("https://api.example.com/odd")).status).toBe(300);
    expect((await host.network.fetch("https://api.example.com/cached")).status).toBe(304);
  });

  it("声明了 * 的插件：交给平台自动跟随，只发一个请求", async () => {
    const { t, host } = await withNetwork({ "https://a.com/": reply(200, {}, "final") }, ["*"]);
    expect(await host.network.fetch("https://a.com/")).toMatchObject({ body: "final" });
    expect(t.requests).toEqual([{ url: "https://a.com/", init: { timeoutMs: 30_000, redirect: "follow" } }]);
  });
});

describe("requires.network 的格式与端口（D13/D59）", () => {
  it.each([
    ["带协议", "https://api.example.com"],
    ["带路径", "api.example.com/v1"],
    ["带查询", "api.example.com?x=1"],
    ["带用户信息", "user@api.example.com"],
    ["前后有空格", " api.example.com "],
    ["端口超出范围", "api.example.com:70000"],
    ["端口为 0", "api.example.com:0"],
    ["端口不是数字", "api.example.com:https"],
    ["通配符不在最前", "api.*.com"],
    ["通配符后没有点", "*example.com"],
    ["只有通配和点", "*."],
    ["两个通配", "*.*"],
    ["带端口的全通配", "*:443"],
    ["IPv6 字面量", "[::1]"],
    ["以连字符开头的标签", "-bad.example.com"],
  ])("加载时拒绝：%s", async (_label, pattern) => {
    expect(parseNetworkPattern(pattern)).toBeUndefined();
    const plugin = createSamplePlugin({ manifest: { requires: { network: ["api.example.com", pattern] } } });
    const t = await createTestKernel({ plugins: [plugin.source] });
    expect(t.kernel.plugins.list()).toEqual([]);
    expect(plugin.activations).toBe(0);
    expect(t.kernel.plugins.loadErrors()).toEqual([expect.objectContaining({ pluginId: SAMPLE_ID, reason: expect.stringContaining("requires.network") })]);
    expect(t.kernel.plugins.loadErrors()[0]?.reason).toContain(pattern);
  });

  it("合法写法都能加载", async () => {
    const network = ["*", "localhost", "localhost:3000", "127.0.0.1:8080", "API.Example.com", "*.example.com", "*.example.com:8443", "a-b.example.co"];
    const t = await createTestKernel({ plugins: [pluginSource(sampleManifest({ provides: {}, requires: { network } }), { activate: () => undefined })] });
    expect(t.kernel.plugins.loadErrors()).toEqual([]);
    expect(t.kernel.plugins.list()[0]?.state).toBe("enabled");
  });

  it.each<[string, string, boolean]>([
    ["example.com", "https://example.com/", true],
    ["example.com", "http://example.com/", true],
    ["example.com", "https://example.com:443/", true],
    ["example.com", "http://example.com:80/", true],
    ["example.com", "https://example.com:8443/", false],
    ["example.com", "http://example.com:8080/", false],
    ["example.com", "http://example.com:443/", false],
    ["example.com", "https://example.com:80/", false],
    ["example.com:8080", "https://example.com:8080/", true],
    ["example.com:8080", "http://example.com:8080/", true],
    ["example.com:8080", "https://example.com:9090/", false],
    ["example.com:8080", "https://example.com/", false],
    ["example.com:443", "https://example.com/", true],
    ["example.com:443", "http://example.com/", false],
    ["*.example.com", "https://a.example.com/", true],
    ["*.example.com", "https://a.example.com:8443/", false],
    ["*.example.com:8443", "https://a.example.com:8443/", true],
    ["*.example.com:8443", "https://a.example.com/", false],
    ["*.example.com:8443", "https://example.com:8443/", false],
    ["Example.COM", "https://example.com./", true],
    ["*", "https://anything.example:12345/", true],
    ["*", "ftp://anything.example/", false],
  ])("模式 %s 对 %s → %s", (pattern, url, allowed) => {
    expect(isNetworkAllowed([pattern], url)).toBe(allowed);
  });

  it("带端口的声明经宿主 API 生效", async () => {
    let host: HostApi | undefined;
    const plugin = createSamplePlugin({
      manifest: { provides: {}, requires: { network: ["localhost:3000"] } },
      activate: (h) => {
        host = h;
      },
    });
    const t = await createTestKernel({ plugins: [plugin.source], fetch: async () => reply(200) });
    expect((await host!.network.fetch("http://localhost:3000/api")).status).toBe(200);
    await expect(host!.network.fetch("http://localhost/api")).rejects.toMatchObject({ code: "permission" });
    await expect(host!.network.fetch("http://localhost:3001/api")).rejects.toMatchObject({ code: "permission" });
    expect(t.requests).toHaveLength(1);
  });
});
