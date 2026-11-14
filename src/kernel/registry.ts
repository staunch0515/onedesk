/**
 * Registry of what active plugins have registered (kinds, actions, views, menu items) plus the kind → owner map
 * taken from manifests (so the owner of a kind is known even while its plugin is disabled).
 */
import type { ActionDefinition, MenuItemDefinition, KindDefinition, ViewDefinition } from "../plugin-api";
import { CORE_EDIT_VIEW } from "./contracts";
import type { RegisteredAction, RegisteredKind, RegisteredMenuItem, RegisteredView } from "./contracts";

export interface PluginRegistrations {
  kinds: KindDefinition[];
  actions: ActionDefinition[];
  views: ViewDefinition[];
  menuItems: MenuItemDefinition[];
}

export interface ActionEntry {
  key: string;
  pluginId: string;
  def: ActionDefinition;
}
export interface ViewEntry {
  key: string;
  pluginId: string;
  def: ViewDefinition;
}

export function globalKey(pluginId: string, localId: string): string {
  return `${pluginId}/${localId}`;
}

/** Plugin id part of a global key (`pluginId/localId`); undefined if the key has no slash. */
export function keyOwner(key: string): string | undefined {
  const i = key.lastIndexOf("/");
  return i > 0 ? key.slice(0, i) : undefined;
}

const EDIT_VIEW: RegisteredView = { key: CORE_EDIT_VIEW, pluginId: "core", id: "edit", label: "编辑", icon: "pencil" };

export class Registry {
  private readonly kindMap = new Map<string, RegisteredKind>();
  private readonly actionMap = new Map<string, ActionEntry>();
  private readonly viewMap = new Map<string, ViewEntry>();
  private menu: RegisteredMenuItem[] = [];
  /** kind id → plugin id, from manifests of every loaded plugin (enabled or not). */
  private readonly owners = new Map<string, string>();

  // ---- maintained by the plugin host

  setKindOwner(kind: string, pluginId: string): void {
    this.owners.set(kind, pluginId);
  }

  removeOwner(pluginId: string): void {
    for (const [kind, owner] of this.owners) if (owner === pluginId) this.owners.delete(kind);
  }

  add(pluginId: string, regs: PluginRegistrations): void {
    for (const kind of regs.kinds) this.kindMap.set(kind.id, { ...kind, pluginId });
    for (const def of regs.actions) {
      const key = globalKey(pluginId, def.id);
      this.actionMap.set(key, { key, pluginId, def });
    }
    for (const def of regs.views) {
      const key = globalKey(pluginId, def.id);
      this.viewMap.set(key, { key, pluginId, def });
    }
    for (const item of regs.menuItems) this.menu.push({ ...item, pluginId, actionKey: globalKey(pluginId, item.action) });
  }

  remove(pluginId: string): void {
    for (const [id, kind] of this.kindMap) if (kind.pluginId === pluginId) this.kindMap.delete(id);
    for (const [key, entry] of this.actionMap) if (entry.pluginId === pluginId) this.actionMap.delete(key);
    for (const [key, entry] of this.viewMap) if (entry.pluginId === pluginId) this.viewMap.delete(key);
    this.menu = this.menu.filter((item) => item.pluginId !== pluginId);
  }

  // ---- internal lookups

  actionEntry(key: string): ActionEntry | undefined {
    return this.actionMap.get(key);
  }

  viewEntry(key: string): ViewEntry | undefined {
    return this.viewMap.get(key);
  }

  kindIds(): string[] {
    return [...this.kindMap.keys()];
  }

  hasKind(id: string): boolean {
    return this.kindMap.has(id);
  }

  // ---- Kernel["registry"]

  kinds(): RegisteredKind[] {
    return [...this.kindMap.values()];
  }

  kind(id: string): RegisteredKind | undefined {
    return this.kindMap.get(id);
  }

  kindOwner(id: string): string | undefined {
    return this.owners.get(id);
  }

  private describeAction(entry: ActionEntry): RegisteredAction {
    const kinds = entry.def.kinds ?? [];
    const isDefaultFor = kinds.filter((k) => {
      const kind = this.kindMap.get(k);
      return kind?.pluginId === entry.pluginId && kind.defaultAction === entry.def.id;
    });
    const out: RegisteredAction = { key: entry.key, pluginId: entry.pluginId, id: entry.def.id, label: entry.def.label, kinds, output: entry.def.output, isDefaultFor };
    if (entry.def.icon !== undefined) out.icon = entry.def.icon;
    return out;
  }

  /** Default action first, then registration order. */
  actionsFor(kind: string): RegisteredAction[] {
    const actions = [...this.actionMap.values()].filter((e) => (e.def.kinds ?? []).includes(kind)).map((e) => this.describeAction(e));
    return [...actions.filter((a) => a.isDefaultFor.includes(kind)), ...actions.filter((a) => !a.isDefaultFor.includes(kind))];
  }

  action(key: string): RegisteredAction | undefined {
    const entry = this.actionMap.get(key);
    return entry ? this.describeAction(entry) : undefined;
  }

  viewsFor(kind: string): RegisteredView[] {
    const def = this.kindMap.get(kind);
    if (!def) return [];
    const views: RegisteredView[] = [];
    for (const id of def.views) {
      const entry = this.viewMap.get(globalKey(def.pluginId, id));
      if (!entry) continue;
      const view: RegisteredView = { key: entry.key, pluginId: entry.pluginId, id, label: entry.def.label };
      if (entry.def.icon !== undefined) view.icon = entry.def.icon;
      views.push(view);
    }
    views.push(EDIT_VIEW);
    return views;
  }

  menuItems(): RegisteredMenuItem[] {
    return [...this.menu];
  }
}
