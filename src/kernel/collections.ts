/** Manual collections: a name plus one rule (by tag or by kind). */
import { z } from "zod";
import { OneDeskError } from "../plugin-api";
import type { Collection } from "../plugin-api";
import type { SqlDriver, SqlParam } from "./contracts";
import type { EventBus } from "./events";
import { notFound, zodMessage } from "./util";
import type { Runtime } from "./util";

export interface CollectionRow {
  id: string;
  name: string;
  rule_type: string;
  rule_value: string;
  created_at: string;
}

export const RuleSchema = z.object({
  type: z.enum(["tag", "kind"], "集合规则只能是按标签或按类型"),
  value: z.string().trim().min(1, "集合规则的值不能为空"),
});
const NameSchema = z.string().trim().min(1, "集合名称不能为空");

export const CollectionSchema = z.object({
  id: z.string().min(1),
  name: NameSchema,
  rule: RuleSchema,
  createdAt: z.string().min(1),
});

export function rowToCollection(row: CollectionRow): Collection {
  return { id: row.id, name: row.name, rule: { type: row.rule_type === "kind" ? "kind" : "tag", value: row.rule_value }, createdAt: row.created_at };
}

export function collectionInsert(c: Collection): { sql: string; params: SqlParam[] } {
  return {
    sql: "INSERT OR REPLACE INTO collections (id, name, rule_type, rule_value, created_at) VALUES (?, ?, ?, ?, ?)",
    params: [c.id, c.name, c.rule.type, c.rule.value, c.createdAt],
  };
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new OneDeskError("validation", zodMessage(result.error));
  return result.data;
}

export class CollectionStore {
  constructor(
    private readonly db: SqlDriver,
    private readonly runtime: Runtime,
    private readonly events: EventBus,
  ) {}

  async list(): Promise<Collection[]> {
    const rows = await this.db.select<CollectionRow>("SELECT id, name, rule_type, rule_value, created_at FROM collections ORDER BY created_at, id");
    return rows.map(rowToCollection);
  }

  async get(id: string): Promise<Collection | null> {
    const rows = await this.db.select<CollectionRow>("SELECT id, name, rule_type, rule_value, created_at FROM collections WHERE id = ?", [id]);
    const row = rows[0];
    return row ? rowToCollection(row) : null;
  }

  async create(input: { name: string; rule: Collection["rule"] }): Promise<Collection> {
    const collection: Collection = {
      id: this.runtime.randomId(),
      name: parse(NameSchema, input?.name),
      rule: parse(RuleSchema, input?.rule),
      createdAt: this.runtime.now().toISOString(),
    };
    await this.db.execute("INSERT INTO collections (id, name, rule_type, rule_value, created_at) VALUES (?, ?, ?, ?, ?)", [
      collection.id,
      collection.name,
      collection.rule.type,
      collection.rule.value,
      collection.createdAt,
    ]);
    this.events.emit({ type: "collection.changed", id: collection.id });
    return collection;
  }

  async update(id: string, input: { name?: string; rule?: Collection["rule"] }): Promise<Collection> {
    const existing = await this.get(id);
    if (!existing) throw notFound("集合");
    const next: Collection = {
      ...existing,
      name: input.name === undefined ? existing.name : parse(NameSchema, input.name),
      rule: input.rule === undefined ? existing.rule : parse(RuleSchema, input.rule),
    };
    await this.db.execute("UPDATE collections SET name = ?, rule_type = ?, rule_value = ? WHERE id = ?", [next.name, next.rule.type, next.rule.value, id]);
    this.events.emit({ type: "collection.changed", id });
    return next;
  }

  async delete(id: string): Promise<void> {
    const { rowsAffected } = await this.db.execute("DELETE FROM collections WHERE id = ?", [id]);
    if (rowsAffected === 0) throw notFound("集合");
    this.events.emit({ type: "collection.changed", id });
  }
}
