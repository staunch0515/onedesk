import { describe, expect, it } from "vitest";
import { MEMORY_DB, assertMemoryDb, createTestDatabase, createTestKernel, loadSqlJs } from "../testing";
import { bundledMigrations, createSqlJsDriver, parseMigrations, runMigrations, schemaVersion } from "./index";
import type { Migration } from "./index";

async function emptyDb() {
  const SQL = await loadSqlJs();
  return new SQL.Database();
}
const tables = (db: Awaited<ReturnType<typeof emptyDb>>) =>
  (db.exec("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")[0]?.values ?? []).map((row) => row[0]);

describe("迁移执行器", () => {
  it("读取 src-tauri/migrations 中的同一批 SQL，按编号排序", () => {
    const migrations = bundledMigrations();
    expect(migrations[0]).toMatchObject({ version: 1, name: "init" });
    expect(migrations[0]?.sql).toContain("CREATE TABLE resources");
    expect(migrations.map((m) => m.version)).toEqual([...migrations.map((m) => m.version)].sort((a, b) => a - b));
  });

  it("新库：建表并记录版本；再次运行不重复执行", async () => {
    const db = await emptyDb();
    const latest = bundledMigrations().at(-1)!.version;
    expect(runMigrations(db)).toEqual({ from: 0, to: latest });
    expect(tables(db)).toEqual(["app_settings", "collections", "plugin_storage", "plugins", "resources", "schema_version", "secret_names"]);
    expect(db.exec("SELECT version FROM schema_version")[0]?.values).toEqual([[latest]]);
    expect(runMigrations(db)).toEqual({ from: latest, to: latest });
    expect(db.exec("SELECT COUNT(*) FROM schema_version")[0]?.values).toEqual([[1]]);
  });

  it("从上一版本升级：旧数据保留", async () => {
    const db = await emptyDb();
    runMigrations(db);
    const base = schemaVersion(db);
    db.run("INSERT INTO app_settings (key, value) VALUES ('theme', '\"dark\"')");
    const next: Migration = { version: base + 1, name: "add_note", sql: "ALTER TABLE app_settings ADD COLUMN note TEXT NOT NULL DEFAULT ''; CREATE TABLE extra (id TEXT PRIMARY KEY);" };
    expect(runMigrations(db, [...bundledMigrations(), next])).toEqual({ from: base, to: base + 1 });
    expect(db.exec("SELECT key, value, note FROM app_settings")[0]?.values).toEqual([["theme", '"dark"', ""]]);
    expect(tables(db)).toContain("extra");
  });

  it("失败回滚：停在上一个成功的版本，半截改动不留下，错误信息说明原因", async () => {
    const db = await emptyDb();
    runMigrations(db);
    const base = schemaVersion(db);
    db.run("INSERT INTO app_settings (key, value) VALUES ('theme', '\"dark\"')");
    const good: Migration = { version: base + 1, name: "good", sql: "CREATE TABLE good (id TEXT PRIMARY KEY);" };
    const bad: Migration = {
      version: base + 2,
      name: "bad",
      sql: "CREATE TABLE half (id TEXT PRIMARY KEY); DELETE FROM app_settings; INSERT INTO missing_table VALUES (1);",
    };
    const never: Migration = { version: base + 3, name: "never", sql: "CREATE TABLE never (id TEXT PRIMARY KEY);" };
    expect(() => runMigrations(db, [...bundledMigrations(), good, bad, never])).toThrow(/数据库迁移 \d{4}_bad 失败，已回滚：.*missing_table/);
    expect(schemaVersion(db)).toBe(base + 1);
    expect(tables(db)).toContain("good");
    expect(tables(db)).not.toContain("half");
    expect(tables(db)).not.toContain("never");
    expect(db.exec("SELECT COUNT(*) FROM app_settings")[0]?.values).toEqual([[1]]);
    // 修好之后可以继续升级。
    expect(runMigrations(db, [...bundledMigrations(), good, { ...bad, sql: "CREATE TABLE half (id TEXT PRIMARY KEY);" }, never])).toEqual({ from: base + 1, to: base + 3 });
  });

  it("文件名不合规或编号重复时拒绝", () => {
    expect(() => parseMigrations({ "/m/init.sql": "" })).toThrow(/NNNN_name\.sql/);
    expect(() => parseMigrations({ "/m/0001_a.sql": "", "/m/0001_b.sql": "" })).toThrow(/编号重复/);
    expect(parseMigrations({ "/m/0002_b.sql": "b", "/m/0001_a.sql": "a" }).map((m) => m.name)).toEqual(["a", "b"]);
  });
});

describe("sql.js 驱动", () => {
  it("select / execute：整数按 INTEGER 绑定，返回影响行数；写入后通知", async () => {
    const db = await createTestDatabase();
    let writes = 0;
    const driver = createSqlJsDriver(db, () => writes++);
    expect(await driver.execute("INSERT INTO app_settings (key, value) VALUES (?, ?), (?, ?)", ["a", "1", "b", "2"])).toEqual({ rowsAffected: 2 });
    expect(await driver.select("SELECT key, value FROM app_settings ORDER BY key")).toEqual([{ key: "a", value: "1" }, { key: "b", value: "2" }]);
    expect(await driver.select("SELECT typeof(?) AS i, typeof(?) AS r, typeof(?) AS n, typeof(?) AS s", [1, 1.5, null, "x"])).toEqual([{ i: "integer", r: "real", n: "null", s: "text" }]);
    expect(await driver.execute("DELETE FROM app_settings WHERE key = ?", ["zzz"])).toEqual({ rowsAffected: 0 });
    expect(writes).toBe(2);
  });

  it("batch：一个事务，失败全部回滚", async () => {
    const db = await createTestDatabase();
    let writes = 0;
    const driver = createSqlJsDriver(db, () => writes++);
    expect(await driver.batch([{ sql: "INSERT INTO app_settings (key, value) VALUES ('a', '1')" }, { sql: "UPDATE app_settings SET value = ? WHERE key = ?", params: ["2", "a"] }])).toEqual([1, 1]);
    await expect(
      driver.batch([{ sql: "DELETE FROM app_settings" }, { sql: "INSERT INTO app_settings (key, value) VALUES ('b', '1')" }, { sql: "INSERT INTO nope VALUES (1)" }]),
    ).rejects.toMatchObject({ code: "internal", message: expect.stringContaining("数据库操作失败") });
    expect(await driver.select("SELECT key, value FROM app_settings")).toEqual([{ key: "a", value: "2" }]);
    expect(writes).toBe(1);
    // 回滚后驱动仍然可用。
    expect(await driver.batch([])).toEqual([]);
  });

  it("SQL 错误转为带中文信息的 OneDeskError", async () => {
    const driver = createSqlJsDriver(await createTestDatabase());
    await expect(driver.select("SELECT * FROM nope")).rejects.toMatchObject({ name: "OneDeskError", code: "internal" });
    await expect(driver.execute("INSERT INTO nope VALUES (1)")).rejects.toMatchObject({ name: "OneDeskError", code: "internal" });
  });
});

describe("测试内核", () => {
  it("拒绝打开非内存库（D26）", async () => {
    expect(() => assertMemoryDb(MEMORY_DB)).not.toThrow();
    for (const path of ["/Users/me/Library/Application Support/onedesk/onedesk.db", "onedesk.db", "./test.db", ""]) {
      expect(() => assertMemoryDb(path)).toThrow(/拒绝打开/);
      await expect(createTestKernel({ dbPath: path })).rejects.toMatchObject({ code: "permission" });
    }
  });

  it("可注入时钟、id、上下文；模拟平台的其余部分", async () => {
    let n = 0;
    const t = await createTestKernel({
      now: () => new Date("2026-01-02T03:04:05.000Z"),
      randomId: () => `fixed-${++n}`,
      context: { workspace: { id: "w", name: "W" }, user: { id: "u", name: "U" } },
    });
    const c = await t.kernel.collections.create({ name: "x", rule: { type: "kind", value: "x" } });
    expect(c).toMatchObject({ id: "fixed-1", createdAt: "2026-01-02T03:04:05.000Z" });
    expect(t.kernel.context.user.name).toBe("U");
    expect(await t.platform.app.status()).toMatchObject({ dbPath: MEMORY_DB, migrationError: null });
    expect(await t.platform.plugins.scan()).toEqual([]);
    expect(await t.platform.files.pickFolder("x")).toBeNull();
    await expect(t.platform.files.exportWrite("x", [])).rejects.toMatchObject({ code: "not_implemented" });
    await expect(t.platform.files.importRead("x")).rejects.toMatchObject({ code: "not_implemented" });
    t.close();
  });

  it("没有注入时使用系统时钟和随机 id", async () => {
    const t = await createTestKernel();
    const { createKernel } = await import("../index");
    const kernel = await createKernel({ platform: { ...t.platform, now: undefined, randomId: undefined } as never });
    const c = await kernel.collections.create({ name: "x", rule: { type: "kind", value: "x" } });
    expect(c.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(Math.abs(Date.parse(c.createdAt) - Date.now())).toBeLessThan(5000);
  });
});
