/**
 * Tauri command contract between the front end (src/platform/tauri.ts) and Rust (src-tauri/src).
 * Frozen for milestone 1. Argument names are camelCase on the JS side (Tauri converts to snake_case).
 */
import type { SqlParam } from "../kernel/contracts";

export interface AppStatus {
  /** Absolute data dir, e.g. /Users/me/Library/Application Support/onedesk */
  dataDir: string;
  dbPath: string;
  schemaVersion: number;
  /** Latest migration available in this build. */
  latestSchemaVersion: number;
  /** Set when a migration failed and was rolled back; the UI must block usage (D21). */
  migrationError: string | null;
  /** Snapshot file names in backups/, newest first. */
  backups: string[];
}

export interface ScannedPlugin {
  /** Absolute folder path. */
  dir: string;
  /** Raw manifest.json text, or null if missing/unreadable. */
  manifestText: string | null;
  /** Entry module source (manifest.main, default index.js), or null if missing. */
  entrySource: string | null;
  /** File-system level problem (missing manifest, unreadable entry…), Chinese. */
  error: string | null;
}

export interface Commands {
  app_status: { args: Record<string, never>; result: AppStatus };
  db_select: { args: { sql: string; params: SqlParam[] }; result: Record<string, unknown>[] };
  db_execute: { args: { sql: string; params: SqlParam[] }; result: { rowsAffected: number } };
  /** Single transaction; rollback on failure. */
  db_batch: { args: { statements: Array<{ sql: string; params: SqlParam[] }> }; result: null };
  /** Names only (index kept by Rust; values only in the Keychain). */
  secrets_list: { args: Record<string, never>; result: string[] };
  secrets_get: { args: { name: string }; result: string | null };
  secrets_set: { args: { name: string; value: string }; result: null };
  secrets_delete: { args: { name: string }; result: null };
  /** Scan <dataDir>/plugins/<dir>/manifest.json. */
  plugins_scan: { args: Record<string, never>; result: ScannedPlugin[] };
  /**
   * Create `<parentDir>/onedesk-export-YYYYMMDD-HHMMSS/` with the given files
   * (resources.json, collections.json, manifest.json) and an empty `attachments/` folder.
   * Returns the created folder path.
   */
  export_write: { args: { parentDir: string; files: Array<{ name: string; content: string }> }; result: string };
  /** Read resources.json, collections.json, manifest.json from an export folder. Missing file → error. */
  import_read: { args: { dir: string }; result: { resources: string; collections: string; manifest: string } };
}
