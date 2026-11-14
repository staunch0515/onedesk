/** Resource store: single `resources` table, optimistic concurrency via `version`, search_text maintained on write. */
import { OneDeskError, ResourceDraftSchema, ResourcePatchSchema } from "../plugin-api";
import type { Resource, ResourceDraft, ResourcePatch, ResourceQuery } from "../plugin-api";
import type { CollectionStore } from "./collections";
import type { SqlDriver, SqlParam } from "./contracts";
import type { EventBus } from "./events";
import { validateFields } from "./fields";
import type { Registry } from "./registry";
import { buildSearchText, searchSql, searchTerms } from "./search";
import { notFound, parseJson, zodFields, zodMessage } from "./util";
import type { Runtime } from "./util";

interface ResourceRow {
  id: string;
  kind: string;
  name: string;
  group_name: string;
  tags: string;
  description: string;
  body: string;
  visibility: string;
  ai_visible: number;
  version: number;
  created_at: string;
  updated_at: string;
  origin: string;
}

const COLUMNS = "id, kind, name, group_name, tags, description, body, visibility, ai_visible, version, created_at, updated_at, origin";
const DEFAULT_SEARCH_LIMIT = 100;

function rowToResource(row: ResourceRow): Resource {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    group: row.group_name,
    tags: parseJson<string[]>(row.tags, []),
    description: row.description,
    body: parseJson<Record<string, unknown>>(row.body, {}),
    visibility: row.visibility === "public" ? "public" : "private",
    aiVisible: row.ai_visible === 1,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    origin: row.origin === "subscribed" || row.origin === "copied" ? row.origin : "original",
  };
}

/** Full-row upsert, also used by import (keeps id, version, timestamps, origin as given). */
export function resourceUpsert(r: Resource): { sql: string; params: SqlParam[] } {
  return {
    sql: `INSERT OR REPLACE INTO resources (${COLUMNS}, search_text) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    params: [
      r.id,
      r.kind,
      r.name,
      r.group,
      JSON.stringify(r.tags),
      r.description,
      JSON.stringify(r.body),
      r.visibility,
      r.aiVisible ? 1 : 0,
      r.version,
      r.createdAt,
      r.updatedAt,
      r.origin,
      buildSearchText(r),
    ],
  };
}

/** The exact text `instr(tags, ?)` must find for a tag (D25): the tag as a JSON string, quotes included. */
function tagNeedle(tag: string): string {
  return JSON.stringify(tag);
}

function uniqueTags(tags: string[]): string[] {
  return [...new Set(tags)];
}

export interface ListOptions {
  includeDisabled?: boolean;
  /** Restrict to these kinds (host API read scope). */
  kinds?: string[];
}

export class ResourceStore {
  /** kind → number of stored resources; lets `plugins.list()` stay synchronous. */
  private readonly counts = new Map<string, number>();

  constructor(
    private readonly db: SqlDriver,
    private readonly runtime: Runtime,
    private readonly events: EventBus,
    private readonly registry: Registry,
    private readonly collections: CollectionStore,
  ) {}

  async init(): Promise<void> {
    await this.refreshCounts();
  }

  async refreshCounts(): Promise<void> {
    const rows = await this.db.select<{ kind: string; n: number }>("SELECT kind, COUNT(*) AS n FROM resources GROUP BY kind");
    this.counts.clear();
    for (const row of rows) this.counts.set(row.kind, row.n);
  }

  countOfKinds(kinds: string[]): number {
    return kinds.reduce((sum, kind) => sum + (this.counts.get(kind) ?? 0), 0);
  }

  private bump(kind: string, delta: number): void {
    this.counts.set(kind, Math.max(0, (this.counts.get(kind) ?? 0) + delta));
  }

  /** Kinds a query may return, or undefined for "no restriction". */
  private allowedKinds(options: ListOptions): string[] | undefined {
    let allowed: string[] | undefined = options.includeDisabled ? undefined : this.registry.kindIds();
    if (options.kinds) {
      const scope = options.kinds;
      allowed = allowed ? allowed.filter((k) => scope.includes(k)) : [...scope];
    }
    return allowed;
  }

  async get(id: string): Promise<Resource | null> {
    const rows = await this.db.select<ResourceRow>(`SELECT ${COLUMNS} FROM resources WHERE id = ?`, [id]);
    const row = rows[0];
    return row ? rowToResource(row) : null;
  }

  async list(query: ResourceQuery = {}, options: ListOptions = {}): Promise<Resource[]> {
    const where: string[] = [];
    const params: SqlParam[] = [];
    if (query.kind !== undefined) {
      where.push("kind = ?");
      params.push(query.kind);
    }
    if (query.tag !== undefined) {
      where.push("instr(tags, ?) > 0");
      params.push(tagNeedle(query.tag));
    }
    if (query.group !== undefined) {
      where.push("group_name = ?");
      params.push(query.group);
    }
    if (query.collectionId !== undefined) {
      const collection = await this.collections.get(query.collectionId);
      if (!collection) throw notFound("集合");
      if (collection.rule.type === "kind") {
        where.push("kind = ?");
        params.push(collection.rule.value);
      } else {
        where.push("instr(tags, ?) > 0");
        params.push(tagNeedle(collection.rule.value));
      }
    }
    const allowed = this.allowedKinds(options);
    if (allowed) {
      if (allowed.length === 0) return [];
      where.push(`kind IN (${allowed.map(() => "?").join(", ")})`);
      params.push(...allowed);
    }
    let sql = `SELECT ${COLUMNS} FROM resources`;
    if (where.length) sql += ` WHERE ${where.join(" AND ")}`;
    sql += " ORDER BY updated_at DESC, created_at DESC, id";
    if (query.limit !== undefined || query.offset !== undefined) {
      sql += " LIMIT ? OFFSET ?";
      // LIMIT -1 = no limit in SQLite.
      params.push(query.limit === undefined ? -1 : Math.max(0, Math.floor(query.limit)), Math.max(0, Math.floor(query.offset ?? 0)));
    }
    const rows = await this.db.select<ResourceRow>(sql, params);
    return rows.map(rowToResource);
  }

  async search(text: string, options: { kinds?: string[]; limit?: number; includeDisabled?: boolean } = {}): Promise<Resource[]> {
    const terms = searchTerms(text);
    const limit = Math.max(0, Math.floor(options.limit ?? DEFAULT_SEARCH_LIMIT));
    const listOptions: ListOptions = { includeDisabled: options.includeDisabled === true };
    if (options.kinds) listOptions.kinds = options.kinds;
    if (terms.length === 0) return this.list({ limit }, listOptions);
    const allowed = this.allowedKinds(listOptions);
    if (allowed && allowed.length === 0) return [];
    const { where, whereParams, score, scoreParams } = searchSql(terms);
    const params: SqlParam[] = [...whereParams];
    // Two steps: rank ids first (the sorter then carries only small rows), then load the winners.
    let sql = `SELECT id FROM resources WHERE ${where}`;
    if (allowed) {
      sql += ` AND kind IN (${allowed.map(() => "?").join(", ")})`;
      params.push(...allowed);
    }
    sql += ` ORDER BY (${score}) DESC, updated_at DESC, id LIMIT ?`;
    params.push(...scoreParams, limit);
    const ids = (await this.db.select<{ id: string }>(sql, params)).map((row) => row.id);
    if (ids.length === 0) return [];
    const rows = await this.db.select<ResourceRow>(`SELECT ${COLUMNS} FROM resources WHERE id IN (${ids.map(() => "?").join(", ")})`, ids);
    const byId = new Map(rows.map((row) => [row.id, row]));
    const found: Resource[] = [];
    for (const id of ids) {
      const row = byId.get(id);
      if (row) found.push(rowToResource(row));
    }
    return found;
  }

  validate(kind: string, body: Record<string, unknown>): Record<string, string> {
    const def = this.registry.kind(kind);
    if (!def) return {};
    const errors = validateFields(def.schema, body);
    if (def.validate) {
      try {
        const extra = def.validate(body) ?? {};
        for (const [field, message] of Object.entries(extra)) if (!(field in errors)) errors[field] = String(message);
      } catch (e) {
        errors._ = `校验出错：${e instanceof Error ? e.message : String(e)}`;
      }
    }
    return errors;
  }

  private assertBody(kind: string, body: Record<string, unknown>): void {
    if (!this.registry.hasKind(kind)) {
      throw new OneDeskError("unavailable", `资源类型 ${kind} 不可用，提供它的插件未启用或未安装`);
    }
    const fields = this.validate(kind, body);
    const messages = Object.values(fields);
    if (messages.length) throw new OneDeskError("validation", messages.join("；"), { fields });
  }

  /** `id` and `origin` of the draft are ignored (D66): the kernel assigns them. */
  async create(draftInput: ResourceDraft): Promise<Resource> {
    const parsed = ResourceDraftSchema.safeParse(draftInput);
    if (!parsed.success) throw new OneDeskError("validation", zodMessage(parsed.error), { fields: zodFields(parsed.error) });
    const draft = parsed.data;
    this.assertBody(draft.kind, draft.body);
    const now = this.runtime.now().toISOString();
    const resource: Resource = {
      id: this.runtime.randomId(),
      kind: draft.kind,
      name: draft.name,
      group: draft.group,
      tags: uniqueTags(draft.tags),
      description: draft.description,
      body: draft.body,
      visibility: draft.visibility,
      aiVisible: draft.aiVisible,
      version: 1,
      createdAt: now,
      updatedAt: now,
      origin: "original",
    };
    const stmt = resourceUpsert(resource);
    await this.db.execute(stmt.sql.replace("INSERT OR REPLACE", "INSERT"), stmt.params);
    this.bump(resource.kind, 1);
    this.events.emit({ type: "resource.created", resource });
    return resource;
  }

  async update(id: string, patchInput: ResourcePatch): Promise<Resource> {
    const parsed = ResourcePatchSchema.safeParse(patchInput);
    if (!parsed.success) throw new OneDeskError("validation", zodMessage(parsed.error), { fields: zodFields(parsed.error) });
    const patch = parsed.data;
    const existing = await this.get(id);
    if (!existing) throw notFound("资源");
    const conflict = () => new OneDeskError("conflict", "资源已被修改，请刷新后重试", { hint: "重新打开资源后再保存" });
    if (patch.expectedVersion !== undefined && patch.expectedVersion !== existing.version) throw conflict();
    if (patch.body !== undefined) this.assertBody(existing.kind, patch.body);
    const next: Resource = {
      ...existing,
      name: patch.name ?? existing.name,
      group: patch.group ?? existing.group,
      tags: patch.tags ? uniqueTags(patch.tags) : existing.tags,
      description: patch.description ?? existing.description,
      body: patch.body ?? existing.body,
      visibility: patch.visibility ?? existing.visibility,
      aiVisible: patch.aiVisible ?? existing.aiVisible,
      version: existing.version + 1,
      updatedAt: this.runtime.now().toISOString(),
    };
    // The version check is part of the UPDATE so two concurrent writers cannot both succeed.
    const { rowsAffected } = await this.db.execute(
      `UPDATE resources SET name = ?, group_name = ?, tags = ?, description = ?, body = ?, visibility = ?, ai_visible = ?,
         version = ?, updated_at = ?, search_text = ? WHERE id = ? AND version = ?`,
      [
        next.name,
        next.group,
        JSON.stringify(next.tags),
        next.description,
        JSON.stringify(next.body),
        next.visibility,
        next.aiVisible ? 1 : 0,
        next.version,
        next.updatedAt,
        buildSearchText(next),
        id,
        existing.version,
      ],
    );
    if (rowsAffected === 0) throw conflict();
    this.events.emit({ type: "resource.updated", resource: next });
    return next;
  }

  async delete(id: string): Promise<void> {
    const existing = await this.get(id);
    if (!existing) throw notFound("资源");
    await this.db.execute("DELETE FROM resources WHERE id = ?", [id]);
    this.bump(existing.kind, -1);
    this.events.emit({ type: "resource.deleted", id, kind: existing.kind });
  }

  /** Tags of resources whose kind is currently registered, most used first. */
  async tags(): Promise<Array<{ tag: string; count: number }>> {
    const kinds = this.registry.kindIds();
    if (kinds.length === 0) return [];
    const rows = await this.db.select<{ tags: string }>(
      `SELECT tags FROM resources WHERE tags != '[]' AND kind IN (${kinds.map(() => "?").join(", ")})`,
      kinds,
    );
    const counts = new Map<string, number>();
    for (const row of rows) for (const tag of parseJson<string[]>(row.tags, [])) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    return [...counts.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, "zh-CN"));
  }

  /** Non-empty group names of resources whose kind is currently registered, sorted. */
  async groups(): Promise<string[]> {
    const kinds = this.registry.kindIds();
    if (kinds.length === 0) return [];
    const rows = await this.db.select<{ group_name: string }>(
      `SELECT DISTINCT group_name FROM resources WHERE group_name != '' AND kind IN (${kinds.map(() => "?").join(", ")})`,
      kinds,
    );
    return rows.map((r) => r.group_name).sort((a, b) => a.localeCompare(b, "zh-CN"));
  }
}
