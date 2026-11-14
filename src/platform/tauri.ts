/**
 * Platform for the real desktop app: Rust commands (see ./contract.ts) plus the Tauri plugins for the system
 * browser, clipboard, HTTP (no CORS) and the folder picker. Only the shell's composition root imports this.
 */
import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { open } from "@tauri-apps/plugin-dialog";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Platform } from "../kernel/contracts";
import { OneDeskError } from "../plugin-api";
import type { Commands } from "./contract";
import { assertSafeExternalUrl, performFetch } from "./http";
import type { FetchLike } from "./http";

/** Rust commands reject with a Chinese, user-facing string. */
function toError(e: unknown, fallback: string): OneDeskError {
  const message = typeof e === "string" && e ? e : e instanceof Error && e.message ? e.message : fallback;
  return new OneDeskError("internal", message, { cause: e });
}

async function call<K extends keyof Commands>(command: K, args: Commands[K]["args"], fallback: string): Promise<Commands[K]["result"]> {
  try {
    return await invoke<Commands[K]["result"]>(command, args);
  } catch (e) {
    throw toError(e, fallback);
  }
}

export function createTauriPlatform(): Platform {
  return {
    db: {
      select: <T = Record<string, unknown>>(sql: string, params: Array<string | number | null> = []) =>
        call("db_select", { sql, params }, "读取数据库失败") as Promise<T[]>,
      execute: (sql, params = []) => call("db_execute", { sql, params }, "写入数据库失败"),
      batch: (statements) => call("db_batch", { statements: statements.map((s) => ({ sql: s.sql, params: s.params ?? [] })) }, "写入数据库失败"),
    },
    system: {
      async openExternal(url) {
        assertSafeExternalUrl(url);
        try {
          await openUrl(url);
        } catch (e) {
          throw toError(e, "无法打开链接");
        }
      },
      async copyText(text) {
        try {
          await writeText(text);
        } catch (e) {
          throw toError(e, "无法写入剪贴板");
        }
      },
    },
    network: {
      fetch: (url, init) => performFetch(tauriFetch as unknown as FetchLike, url, init),
    },
    secrets: {
      list: () => call("secrets_list", {}, "读取密钥列表失败"),
      get: async (name) => (await call("secrets_get", { name }, "读取密钥失败")) ?? undefined,
      set: async (name, value) => {
        await call("secrets_set", { name, value }, "保存密钥失败");
      },
      delete: async (name) => {
        await call("secrets_delete", { name }, "删除密钥失败");
      },
    },
    app: {
      status: () => call("app_status", {}, "读取应用状态失败"),
    },
    plugins: {
      scan: () => call("plugins_scan", {}, "扫描插件文件夹失败"),
    },
    files: {
      async pickFolder(title) {
        try {
          const picked = await open({ directory: true, multiple: false, title });
          return typeof picked === "string" ? picked : null;
        } catch (e) {
          throw toError(e, "无法打开文件夹选择框");
        }
      },
      exportWrite: (parentDir, files) => call("export_write", { parentDir, files }, "导出失败"),
      importRead: (dir) => call("import_read", { dir }, "读取导出文件夹失败"),
    },
  };
}
