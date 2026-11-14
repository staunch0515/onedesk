import { afterEach, describe, expect, it, vi } from "vitest";
import { createKernel } from "../kernel";
import { loadSqlJs } from "../kernel/testing";
import { PREVIEW_DB_KEY, createBrowserPlatform } from "./browser";
import { assertSafeExternalUrl, performFetch } from "./http";
import type { FetchLike } from "./http";

const invoke = vi.hoisted(() => vi.fn());
const plugins = vi.hoisted(() => ({ openUrl: vi.fn(), writeText: vi.fn(), open: vi.fn(), fetch: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: plugins.openUrl }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: plugins.writeText }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: plugins.open }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: plugins.fetch }));

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  };
}

const response = (status: number, body: string, headers: Array<[string, string]> = []) => ({
  status,
  statusText: status === 200 ? "OK" : "Error",
  headers: { forEach: (cb: (value: string, name: string) => void) => headers.forEach(([name, value]) => cb(value, name)) },
  text: async () => body,
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("网络请求（两个平台共用）", () => {
  it("返回状态、小写的响应头（重复的用逗号连接）、正文和耗时；非 2xx 正常返回", async () => {
    const calls: unknown[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push([url, { ...init, signal: undefined }]);
      return response(404, "没有", [["Content-Type", "text/plain"], ["Set-Cookie", "a=1"], ["set-cookie", "b=2"]]);
    };
    const result = await performFetch(fetchImpl, "https://example.com/x", { method: "POST", headers: { A: "1" }, body: "{}" });
    expect(result).toMatchObject({ status: 404, statusText: "Error", body: "没有", headers: { "content-type": "text/plain", "set-cookie": "a=1, b=2" } });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(calls).toEqual([["https://example.com/x", { method: "POST", headers: { A: "1" }, body: "{}", signal: undefined }]]);
  });

  it("网络失败、超时、调用方取消都报 unavailable", async () => {
    const failing: FetchLike = async () => {
      throw new TypeError("Failed to fetch");
    };
    await expect(performFetch(failing, "https://example.com")).rejects.toMatchObject({
      code: "unavailable",
      message: "无法连接到服务器",
      hint: "检查网址和网络后重试（Failed to fetch）",
    });

    const hanging: FetchLike = (_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    await expect(performFetch(hanging, "https://example.com", { timeoutMs: 10 })).rejects.toMatchObject({ code: "unavailable", message: expect.stringContaining("请求超时") });

    const controller = new AbortController();
    const pending = performFetch(hanging, "https://example.com", { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "unavailable", message: "请求已取消" });

    const already = new AbortController();
    already.abort();
    await expect(performFetch(hanging, "https://example.com", { signal: already.signal })).rejects.toMatchObject({ message: "请求已取消" });
  });

  it("只允许 http/https；外部链接只允许 http、https、mailto", async () => {
    const never: FetchLike = async () => {
      throw new Error("不应该被调用");
    };
    await expect(performFetch(never, "file:///etc/passwd")).rejects.toMatchObject({ code: "permission" });
    await expect(performFetch(never, "ftp://example.com")).rejects.toMatchObject({ code: "permission" });
    expect(() => assertSafeExternalUrl("https://example.com")).not.toThrow();
    expect(() => assertSafeExternalUrl("mailto:a@example.com")).not.toThrow();
    for (const url of ["javascript:alert(1)", "file:///x", "example.com", ""]) expect(() => assertSafeExternalUrl(url)).toThrow(/只能打开/);
  });
});

describe("浏览器预览平台", () => {
  it("新库执行迁移并保存；刷新后数据还在；内核可以直接使用", async () => {
    const storage = memoryStorage();
    const platform = await createBrowserPlatform({ storage, initSql: loadSqlJs });
    expect(await platform.app.status()).toMatchObject({ schemaVersion: 1, latestSchemaVersion: 1, migrationError: null, backups: [], dbPath: `localStorage:${PREVIEW_DB_KEY}` });
    expect(storage.data.has(PREVIEW_DB_KEY)).toBe(true);

    const kernel = await createKernel({ platform });
    await kernel.prefs.set("theme", "dark");
    const collection = await kernel.collections.create({ name: "工作", rule: { type: "tag", value: "工作" } });

    const reloaded = await createBrowserPlatform({ storage, initSql: loadSqlJs });
    const kernel2 = await createKernel({ platform: reloaded });
    expect(await kernel2.prefs.get("theme")).toBe("dark");
    expect(await kernel2.collections.list()).toEqual([collection]);
  });

  it("保存的数据无法读取时报告 migrationError，不覆盖原数据", async () => {
    const storage = memoryStorage({ [PREVIEW_DB_KEY]: btoa("这不是数据库".split("").map((c) => c.charCodeAt(0) % 256).join("")) });
    const before = storage.data.get(PREVIEW_DB_KEY);
    const platform = await createBrowserPlatform({ storage, initSql: loadSqlJs });
    expect((await platform.app.status()).migrationError).toBeTruthy();
    await platform.db.execute("CREATE TABLE t (x)").catch(() => undefined);
    expect(storage.data.get(PREVIEW_DB_KEY)).toBe(before);
  });

  it("localStorage 写不进去时继续在内存中工作", async () => {
    const storage = memoryStorage();
    storage.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const platform = await createBrowserPlatform({ storage, initSql: loadSqlJs });
    expect(await platform.db.execute("INSERT INTO app_settings (key, value) VALUES ('a', '1')")).toEqual({ rowsAffected: 1 });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("密钥只在内存；插件扫描为空；导入未实现；导出走浏览器下载", async () => {
    const storage = memoryStorage();
    const platform = await createBrowserPlatform({ storage, initSql: loadSqlJs });
    await platform.secrets.set("token", "TOP-SECRET");
    expect(await platform.secrets.list()).toEqual(["token"]);
    expect(await platform.secrets.get("token")).toBe("TOP-SECRET");
    expect(atob(storage.data.get(PREVIEW_DB_KEY)!)).not.toContain("TOP-SECRET");
    await platform.secrets.delete("token");
    expect(await platform.secrets.get("token")).toBeUndefined();
    expect(await platform.plugins.scan()).toEqual([]);
    await expect(platform.files.importRead("x")).rejects.toMatchObject({ code: "not_implemented" });

    const clicked: string[] = [];
    const link = { href: "", download: "", click: () => clicked.push(link.download), remove: () => undefined };
    vi.stubGlobal("document", { createElement: () => link, body: { appendChild: () => undefined } });
    vi.stubGlobal("URL", { createObjectURL: () => "blob:x", revokeObjectURL: () => undefined });
    const folder = await platform.files.pickFolder("选择文件夹");
    expect(await platform.files.exportWrite(folder!, [{ name: "resources.json", content: "[]" }, { name: "manifest.json", content: "{}" }])).toBe(folder);
    expect(clicked).toEqual(["resources.json", "manifest.json"]);
  });

  it("系统能力：打开链接、复制、网络", async () => {
    const opened: unknown[] = [];
    vi.stubGlobal("open", (...args: unknown[]) => opened.push(args));
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const platform = await createBrowserPlatform({ storage: memoryStorage(), initSql: loadSqlJs, fetch: async () => response(200, "ok") });
    await platform.system.openExternal("https://example.com");
    await expect(platform.system.openExternal("javascript:alert(1)")).rejects.toMatchObject({ code: "validation" });
    expect(opened).toEqual([["https://example.com", "_blank", "noopener,noreferrer"]]);
    await platform.system.copyText("你好");
    expect(writeText).toHaveBeenCalledWith("你好");
    writeText.mockRejectedValueOnce(new Error("denied"));
    await expect(platform.system.copyText("x")).rejects.toMatchObject({ code: "unavailable" });
    expect(await platform.network.fetch("https://example.com")).toMatchObject({ status: 200, body: "ok" });
  });
});

describe("Tauri 平台", () => {
  it("按命令契约调用 Rust，参数名为 camelCase", async () => {
    const { createTauriPlatform } = await import("./tauri");
    const platform = createTauriPlatform();
    invoke.mockResolvedValueOnce([{ n: 1 }]);
    expect(await platform.db.select("SELECT 1 AS n")).toEqual([{ n: 1 }]);
    expect(invoke).toHaveBeenLastCalledWith("db_select", { sql: "SELECT 1 AS n", params: [] });
    invoke.mockResolvedValueOnce({ rowsAffected: 1 });
    expect(await platform.db.execute("DELETE FROM t WHERE id = ?", ["a"])).toEqual({ rowsAffected: 1 });
    expect(invoke).toHaveBeenLastCalledWith("db_execute", { sql: "DELETE FROM t WHERE id = ?", params: ["a"] });
    invoke.mockResolvedValueOnce([1, 0]);
    expect(await platform.db.batch([{ sql: "A", params: [1] }, { sql: "B" }])).toEqual([1, 0]);
    expect(invoke).toHaveBeenLastCalledWith("db_batch", { statements: [{ sql: "A", params: [1] }, { sql: "B", params: [] }] });

    invoke.mockResolvedValueOnce(["a"]).mockResolvedValueOnce(null).mockResolvedValueOnce("v").mockResolvedValue(null);
    expect(await platform.secrets.list()).toEqual(["a"]);
    expect(await platform.secrets.get("missing")).toBeUndefined();
    expect(await platform.secrets.get("a")).toBe("v");
    await platform.secrets.set("a", "v2");
    expect(invoke).toHaveBeenLastCalledWith("secrets_set", { name: "a", value: "v2" });
    await platform.secrets.delete("a");
    expect(invoke).toHaveBeenLastCalledWith("secrets_delete", { name: "a" });

    invoke.mockResolvedValueOnce({ schemaVersion: 1 }).mockResolvedValueOnce([]).mockResolvedValueOnce("/tmp/out").mockResolvedValueOnce({ resources: "[]", collections: "[]", manifest: "{}" });
    expect(await platform.app.status()).toEqual({ schemaVersion: 1 });
    expect(await platform.plugins.scan()).toEqual([]);
    expect(await platform.files.exportWrite("/tmp", [{ name: "a.json", content: "{}" }])).toBe("/tmp/out");
    expect(invoke).toHaveBeenLastCalledWith("export_write", { parentDir: "/tmp", files: [{ name: "a.json", content: "{}" }] });
    expect(await platform.files.importRead("/tmp/out")).toEqual({ resources: "[]", collections: "[]", manifest: "{}" });
    expect(invoke).toHaveBeenLastCalledWith("import_read", { dir: "/tmp/out" });
  });

  it("Rust 返回的中文错误转为 OneDeskError", async () => {
    const { createTauriPlatform } = await import("./tauri");
    const platform = createTauriPlatform();
    invoke.mockRejectedValueOnce("数据库被锁定");
    await expect(platform.db.select("x")).rejects.toMatchObject({ name: "OneDeskError", code: "internal", message: "数据库被锁定" });
    invoke.mockRejectedValueOnce(undefined);
    await expect(platform.db.execute("x")).rejects.toMatchObject({ message: "写入数据库失败" });
  });

  it("系统能力经 Tauri 插件：打开链接、复制、选择文件夹、网络", async () => {
    const { createTauriPlatform } = await import("./tauri");
    const platform = createTauriPlatform();
    await platform.system.openExternal("mailto:a@example.com");
    expect(plugins.openUrl).toHaveBeenCalledWith("mailto:a@example.com");
    await expect(platform.system.openExternal("file:///etc/passwd")).rejects.toMatchObject({ code: "validation" });
    expect(plugins.openUrl).toHaveBeenCalledTimes(1);
    plugins.openUrl.mockRejectedValueOnce("没有默认浏览器");
    await expect(platform.system.openExternal("https://example.com")).rejects.toMatchObject({ message: "没有默认浏览器" });

    await platform.system.copyText("x");
    expect(plugins.writeText).toHaveBeenCalledWith("x");
    plugins.writeText.mockRejectedValueOnce(new Error("denied"));
    await expect(platform.system.copyText("x")).rejects.toMatchObject({ code: "internal", message: "denied" });

    plugins.open.mockResolvedValueOnce("/Users/me/Desktop").mockResolvedValueOnce(null).mockRejectedValueOnce("x");
    expect(await platform.files.pickFolder("选择导出位置")).toBe("/Users/me/Desktop");
    expect(plugins.open).toHaveBeenLastCalledWith({ directory: true, multiple: false, title: "选择导出位置" });
    expect(await platform.files.pickFolder("x")).toBeNull();
    await expect(platform.files.pickFolder("x")).rejects.toMatchObject({ code: "internal" });

    plugins.fetch.mockResolvedValueOnce(response(200, "ok", [["X-A", "1"]]));
    expect(await platform.network.fetch("https://example.com", { method: "PUT" })).toMatchObject({ status: 200, body: "ok", headers: { "x-a": "1" } });
    expect(plugins.fetch).toHaveBeenCalledWith("https://example.com", expect.objectContaining({ method: "PUT" }));
  });
});

describe("不自动跟随重定向（D13）", () => {
  it("共用实现：manual 时把 redirect 传给 fetch，3xx 原样返回（带 location）", async () => {
    const seen: unknown[] = [];
    const fetchImpl: FetchLike = async (_url, init) => {
      seen.push(init?.redirect);
      return response(302, "", [["Location", "https://evil.com/"]]);
    };
    expect(await performFetch(fetchImpl, "https://example.com", { redirect: "manual" })).toMatchObject({ status: 302, headers: { location: "https://evil.com/" } });
    await performFetch(fetchImpl, "https://example.com", { redirect: "follow" });
    await performFetch(fetchImpl, "https://example.com");
    expect(seen).toEqual(["manual", undefined, undefined]);
  });

  it("浏览器：manual 遇到重定向只能拿到不透明响应，直接拒绝", async () => {
    const opaque: FetchLike = async () => ({ ...response(0, ""), type: "opaqueredirect" });
    await expect(performFetch(opaque, "https://example.com", { redirect: "manual" })).rejects.toMatchObject({ code: "permission", message: expect.stringContaining("重定向") });
    const platform = await createBrowserPlatform({ storage: memoryStorage(), initSql: loadSqlJs, fetch: opaque });
    await expect(platform.network.fetch("https://example.com", { redirect: "manual" } as never)).rejects.toMatchObject({ code: "permission" });
  });

  it("Tauri：manual 转成 maxRedirections 0，不把 redirect 传给 Rust 客户端；否则不限制", async () => {
    const { createTauriPlatform } = await import("./tauri");
    const platform = createTauriPlatform();
    plugins.fetch.mockResolvedValue(response(302, "", [["location", "/next"]]));
    expect(await platform.network.fetch("https://example.com", { redirect: "manual" } as never)).toMatchObject({ status: 302, headers: { location: "/next" } });
    const manualInit = plugins.fetch.mock.calls.at(-1)?.[1] as Record<string, unknown>;
    expect(manualInit.maxRedirections).toBe(0);
    expect("redirect" in manualInit).toBe(false);
    await platform.network.fetch("https://example.com");
    const followInit = plugins.fetch.mock.calls.at(-1)?.[1] as Record<string, unknown>;
    expect("maxRedirections" in followInit).toBe(false);
    plugins.fetch.mockReset();
  });
});
