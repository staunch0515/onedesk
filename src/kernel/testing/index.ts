/**
 * Test support for the kernel, plugins and the shell: a real kernel on an in-memory SQLite (sql.js) with a mock
 * platform. Nothing here touches the user's data: only in-memory databases are accepted (D26).
 */
import initSqlJs from "sql.js";
import type { Database, SqlJsStatic } from "sql.js";
import { OneDeskError } from "../../plugin-api";
import type { ManifestInput, NetworkRequestInit, NetworkResponse, PluginModule } from "../../plugin-api";
import type { Kernel, Platform, PluginSource } from "../contracts";
import { createKernel } from "../index";
import { bundledMigrations, createSqlJsDriver, runMigrations } from "./sqljs";

export { bundledMigrations, createSqlJsDriver, parseMigrations, runMigrations, schemaVersion } from "./sqljs";
export type { Migration } from "./sqljs";

export const MEMORY_DB = ":memory:";

let sqlJs: Promise<SqlJsStatic> | undefined;
/** sql.js for Node (vitest); the wasm file is found next to the package. */
export function loadSqlJs(): Promise<SqlJsStatic> {
  sqlJs ??= initSqlJs();
  return sqlJs;
}

/** D26: tests may only open the in-memory database, never a file (least of all the real onedesk.db). */
export function assertMemoryDb(path: string): void {
  if (path !== MEMORY_DB) {
    throw new OneDeskError("permission", `测试只能使用内存数据库（${MEMORY_DB}），拒绝打开：${path}`);
  }
}

/** A fresh in-memory database with all bundled migrations applied. */
export async function createTestDatabase(path: string = MEMORY_DB): Promise<Database> {
  assertMemoryDb(path);
  const SQL = await loadSqlJs();
  const db = new SQL.Database();
  runMigrations(db);
  return db;
}

/** Wraps a manifest + module the way the shell wraps built-in and external plugins. */
export function pluginSource(
  manifest: ManifestInput | unknown,
  module: PluginModule | (() => PluginModule | Promise<PluginModule>),
  options: { origin?: PluginSource["origin"]; location?: string; error?: string } = {},
): PluginSource {
  const id = typeof manifest === "object" && manifest !== null && "id" in manifest ? String(manifest.id) : "unknown";
  const source: PluginSource = {
    origin: options.origin ?? "builtin",
    location: options.location ?? `test:${id}`,
    manifest,
    load: async () => (typeof module === "function" ? module() : module),
  };
  if (options.error !== undefined) source.error = options.error;
  return source;
}

export interface TestKernelOptions {
  /** Only ":memory:" is accepted. */
  dbPath?: string;
  /** Network stub; default rejects every request with OneDeskError("unavailable"). */
  fetch?: (url: string, init?: NetworkRequestInit) => Promise<NetworkResponse>;
  /** Clock; default is real time made strictly increasing (so updatedAt ordering is deterministic). */
  now?: () => Date;
  randomId?: () => string;
  /** Initial secrets (name → value). */
  secrets?: Record<string, string>;
  context?: Kernel["context"];
  /** Loaded with `kernel.plugins.load` before returning. */
  plugins?: PluginSource[];
}

export interface TestKernel {
  kernel: Kernel;
  platform: Platform;
  db: Database;
  /** URLs passed to system.openExternal, in order. */
  opened: string[];
  /** Texts passed to system.copyText, in order. */
  copied: string[];
  /** Requests that reached platform.network.fetch. */
  requests: Array<{ url: string; init?: NetworkRequestInit }>;
  secrets: Map<string, string>;
  close(): void;
}

function monotonicClock(): () => Date {
  let last = 0;
  return () => {
    last = Math.max(Date.now(), last + 1);
    return new Date(last);
  };
}

export async function createTestKernel(options: TestKernelOptions = {}): Promise<TestKernel> {
  const db = await createTestDatabase(options.dbPath ?? MEMORY_DB);
  const opened: string[] = [];
  const copied: string[] = [];
  const requests: TestKernel["requests"] = [];
  const secrets = new Map<string, string>(Object.entries(options.secrets ?? {}));
  const now = options.now ?? monotonicClock();
  let counter = 0;
  const randomId = options.randomId ?? (() => `id-${String(++counter).padStart(6, "0")}`);
  const latest = bundledMigrations().at(-1)?.version ?? 0;

  const platform: Platform = {
    db: createSqlJsDriver(db),
    system: {
      async openExternal(url) {
        opened.push(url);
      },
      async copyText(text) {
        copied.push(text);
      },
    },
    network: {
      async fetch(url, init) {
        requests.push(init === undefined ? { url } : { url, init });
        if (!options.fetch) throw new OneDeskError("unavailable", "测试中没有提供网络");
        return options.fetch(url, init);
      },
    },
    secrets: {
      async list() {
        return [...secrets.keys()].sort();
      },
      async get(name) {
        return secrets.get(name);
      },
      async set(name, value) {
        secrets.set(name, value);
      },
      async delete(name) {
        secrets.delete(name);
      },
    },
    app: {
      async status() {
        return { dataDir: MEMORY_DB, dbPath: MEMORY_DB, schemaVersion: latest, latestSchemaVersion: latest, migrationError: null, backups: [] };
      },
    },
    plugins: {
      async scan() {
        return [];
      },
    },
    files: {
      async pickFolder() {
        return null;
      },
      async exportWrite() {
        throw new OneDeskError("not_implemented", "测试平台不写文件");
      },
      async importRead() {
        throw new OneDeskError("not_implemented", "测试平台不读文件");
      },
    },
    now,
    randomId,
  };

  const kernelOptions: Parameters<typeof createKernel>[0] = { platform };
  if (options.context) kernelOptions.context = options.context;
  const kernel = await createKernel(kernelOptions);
  if (options.plugins) await kernel.plugins.load(options.plugins);
  return { kernel, platform, db, opened, copied, requests, secrets, close: () => db.close() };
}
