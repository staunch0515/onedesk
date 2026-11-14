/**
 * sql.js (SQLite compiled to WebAssembly) behind the kernel's SqlDriver, plus the TypeScript migration runner.
 * Shared by tests (`createTestKernel`) and the browser preview platform, so both run the very same SQL files as
 * the Rust side (src-tauri/migrations). The caller creates the sql.js Database (loading the wasm differs between
 * Node and the browser).
 */
import type { Database } from "sql.js";
import { OneDeskError } from "../../plugin-api";
import type { SqlDriver, SqlParam } from "../contracts";

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

const bundled = import.meta.glob("/src-tauri/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

/** Turns `{ "<path>/0001_init.sql": "<sql>" }` into ordered migrations; rejects bad names and duplicate numbers. */
export function parseMigrations(files: Record<string, string>): Migration[] {
  const migrations: Migration[] = [];
  for (const [path, sql] of Object.entries(files)) {
    const file = path.split("/").pop() ?? path;
    const match = /^(\d{4})_([A-Za-z0-9_-]+)\.sql$/.exec(file);
    if (!match) throw new OneDeskError("internal", `迁移文件名不符合 NNNN_name.sql：${file}`);
    const version = Number(match[1]);
    if (migrations.some((m) => m.version === version)) throw new OneDeskError("internal", `迁移编号重复：${match[1]}`);
    migrations.push({ version, name: match[2]!, sql });
  }
  return migrations.sort((a, b) => a.version - b.version);
}

/** The migrations shipped in src-tauri/migrations, in order. */
export function bundledMigrations(): Migration[] {
  return parseMigrations(bundled);
}

export function schemaVersion(db: Database): number {
  db.run("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
  const result = db.exec("SELECT version FROM schema_version LIMIT 1");
  const value = result[0]?.values[0]?.[0];
  if (typeof value === "number") return value;
  db.run("INSERT INTO schema_version (version) VALUES (0)");
  return 0;
}

/**
 * Applies every migration newer than the stored version, each in its own transaction together with the
 * schema_version update. On failure the transaction is rolled back and the error is thrown: the database stays
 * exactly at the last good version (D21).
 */
export function runMigrations(db: Database, migrations: Migration[] = bundledMigrations()): { from: number; to: number } {
  const from = schemaVersion(db);
  let current = from;
  for (const migration of migrations) {
    if (migration.version <= current) continue;
    db.run("BEGIN");
    try {
      db.exec(migration.sql);
      db.run("UPDATE schema_version SET version = ?", [migration.version]);
      db.run("COMMIT");
    } catch (e) {
      db.run("ROLLBACK");
      const label = `${String(migration.version).padStart(4, "0")}_${migration.name}`;
      throw new OneDeskError("internal", `数据库迁移 ${label} 失败，已回滚：${e instanceof Error ? e.message : String(e)}`, { cause: e });
    }
    current = migration.version;
  }
  return { from, to: current };
}

function dbError(e: unknown): OneDeskError {
  return new OneDeskError("internal", `数据库操作失败：${e instanceof Error ? e.message : String(e)}`, { cause: e });
}

/** `onWrite` runs after every successful write (the browser preview uses it to persist the database). */
export function createSqlJsDriver(db: Database, onWrite?: () => void): SqlDriver {
  const run = (sql: string, params: SqlParam[] = []): number => {
    db.run(sql, params);
    return db.getRowsModified();
  };
  return {
    async select<T = Record<string, unknown>>(sql: string, params: SqlParam[] = []): Promise<T[]> {
      try {
        const stmt = db.prepare(sql);
        try {
          stmt.bind(params);
          const rows: T[] = [];
          while (stmt.step()) rows.push(stmt.getAsObject() as T);
          return rows;
        } finally {
          stmt.free();
        }
      } catch (e) {
        throw dbError(e);
      }
    },
    async execute(sql, params) {
      try {
        const rowsAffected = run(sql, params);
        onWrite?.();
        return { rowsAffected };
      } catch (e) {
        throw dbError(e);
      }
    },
    async batch(statements) {
      const affected: number[] = [];
      try {
        db.run("BEGIN");
        try {
          for (const statement of statements) affected.push(run(statement.sql, statement.params));
          db.run("COMMIT");
        } catch (e) {
          db.run("ROLLBACK");
          throw e;
        }
      } catch (e) {
        throw dbError(e);
      }
      onWrite?.();
      return affected;
    },
  };
}
