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
  NetworkRequestInit,
  NetworkResponse,
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
/** Redirect hops the host follows itself (each one re-checked against the allow-list). */
export const MAX_REDIRECTS = 5;

/**
 * What the kernel passes to Platform.network.fetch: the public init plus a redirect hint. With "manual" the
 * platform must NOT follow redirects itself: it returns the 3xx response (with its `location` header) or fails.
 */
export interface HostFetchInit extends NetworkRequestInit {
  redirect?: "follow" | "manual";
}
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
  /** Kinds a plugin may read (D10/D60): its own + those of `requires.plugins`. */
  readableKinds(pluginId: string): string[];
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

const HOST_LABEL = "[a-z0-9](?:[a-z0-9-]*[a-z0-9])?";
const NETWORK_PATTERN = new RegExp(`^(\\*\\.)?(${HOST_LABEL}(?:\\.${HOST_LABEL})*)(?::(\\d{1,5}))?$`);

interface NetworkPattern {
  any: boolean;
  subdomains: boolean;
  hostname: string;
  /** undefined = default port of the scheme only. */
  port?: number;
}

/**
 * Parses one `requires.network` entry (D13/D59): `*`, `host`, `host:port`, `*.host`, `*.host:port`.
 * No scheme, path, credentials, spaces or other wildcards; returns undefined for anything else.
 */
export function parseNetworkPattern(raw: string): NetworkPattern | undefined {
  if (raw === "*") return { any: true, subdomains: false, hostname: "" };
  const match = NETWORK_PATTERN.exec(raw.toLowerCase());
  if (!match) return undefined;
  const pattern: NetworkPattern = { any: false, subdomains: match[1] !== undefined, hostname: match[2]! };
  if (match[3] !== undefined) {
    const port = Number(match[3]);
    if (port < 1 || port > 65535) return undefined;
    pattern.port = port;
  }
  return pattern;
}

/**
 * True when the URL is http/https and matches one of the patterns. `*.x.com` matches sub-domains only; a pattern
 * without a port matches the scheme's default port only (80 / 443); with a port, exactly that port.
 * Anything that cannot be parsed or does not match is refused (fail closed).
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
  const defaultPort = url.protocol === "https:" ? 443 : 80;
  const port = url.port ? Number(url.port) : defaultPort;
  return patterns.some((raw) => {
    const pattern = parseNetworkPattern(raw);
    if (!pattern) return false;
    if (pattern.any) return true;
    if (port !== (pattern.port ?? defaultPort)) return false;
    if (pattern.subdomains) return hostname.endsWith(`.${pattern.hostname}`);
    return hostname === pattern.hostname;
  });
}

/** A list containing `*` allows every host, so redirects need no per-hop check. */
function allowsAnyHost(patterns: string[]): boolean {
  return patterns.includes("*");
}

const SENSITIVE_HEADERS = new Set(["authorization", "cookie", "proxy-authorization"]);

/**
 * Fetch for a plugin whose allow-list is not `*`: the platform does not follow redirects; every hop is checked
 * against the allow-list here, so a declared host cannot bounce the request to an undeclared one (D13).
 */
async function fetchCheckingRedirects(
  fetchOnce: (url: string, init: HostFetchInit) => Promise<NetworkResponse>,
  patterns: string[],
  startUrl: string,
  startInit: NetworkRequestInit,
  denied: (message: string) => OneDeskError,
): Promise<NetworkResponse> {
  let url = startUrl;
  let init: NetworkRequestInit = startInit;
  for (let hop = 0; ; hop++) {
    const response = await fetchOnce(url, { ...init, redirect: "manual" });
    if (response.status < 300 || response.status > 399 || response.status === 304) return response;
    const location = response.headers.location;
    if (!location) return response;
    if (hop >= MAX_REDIRECTS) throw new OneDeskError("unavailable", `重定向次数过多（超过 ${MAX_REDIRECTS} 次）`);
    let next: URL;
    try {
      next = new URL(location, url);
    } catch {
      throw denied("重定向的目标地址无法解析，已拒绝");
    }
    if (!isNetworkAllowed(patterns, next.href)) throw denied(`重定向到未声明的地址 ${next.host}，已拒绝`);
    // Same conventions as browsers: 303 (and 301/302 for non-GET/HEAD) become GET without a body.
    const method = (init.method ?? "GET").toUpperCase();
    const toGet = response.status === 303 || ((response.status === 301 || response.status === 302) && method !== "GET" && method !== "HEAD");
    const nextInit: NetworkRequestInit = { ...init };
    if (toGet) {
      nextInit.method = "GET";
      delete nextInit.body;
    }
    if (next.origin !== new URL(url).origin && nextInit.headers) {
      nextInit.headers = Object.fromEntries(Object.entries(nextInit.headers).filter(([name]) => !SENSITIVE_HEADERS.has(name.toLowerCase())));
    }
    url = next.href;
    init = nextInit;
  }
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
  const readableKinds = (): string[] => deps.readableKinds(pluginId);
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
        // D10: a plugin cannot use somebody's action to reach a resource it may not read itself.
        if (args?.resourceId !== undefined) {
          const target = await deps.resources.get(args.resourceId).catch(() => null);
          if (target && !readableKinds().includes(target.kind)) {
            return {
              runId: deps.runtime.randomId(),
              status: "error",
              error: { code: "permission", message: `插件 ${pluginId} 无权读取类型 ${target.kind} 的资源` },
              durationMs: 0,
              action: key,
              resourceId: args.resourceId,
              finishedAt: deps.runtime.now().toISOString(),
            };
          }
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
        const patterns = manifest.requires.network;
        const denied = (message: string): OneDeskError =>
          new OneDeskError("permission", message, { hint: "只能访问清单 requires.network 中声明的 http/https 主机" });
        if (typeof url !== "string" || !isNetworkAllowed(patterns, url)) throw denied(`插件 ${pluginId} 无权访问该地址`);
        const request: NetworkRequestInit = { ...init, timeoutMs: init?.timeoutMs ?? DEFAULT_NETWORK_TIMEOUT_MS };
        try {
          if (allowsAnyHost(patterns)) {
            const follow: HostFetchInit = { ...request, redirect: "follow" };
            return await deps.platform.network.fetch(url, follow);
          }
          return await fetchCheckingRedirects((u, i) => deps.platform.network.fetch(u, i), patterns, url, request, denied);
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
