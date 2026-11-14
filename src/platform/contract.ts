/**
 * Tauri command contract between the front end (src/platform/tauri.ts) and Rust (src-tauri/src).
 * Frozen for milestone 1. Argument names are camelCase on the JS side (Tauri converts to snake_case).
 * Every command rejects with a Chinese, user-facing string.
 *
 * Tauri plugins used directly from the front end (permissions in src-tauri/capabilities/default.json, owned by the
 * Rust session): opener:allow-open-url (http/https/mailto), clipboard-manager:allow-write-text, dialog:allow-open,
 * http:default scoped to http://* and https://*.
 *
 * Rust-side facts: data dir = dirs::data_dir()/onedesk; DB = onedesk.db; backups/ keeps 7 snapshots (VACUUM INTO
 * before migrating); migrations from src-tauri/migrations embedded with include_str!, run in one transaction each;
 * version table `schema_version(version INTEGER NOT NULL)` with exactly one row. Secret names indexed in table
 * `secret_names` (values only in Keychain, service "onedesk", account = name). plugins_scan rejects a manifest.main
 * that escapes the plugin folder.
 */
import type { AppStatus, ScannedPlugin, SqlParam } from "../kernel/contracts";
export type { AppStatus, ScannedPlugin };

export interface Commands {
  app_status: { args: Record<string, never>; result: AppStatus };
  db_select: { args: { sql: string; params: SqlParam[] }; result: Record<string, unknown>[] };
  db_execute: { args: { sql: string; params: SqlParam[] }; result: { rowsAffected: number } };
  /** Single transaction; rollback on failure. */
  db_batch: { args: { statements: Array<{ sql: string; params: SqlParam[] }> }; result: number[] };
  /** Names only (index kept by Rust; values only in the Keychain). */
  secrets_list: { args: Record<string, never>; result: string[] };
  secrets_get: { args: { name: string }; result: string | null };
  secrets_set: { args: { name: string; value: string }; result: null };
  secrets_delete: { args: { name: string }; result: null };
  /** Scan <dataDir>/plugins/<dir>/manifest.json. */
  plugins_scan: { args: Record<string, never>; result: ScannedPlugin[] };
  /**
   * Create `<parentDir>/onedesk-export-YYYYMMDD-HHMMSS/` with the given files
   * (resources.json, collections.json, plugins.json, manifest.json) and an empty `attachments/` folder.
   * Returns the created folder path.
   */
  export_write: { args: { parentDir: string; files: Array<{ name: string; content: string }> }; result: string };
  /** Read resources.json, collections.json, manifest.json from an export folder. Missing file → error. */
  import_read: { args: { dir: string }; result: { resources: string; collections: string; manifest: string } };
}
