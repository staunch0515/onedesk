/**
 * The HostApi instance handed to one plugin, with its permission checks:
 *  - D10/D60: read own kinds + kinds of `requires.plugins`; write own kinds only; events filtered the same way.
 *  - D13/D59: network only to hosts matching `requires.network`, http/https only (fail closed).
 *  - D14: secrets only by names in `requires.secrets`.
 *  - Registration only during activation and only for ids declared in `provides`.
 * After `revoke()` (plugin disabled) every call throws OneDeskError("unavailable").
 */
import { z } from "zod";
import {
  ActionInputSpecSchema,
  ActionOutputTypeSchema,
  FieldDefSchema,
  LocalIdSchema,
  NotifySchema,
  OneDeskError,
  SafeHrefSchema,
  isOneDeskError,
} from "../plugin-api";
import type {
  ActionDefinition,
  ActionResult,
  HostApi,
  HostEvent,
  KindDefinition,
  Manifest,
  MenuItemDefinition,
  Resource,
  ViewDefinition,
} from "../plugin-api";
import type { CollectionStore } from "./collections";
import type { Kernel, KernelEvent, Platform, SqlDriver } from "./contracts";
import type { EventBus } from "./events";
import { keyOwner } from "./registry";
import type { PluginRegistrations, Registry } from "./registry";
import type { ResourceStore } from "./resources";
import { errorMessage, parseJson, zodMessage } from "./util";
import type { Runtime } from "./util";

export const DEFAULT_NETWORK_TIMEOUT_MS = 30_000;
const HOST_EVENT_TYPES: ReadonlyArray<HostEvent["type"]> = ["resource.created", "resource.updated", "resource.deleted", "action.completed"];

export interface HostDeps {
  db: SqlDriver;
  runtime: Runtime;
  events: EventBus;
  registry: Registry;
  resources: ResourceStore;
  collections: CollectionStore;
  platform: Pick<Platform, "system" | "network" | "secrets">;
  context: Kernel["context"];
  runAction(key: string, args: { resourceId?: string; input?: Record<string, unknown> }): Promise<ActionResult>;
  /** Manifest of any loaded plugin (enabled or not). */
  manifestOf(pluginId: string): Manifest | undefined;
  getSettings(pluginId: string): Promise<Record<string, unknown>>;
}

export interface HostSession {
  api: HostApi;
  regs: PluginRegistrations;
  /** Registration attempts that were refused; any entry fails the activation even if the plugin swallowed the error. */
  violations: string[];
  closeRegistration(): void;
  revoke(): void;
}

/**
 * D13/D59 host patterns: exact host (`api.x.com`, optionally with `:port`), `*.x.com` (sub-domains only), or `*`.
 * Anything that cannot be parsed, is not http/https, or does not match is refused.
 */
export function isNetworkAllowed(patterns: string[], rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!hostname) return false;
  const host = url.port ? `${hostname}:${url.port}` : hostname;
  return patterns.some((raw) => {
    const pattern = raw.trim().toLowerCase();
    if (pattern === "*") return true;
    if (pattern.startsWith("*.")) {
      const suffix = pattern.slice(1);
      if (suffix.length < 2 || suffix.includes("*")) return false;
      return hostname.length > suffix.length && hostname.endsWith(suffix);
    }
    if (pattern.includes("*")) return false;
    return pattern === hostname || pattern === host;
  });
}

const KindShape = z.object({
  id: LocalIdSchema,
  name: z.string().min(1, "名称不能为空"),
  icon: z.string().optional(),
  schema: z.array(FieldDefSchema),
  defaultAction: LocalIdSchema.optional(),
  views: z.array(LocalIdSchema),
});
const ActionShape = z.object({
  id: LocalIdSchema,
  label: z.string().min(1, "label 不能为空"),
  icon: z.string().optional(),
  kinds: z.array(z.string()).optional(),
  input: ActionInputSpecSchema.optional(),
  output: ActionOutputTypeSchema,
});
const ViewShape = z.object({ id: LocalIdSchema, label: z.string().min(1, "label 不能为空"), icon: z.string().optional() });
const MenuItemShape = z.object({ id: LocalIdSchema, label: z.string().min(1, "label 不能为空"), icon: z.string().optional(), action: LocalIdSchema });

export function createHostSession(deps: HostDeps, manifest: Manifest): HostSession {
  const pluginId = manifest.id;
  const regs: PluginRegistrations = { kinds: [], actions: [], views: [], menuItems: [] };
  const violations: string[] = [];
  const unsubscribes: Array<() => void> = [];
  let registering = true;
  let revoked = false;

  const live = (): void => {
    if (revoked) throw new OneDeskError("unavailable", "插件已停用，不能再使用宿主接口");
  };
  const refuse = (code: "permission" | "validation" | "conflict", message: string): never => {
    violations.push(message);
    throw new OneDeskError(code, message);
  };
  const beginRegistration = (what: string): void => {
    live();
    if (!registering) throw new OneDeskError("permission", `${what}只能在插件激活时注册`);
  };
  const checkShape = (schema: z.ZodType, value: unknown, what: string): void => {
    const result = schema.safeParse(value);
    if (!result.success) refuse("validation", `${what}定义不正确：${zodMessage(result.error)}`);
  };

  const ownKinds = (): string[] => manifest.provides.kinds;
  const readableKinds = (): string[] => {
    const kinds = new Set(ownKinds());
    for (const other of manifest.requires.plugins) for (const kind of deps.manifestOf(other)?.provides.kinds ?? []) kinds.add(kind);
    return [...kinds];
  };
  const assertReadable = (kind: string): void => {
    if (!readableKinds().includes(kind)) throw new OneDeskError("permission", `插件 ${pluginId} 无权读取类型 ${kind} 的资源`);
  };
  const assertWritable = (kind: string): void => {
    if (!ownKinds().includes(kind)) throw new OneDeskError("permission", `插件 ${pluginId} 无权修改类型 ${kind} 的资源`);
  };
  const canRunPlugin = (owner: string | undefined): boolean => owner === pluginId || (owner !== undefined && manifest.requires.plugins.includes(owner));
  const canSee = (event: KernelEvent): boolean => {
    switch (event.type) {
      case "resource.created":
      case "resource.updated":
        return readableKinds().includes(event.resource.kind);
      case "resource.deleted":
        return readableKinds().includes(event.kind);
      case "action.completed":
        return canRunPlugin(keyOwner(event.result.action));
      default:
        return false;
    }
  };
  const existingWritable = async (id: string): Promise<Resource> => {
    const existing = await deps.resources.get(id);
    if (!existing) throw new OneDeskError("not_found", "资源不存在");
    assertWritable(existing.kind);
    return existing;
  };

  const api: HostApi = {
    pluginId,

    resources: {
      registerKind(kind: KindDefinition): void {
        beginRegistration("资源类型");
        checkShape(KindShape, kind, "资源类型");
        if (typeof kind.describe !== "function") refuse("validation", `资源类型 ${kind.id} 缺少 describe 函数`);
        if (!manifest.provides.kinds.includes(kind.id)) refuse("permission", `资源类型 ${kind.id} 没有在清单 provides.kinds 中声明`);
        if (regs.kinds.some((k) => k.id === kind.id)) refuse("conflict", `资源类型 ${kind.id} 重复注册`);
        const owner = deps.registry.kind(kind.id)?.pluginId;
        if (owner && owner !== pluginId) refuse("conflict", `资源类型 ${kind.id} 已由插件 ${owner} 注册`);
        regs.kinds.push(kind);
      },
      async get(id) {
        live();
        const resource = await deps.resources.get(id);
        if (!resource) return null;
        assertReadable(resource.kind);
        return resource;
      },
      async list(query = {}) {
        live();
        if (query.kind !== undefined) assertReadable(query.kind);
        return deps.resources.list(query, { kinds: readableKinds() });
      },
      async create(draft) {
        live();
        assertWritable(String(draft?.kind));
        return deps.resources.create(draft);
      },
      async update(id, patch) {
        live();
        await existingWritable(id);
        return deps.resources.update(id, patch);
      },
      async delete(id) {
        live();
        await existingWritable(id);
        return deps.resources.delete(id);
      },
    },

    collections: {
      async list() {
        live();
        return deps.collections.list();
      },
      async get(id) {
        live();
        return deps.collections.get(id);
      },
      async create(input) {
        live();
        return deps.collections.create(input);
      },
    },

    actions: {
      register(action: ActionDefinition): void {
        beginRegistration("动作");
        checkShape(ActionShape, action, "动作");
        if (typeof action.run !== "function") refuse("validation", `动作 ${action.id} 缺少 run 函数`);
        if (!manifest.provides.actions.includes(action.id)) refuse("permission", `动作 ${action.id} 没有在清单 provides.actions 中声明`);
        if (regs.actions.some((a) => a.id === action.id)) refuse("conflict", `动作 ${action.id} 重复注册`);
        regs.actions.push(action);
      },
      async run(key, args) {
        if (revoked || !canRunPlugin(keyOwner(key))) {
          // Never throws (D56): produce an error result without touching the target action.
          const now = deps.runtime.now().toISOString();
          const result: ActionResult = {
            runId: deps.runtime.randomId(),
            status: "error",
            error: revoked
              ? { code: "unavailable", message: "插件已停用，不能再使用宿主接口" }
              : { code: "permission", message: `插件 ${pluginId} 无权运行动作 ${key}`, hint: "在清单 requires.plugins 中声明对方插件" },
            durationMs: 0,
            action: key,
            finishedAt: now,
          };
          if (args?.resourceId !== undefined) result.resourceId = args.resourceId;
          return result;
        }
        const runArgs: { resourceId?: string; input?: Record<string, unknown> } = {};
        if (args?.resourceId !== undefined) runArgs.resourceId = args.resourceId;
        if (args?.input !== undefined) runArgs.input = args.input;
        return deps.runAction(key, runArgs);
      },
    },

    events: {
      on(type, handler) {
        live();
        if (!HOST_EVENT_TYPES.includes(type)) throw new OneDeskError("validation", `不支持订阅事件 ${String(type)}`);
        const off = deps.events.on(type, (event) => {
          if (revoked || !canSee(event)) return;
          (handler as (e: KernelEvent) => void)(event);
        });
        unsubscribes.push(off);
        return off;
      },
    },

    ui: {
      registerView(view: ViewDefinition): void {
        beginRegistration("视图");
        checkShape(ViewShape, view, "视图");
        if (typeof view.render !== "function") refuse("validation", `视图 ${view.id} 缺少 render 函数`);
        if (!manifest.provides.views.includes(view.id)) refuse("permission", `视图 ${view.id} 没有在清单 provides.views 中声明`);
        if (regs.views.some((v) => v.id === view.id)) refuse("conflict", `视图 ${view.id} 重复注册`);
        regs.views.push(view);
      },
      registerMenuItem(item: MenuItemDefinition): void {
        beginRegistration("菜单项");
        checkShape(MenuItemShape, item, "菜单项");
        if (regs.menuItems.some((m) => m.id === item.id)) refuse("conflict", `菜单项 ${item.id} 重复注册`);
        regs.menuItems.push(item);
      },
      async openExternal(url) {
        live();
        if (typeof url !== "string" || !SafeHrefSchema.safeParse(url).success) {
          throw new OneDeskError("validation", "只能打开 http、https、mailto 链接");
        }
        await deps.platform.system.openExternal(url);
      },
      async copyText(text) {
        live();
        await deps.platform.system.copyText(String(text));
      },
    },

    storage: {
      async get<T = unknown>(key: string): Promise<T | undefined> {
        live();
        const rows = await deps.db.select<{ value: string }>("SELECT value FROM plugin_storage WHERE plugin_id = ? AND key = ?", [pluginId, key]);
        const row = rows[0];
        return row ? parseJson<T | undefined>(row.value, undefined) : undefined;
      },
      async set(key, value) {
        live();
        if (!key) throw new OneDeskError("validation", "存储的键不能为空");
        if (value === undefined) {
          await deps.db.execute("DELETE FROM plugin_storage WHERE plugin_id = ? AND key = ?", [pluginId, key]);
          return;
        }
        await deps.db.execute(
          "INSERT INTO plugin_storage (plugin_id, key, value) VALUES (?, ?, ?) ON CONFLICT(plugin_id, key) DO UPDATE SET value = excluded.value",
          [pluginId, key, JSON.stringify(value)],
        );
      },
      async delete(key) {
        live();
        await deps.db.execute("DELETE FROM plugin_storage WHERE plugin_id = ? AND key = ?", [pluginId, key]);
      },
      async keys() {
        live();
        const rows = await deps.db.select<{ key: string }>("SELECT key FROM plugin_storage WHERE plugin_id = ? ORDER BY key", [pluginId]);
        return rows.map((r) => r.key);
      },
    },

    settings: {
      async get<T = unknown>(name: string): Promise<T | undefined> {
        live();
        const values = await deps.getSettings(pluginId);
        return values[name] as T | undefined;
      },
    },

    secrets: {
      async get(name) {
        live();
        if (!manifest.requires.secrets.includes(name)) {
          throw new OneDeskError("permission", `插件 ${pluginId} 没有在清单 requires.secrets 中声明密钥 ${name}`);
        }
        return deps.platform.secrets.get(name);
      },
    },

    network: {
      async fetch(url, init) {
        live();
        if (typeof url !== "string" || !isNetworkAllowed(manifest.requires.network, url)) {
          throw new OneDeskError("permission", `插件 ${pluginId} 无权访问该地址`, { hint: "只能访问清单 requires.network 中声明的 http/https 主机" });
        }
        try {
          return await deps.platform.network.fetch(url, { ...init, timeoutMs: init?.timeoutMs ?? DEFAULT_NETWORK_TIMEOUT_MS });
        } catch (e) {
          if (isOneDeskError(e)) throw e;
          throw new OneDeskError("unavailable", `网络请求失败：${errorMessage(e)}`, { cause: e });
        }
      },
    },

    notify(message) {
      live();
      const parsed = NotifySchema.safeParse(message);
      if (!parsed.success) throw new OneDeskError("validation", `通知内容不正确：${zodMessage(parsed.error)}`);
      deps.events.emit({ type: "notify", pluginId, message: parsed.data });
    },

    context: { workspace: { ...deps.context.workspace }, user: { ...deps.context.user } },
  };

  return {
    api,
    regs,
    violations,
    closeRegistration() {
      registering = false;
    },
    revoke() {
      revoked = true;
      registering = false;
      for (const off of unsubscribes.splice(0)) off();
    },
  };
}
