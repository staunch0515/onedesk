/**
 * Platform for the browser preview mode (D40): the same front end on sql.js, used for UI tests and screenshots.
 *
 * TEMPORARY MEASURE T01 (docs/decisions.md): the database is persisted to localStorage as base64. Development and
 * UI tests only — no secrets are stored (secrets live in memory and vanish on reload). To be re-evaluated before
 * the end of milestone 2.
 *
 * Not available here: external plugins (scan returns nothing), reading an export folder (import), snapshots.
 * Export downloads the files through the browser instead of writing a folder.
 */
import initSqlJs from "sql.js";
import type { Database, SqlJsStatic } from "sql.js";
import wasmUrl from "sql.js/dist/sql-wasm-browser.wasm?url";
import type { AppStatus, Platform } from "../kernel/contracts";
import { bundledMigrations, createSqlJsDriver, runMigrations, schemaVersion } from "../kernel/sqljs";
import { OneDeskError } from "../plugin-api";
import { assertSafeExternalUrl, performFetch } from "./http";
import type { FetchLike } from "./http";

export const PREVIEW_DB_KEY = "onedesk.preview.db";
const DOWNLOADS = "浏览器下载文件夹";

export interface BrowserPlatformOptions {
  /** Where the database is kept between reloads; default window.localStorage. */
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  storageKey?: string;
  /** How to load sql.js; default loads the wasm bundled by Vite. Tests pass the Node loader. */
  initSql?: () => Promise<SqlJsStatic>;
  fetch?: FetchLike;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function download(name: string, content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export async function createBrowserPlatform(options: BrowserPlatformOptions = {}): Promise<Platform> {
  const storage = options.storage ?? globalThis.localStorage;
  const storageKey = options.storageKey ?? PREVIEW_DB_KEY;
  const SQL = await (options.initSql ?? (() => initSqlJs({ locateFile: () => wasmUrl })))();
  const latest = bundledMigrations().at(-1)?.version ?? 0;

  // Open the saved database, or a new one. A failed migration (or unreadable data) is reported through
  // app.status().migrationError so the shell blocks usage (D21); the saved data is then left untouched.
  let db: Database;
  let migrationError: string | null = null;
  const saved = storage.getItem(storageKey);
  try {
    db = saved ? new SQL.Database(fromBase64(saved)) : new SQL.Database();
    runMigrations(db);
  } catch (e) {
    migrationError = e instanceof Error ? e.message : String(e);
    db = new SQL.Database();
  }
  let currentVersion = 0;
  try {
    currentVersion = schemaVersion(db);
  } catch {
    currentVersion = 0;
  }

  const persist = (): void => {
    if (migrationError) return;
    try {
      storage.setItem(storageKey, toBase64(db.export()));
    } catch (e) {
      // Quota exceeded: keep working in memory; the preview is not a place for real data.
      console.warn("浏览器预览：数据库没有保存到 localStorage", e);
    }
  };
  if (!saved) persist();

  const secrets = new Map<string, string>();
  const fetchImpl: FetchLike = options.fetch ?? ((input, init) => globalThis.fetch(input, init));

  return {
    db: createSqlJsDriver(db, persist),
    system: {
      async openExternal(url) {
        assertSafeExternalUrl(url);
        globalThis.open(url, "_blank", "noopener,noreferrer");
      },
      async copyText(text) {
        try {
          await globalThis.navigator.clipboard.writeText(text);
        } catch (e) {
          throw new OneDeskError("unavailable", "无法写入剪贴板", { hint: "浏览器需要页面处于焦点并允许剪贴板权限", cause: e });
        }
      },
    },
    network: {
      // Subject to the browser's CORS rules, unlike the desktop app.
      fetch: (url, init) => performFetch(fetchImpl, url, init),
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
      async status(): Promise<AppStatus> {
        return {
          dataDir: "（浏览器预览）",
          dbPath: `localStorage:${storageKey}`,
          schemaVersion: currentVersion,
          latestSchemaVersion: latest,
          migrationError,
          backups: [],
        };
      },
    },
    plugins: {
      async scan() {
        return [];
      },
    },
    files: {
      async pickFolder() {
        return DOWNLOADS;
      },
      async exportWrite(_parentDir, files) {
        for (const file of files) download(file.name, file.content);
        return DOWNLOADS;
      },
      async importRead() {
        throw new OneDeskError("not_implemented", "浏览器预览模式不支持导入", { hint: "请在桌面应用中导入" });
      },
    },
  };
}
