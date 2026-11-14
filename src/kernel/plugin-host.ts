/**
 * Plugin host: one load path for built-in and external plugins (D01):
 * scan error → manifest format → apiVersion → duplicate id / kind → plugins row → (if enabled) load module → activate.
 * A bad plugin is recorded in loadErrors() or as activationError and never affects the others.
 */
import { API_VERSION, ManifestSchema, OneDeskError } from "../plugin-api";
import type { Manifest, PluginModule } from "../plugin-api";
import type { ActionRunner } from "./actions";
import type { PluginInfo, PluginLoadError, PluginSource, SqlDriver } from "./contracts";
import type { EventBus } from "./events";
import { validateFields } from "./fields";
import { createHostSession } from "./host-api";
import type { HostDeps, HostSession } from "./host-api";
import type { PluginRegistrations, Registry } from "./registry";
import type { ResourceStore } from "./resources";
import { errorMessage, isPlainObject, notFound, parseJson, zodMessage } from "./util";
import type { Runtime } from "./util";

interface PluginRecord {
  manifest: Manifest;
  source: PluginSource;
  /** `plugins.enabled` in the database: what the user asked for. */
  enabled: boolean;
  /** Activated successfully and currently registered. */
  active: boolean;
  activationError?: string;
  module?: PluginModule;
  session?: HostSession;
}

/** Cross-checks between what one plugin registered (D05, D60, D61). Returns Chinese problem descriptions. */
export function checkRegistrations(regs: PluginRegistrations): string[] {
  const problems: string[] = [];
  const kindIds = new Set(regs.kinds.map((k) => k.id));
  const viewIds = new Set(regs.views.map((v) => v.id));
  for (const action of regs.actions) {
    for (const kind of action.kinds ?? []) {
      if (!kindIds.has(kind)) problems.push(`动作 ${action.id} 的 kinds 包含不是本插件注册的类型 ${kind}`);
    }
  }
  for (const kind of regs.kinds) {
    if (kind.defaultAction !== undefined) {
      const action = regs.actions.find((a) => a.id === kind.defaultAction);
      if (!action) problems.push(`类型 ${kind.id} 的默认动作 ${kind.defaultAction} 没有注册`);
      else if (!(action.kinds ?? []).includes(kind.id)) problems.push(`类型 ${kind.id} 的默认动作 ${kind.defaultAction} 的 kinds 中没有该类型`);
    }
    for (const view of kind.views) {
      if (!viewIds.has(view)) problems.push(`类型 ${kind.id} 的视图 ${view} 没有注册`);
    }
  }
  for (const item of regs.menuItems) {
    if (!regs.actions.some((a) => a.id === item.action)) problems.push(`菜单项 ${item.id} 的动作 ${item.action} 没有注册`);
  }
  return problems;
}

export class PluginHost {
  private readonly records = new Map<string, PluginRecord>();
  private readonly errors: PluginLoadError[] = [];

  constructor(
    private readonly db: SqlDriver,
    private readonly runtime: Runtime,
    private readonly events: EventBus,
    private readonly registry: Registry,
    private readonly resources: ResourceStore,
    private readonly actions: ActionRunner,
    /** Everything a HostSession needs except the plugin-host callbacks, which are filled in here. */
    private readonly hostDeps: Omit<HostDeps, "manifestOf" | "getSettings" | "runAction">,
  ) {}

  /** True when the plugin is loaded but not active (used by the action runner for a precise error). */
  isDisabled(id: string): boolean {
    const record = this.records.get(id);
    return record !== undefined && !record.active;
  }

  private fail(source: PluginSource, reason: string, pluginId?: string): void {
    const error: PluginLoadError = { origin: source.origin, location: source.location, reason };
    if (pluginId !== undefined) error.pluginId = pluginId;
    this.errors.push(error);
  }

  private rawId(manifest: unknown): string | undefined {
    return isPlainObject(manifest) && typeof manifest.id === "string" ? manifest.id : undefined;
  }

  async load(sources: PluginSource[]): Promise<void> {
    for (const source of sources) {
      try {
        await this.loadOne(source);
      } catch (e) {
        this.fail(source, `加载失败：${errorMessage(e)}`, this.rawId(source.manifest));
      }
    }
  }

  private async loadOne(source: PluginSource): Promise<void> {
    if (source.error) return this.fail(source, source.error, this.rawId(source.manifest));
    if (source.manifest === null || source.manifest === undefined) return this.fail(source, "清单 manifest.json 缺失或无法读取");

    const parsed = ManifestSchema.safeParse(source.manifest);
    if (!parsed.success) return this.fail(source, `清单格式错误：${zodMessage(parsed.error)}`, this.rawId(source.manifest));
    const manifest = parsed.data;

    if (manifest.apiVersion !== API_VERSION) {
      return this.fail(source, `apiVersion "${manifest.apiVersion}" 不兼容，当前只支持 "${API_VERSION}"`, manifest.id);
    }
    const duplicate = this.records.get(manifest.id);
    if (duplicate) return this.fail(source, `插件 id ${manifest.id} 重复，已由 ${duplicate.source.location} 提供`, manifest.id);
    for (const kind of manifest.provides.kinds) {
      const owner = this.registry.kindOwner(kind);
      if (owner) return this.fail(source, `资源类型 ${kind} 已由插件 ${owner} 提供`, manifest.id);
    }

    const rows = await this.db.select<{ enabled: number; uninstalled: number }>("SELECT enabled, uninstalled FROM plugins WHERE id = ?", [manifest.id]);
    let row = rows[0];
    if (!row) {
      // D54: built-in plugins start enabled, newly found external plugins start disabled.
      row = { enabled: source.origin === "builtin" ? 1 : 0, uninstalled: 0 };
      await this.db.execute("INSERT INTO plugins (id, enabled, uninstalled, settings, installed_at) VALUES (?, ?, 0, '{}', ?)", [
        manifest.id,
        row.enabled,
        this.runtime.now().toISOString(),
      ]);
    }
    if (row.uninstalled === 1 && source.origin === "external") return; // D54: stays uninstalled across scans.

    const record: PluginRecord = { manifest, source, enabled: row.enabled === 1, active: false };
    this.records.set(manifest.id, record);
    for (const kind of manifest.provides.kinds) this.registry.setKindOwner(kind, manifest.id);
    if (record.enabled) await this.activate(record);
    this.events.emit({ type: "plugin.changed", pluginId: manifest.id });
  }

  private async activate(record: PluginRecord): Promise<void> {
    delete record.activationError;
    let session: HostSession | undefined;
    try {
      const module = record.module ?? (await record.source.load());
      if (!module || typeof module.activate !== "function") throw new OneDeskError("validation", "插件入口没有默认导出 activate 函数");
      record.module = module;
      session = createHostSession(
        {
          ...this.hostDeps,
          manifestOf: (id) => this.records.get(id)?.manifest,
          getSettings: (id) => this.getSettings(id),
          runAction: (key, args) => this.actions.run(key, args),
        },
        record.manifest,
      );
      await module.activate(session.api);
      session.closeRegistration();
      const problems = [...session.violations, ...checkRegistrations(session.regs)];
      if (problems.length) throw new OneDeskError("validation", [...new Set(problems)].join("；"));
      this.registry.add(record.manifest.id, session.regs);
      record.session = session;
      record.active = true;
    } catch (e) {
      session?.revoke();
      record.active = false;
      record.activationError = `激活失败：${errorMessage(e)}`;
    }
  }

  private async deactivate(record: PluginRecord): Promise<void> {
    if (!record.active) return;
    const id = record.manifest.id;
    record.active = false;
    this.actions.abortPlugin(id);
    this.registry.remove(id);
    try {
      await record.module?.deactivate?.();
    } catch (e) {
      console.error(`插件 ${id} 停用时出错`, e);
    }
    record.session?.revoke();
    delete record.session;
  }

  private require(id: string): PluginRecord {
    const record = this.records.get(id);
    if (!record) throw notFound("插件");
    return record;
  }

  list(): PluginInfo[] {
    return [...this.records.values()].map((record) => {
      const info: PluginInfo = {
        manifest: record.manifest,
        origin: record.source.origin,
        location: record.source.location,
        state: record.active ? "enabled" : "disabled",
        resourceCount: this.resources.countOfKinds(record.manifest.provides.kinds),
      };
      if (record.activationError !== undefined) info.activationError = record.activationError;
      return info;
    });
  }

  loadErrors(): PluginLoadError[] {
    return [...this.errors];
  }

  /** Rejects when activation fails; the reason is also kept in PluginInfo.activationError. */
  async enable(id: string): Promise<void> {
    const record = this.require(id);
    await this.db.execute("UPDATE plugins SET enabled = 1 WHERE id = ?", [id]);
    record.enabled = true;
    if (!record.active) await this.activate(record);
    this.events.emit({ type: "plugin.changed", pluginId: id });
    if (record.activationError !== undefined) throw new OneDeskError("unavailable", record.activationError);
  }

  async disable(id: string): Promise<void> {
    const record = this.require(id);
    await this.db.execute("UPDATE plugins SET enabled = 0 WHERE id = ?", [id]);
    record.enabled = false;
    delete record.activationError;
    await this.deactivate(record);
    this.events.emit({ type: "plugin.changed", pluginId: id });
  }

  async uninstall(id: string): Promise<{ declaredSecrets: string[] }> {
    const record = this.require(id);
    if (record.source.origin === "builtin") throw new OneDeskError("permission", "内置插件不能卸载，只能停用");
    await this.deactivate(record);
    // D16/D54: drop settings and plugin storage, keep the folder and the resources, remember "uninstalled".
    await this.db.batch([
      { sql: "UPDATE plugins SET enabled = 0, uninstalled = 1, settings = '{}' WHERE id = ?", params: [id] },
      { sql: "DELETE FROM plugin_storage WHERE plugin_id = ?", params: [id] },
    ]);
    this.records.delete(id);
    this.registry.removeOwner(id);
    // D53: only secrets no other installed plugin declares.
    const others = new Set<string>();
    for (const other of this.records.values()) for (const name of other.manifest.requires.secrets) others.add(name);
    const declaredSecrets = record.manifest.requires.secrets.filter((name) => !others.has(name));
    this.events.emit({ type: "plugin.changed", pluginId: id });
    return { declaredSecrets };
  }

  async getSettings(id: string): Promise<Record<string, unknown>> {
    const record = this.require(id);
    const values: Record<string, unknown> = {};
    for (const field of record.manifest.settings) if (field.default !== undefined) values[field.name] = field.default;
    const rows = await this.db.select<{ settings: string }>("SELECT settings FROM plugins WHERE id = ?", [id]);
    const stored = parseJson<unknown>(rows[0]?.settings ?? "{}", {});
    if (isPlainObject(stored)) Object.assign(values, stored);
    return values;
  }

  /** Merges into the stored values; only fields declared in manifest.settings are kept. */
  async setSettings(id: string, values: Record<string, unknown>): Promise<void> {
    const record = this.require(id);
    if (!isPlainObject(values)) throw new OneDeskError("validation", "设置必须是对象");
    const fields = record.manifest.settings;
    const names = new Set(fields.map((f) => f.name));
    const rows = await this.db.select<{ settings: string }>("SELECT settings FROM plugins WHERE id = ?", [id]);
    const stored = parseJson<unknown>(rows[0]?.settings ?? "{}", {});
    const merged: Record<string, unknown> = {};
    for (const [key, value] of Object.entries({ ...(isPlainObject(stored) ? stored : {}), ...values })) {
      if (names.has(key) && value !== undefined) merged[key] = value;
    }
    const errors = validateFields(fields, { ...(await this.getSettings(id)), ...merged });
    if (Object.keys(errors).length) throw new OneDeskError("validation", Object.values(errors).join("；"), { fields: errors });
    await this.db.execute("UPDATE plugins SET settings = ? WHERE id = ?", [JSON.stringify(merged), id]);
    this.events.emit({ type: "plugin.changed", pluginId: id });
  }
}
