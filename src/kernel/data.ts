/**
 * Export / import (D57). Export: resources, collections, plugins (state, settings, storage) — never secrets.
 * Import restores resources and collections only, keeping id, version, timestamps and origin; unknown kinds are
 * imported too. Same id = conflict, decided per item by the caller (overwrite or skip). One DB transaction.
 */
import { z } from "zod";
import { OneDeskError, ResourceSchema } from "../plugin-api";
import type { Collection, Resource } from "../plugin-api";
import { CollectionSchema, collectionInsert } from "./collections";
import type { CollectionStore } from "./collections";
import type { ExportBundle, ImportPlan, SqlDriver, SqlParam } from "./contracts";
import type { EventBus } from "./events";
import { resourceUpsert } from "./resources";
import type { ResourceStore } from "./resources";
import { errorMessage, isPlainObject, parseJson, zodMessage } from "./util";
import type { Runtime } from "./util";

const FORMAT_VERSION = 1;

const ImportManifestSchema = z.object({
  app: z.literal("onedesk", "不是 OneDesk 的导出文件"),
  formatVersion: z.literal(FORMAT_VERSION, "导出文件的格式版本不受支持"),
  schemaVersion: z.number().int(),
  exportedAt: z.string(),
});

/** Accepts file text (as read from disk) or already parsed JSON. */
function asJson(value: unknown, file: string): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new OneDeskError("validation", `${file} 不是合法的 JSON`);
  }
}

function parseFile<T>(schema: z.ZodType<T>, value: unknown, file: string): T {
  const result = schema.safeParse(asJson(value, file));
  if (!result.success) throw new OneDeskError("validation", `${file} 内容不正确：${zodMessage(result.error)}`);
  return result.data;
}

function assertUniqueIds(items: Array<{ id: string }>, file: string): void {
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) throw new OneDeskError("validation", `${file} 中有重复的 id：${item.id}`);
    seen.add(item.id);
  }
}

export class DataTransfer {
  constructor(
    private readonly db: SqlDriver,
    private readonly runtime: Runtime,
    private readonly events: EventBus,
    private readonly resources: ResourceStore,
    private readonly collections: CollectionStore,
  ) {}

  private async schemaVersion(): Promise<number> {
    try {
      const rows = await this.db.select<{ version: number }>("SELECT version FROM schema_version LIMIT 1");
      return rows[0]?.version ?? 0;
    } catch {
      return 0;
    }
  }

  async exportAll(): Promise<ExportBundle> {
    const resources = await this.resources.list({}, { includeDisabled: true });
    const collections = await this.collections.list();
    const pluginRows = await this.db.select<{ id: string; enabled: number; settings: string }>(
      "SELECT id, enabled, settings FROM plugins WHERE uninstalled = 0 ORDER BY id",
    );
    const storageRows = await this.db.select<{ plugin_id: string; key: string; value: string }>(
      "SELECT plugin_id, key, value FROM plugin_storage ORDER BY plugin_id, key",
    );
    const plugins = pluginRows.map((row) => {
      const settings = parseJson<unknown>(row.settings, {});
      const storage: Record<string, unknown> = {};
      for (const s of storageRows) if (s.plugin_id === row.id) storage[s.key] = parseJson<unknown>(s.value, null);
      return { id: row.id, enabled: row.enabled === 1, settings: isPlainObject(settings) ? settings : {}, storage };
    });
    return {
      manifest: {
        app: "onedesk",
        formatVersion: FORMAT_VERSION,
        schemaVersion: await this.schemaVersion(),
        exportedAt: this.runtime.now().toISOString(),
        counts: { resources: resources.length, collections: collections.length },
      },
      resources,
      collections,
      plugins,
    };
  }

  async planImport(files: { resources: unknown; collections: unknown; manifest: unknown }): Promise<ImportPlan> {
    parseFile(ImportManifestSchema, files.manifest, "manifest.json");
    const resources: Resource[] = parseFile(z.array(ResourceSchema), files.resources, "resources.json");
    const collections: Collection[] = parseFile(z.array(CollectionSchema), files.collections, "collections.json");
    assertUniqueIds(resources, "resources.json");
    assertUniqueIds(collections, "collections.json");

    const plan: ImportPlan = { newResources: [], conflicts: [], newCollections: [], collectionConflicts: [] };
    const existingResources = new Map((await this.resources.list({}, { includeDisabled: true })).map((r) => [r.id, r]));
    for (const incoming of resources) {
      const existing = existingResources.get(incoming.id);
      if (existing) plan.conflicts.push({ incoming, existing });
      else plan.newResources.push(incoming);
    }
    const existingCollections = new Map((await this.collections.list()).map((c) => [c.id, c]));
    for (const incoming of collections) {
      const existing = existingCollections.get(incoming.id);
      if (existing) plan.collectionConflicts.push({ incoming, existing });
      else plan.newCollections.push(incoming);
    }
    return plan;
  }

  async applyImport(
    plan: ImportPlan,
    decide: (conflict: { type: "resource" | "collection"; id: string }) => "overwrite" | "skip",
  ): Promise<{ created: number; overwritten: number; skipped: number }> {
    const statements: Array<{ sql: string; params: SqlParam[] }> = [];
    const created: Resource[] = [];
    const updated: Resource[] = [];
    const changedCollections: string[] = [];
    let overwritten = 0;
    let skipped = 0;

    for (const resource of plan.newResources) {
      // Plain INSERT: if the id appeared since planning, the whole import fails instead of silently overwriting.
      const stmt = resourceUpsert(resource);
      statements.push({ sql: stmt.sql.replace("INSERT OR REPLACE", "INSERT"), params: stmt.params });
      created.push(resource);
    }
    for (const { incoming } of plan.conflicts) {
      if (decide({ type: "resource", id: incoming.id }) === "overwrite") {
        statements.push(resourceUpsert(incoming));
        updated.push(incoming);
        overwritten += 1;
      } else skipped += 1;
    }
    for (const collection of plan.newCollections) {
      const stmt = collectionInsert(collection);
      statements.push({ sql: stmt.sql.replace("INSERT OR REPLACE", "INSERT"), params: stmt.params });
      changedCollections.push(collection.id);
    }
    for (const { incoming } of plan.collectionConflicts) {
      if (decide({ type: "collection", id: incoming.id }) === "overwrite") {
        statements.push(collectionInsert(incoming));
        changedCollections.push(incoming.id);
        overwritten += 1;
      } else skipped += 1;
    }

    if (statements.length) {
      try {
        await this.db.batch(statements);
      } catch (e) {
        throw new OneDeskError("conflict", `导入失败，数据没有改动：${errorMessage(e)}`, { hint: "重新选择导出文件夹后再试", cause: e });
      }
    }
    await this.resources.refreshCounts();
    for (const resource of created) this.events.emit({ type: "resource.created", resource });
    for (const resource of updated) this.events.emit({ type: "resource.updated", resource });
    for (const id of changedCollections) this.events.emit({ type: "collection.changed", id });
    return { created: plan.newResources.length + plan.newCollections.length, overwritten, skipped };
  }
}
