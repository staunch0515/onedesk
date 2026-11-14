/** View rendering (D64): the kernel builds ViewState, calls the plugin's render, validates the tree. */
import { OneDeskError, ViewTreeSchema, isOneDeskError } from "../plugin-api";
import type { ViewNode, ViewState } from "../plugin-api";
import type { ActionRunner } from "./actions";
import { CORE_EDIT_VIEW } from "./contracts";
import { keyOwner } from "./registry";
import type { Registry } from "./registry";
import type { ResourceStore } from "./resources";
import { errorMessage, notFound, zodMessage } from "./util";

export class ViewRenderer {
  constructor(
    private readonly registry: Registry,
    private readonly resources: ResourceStore,
    private readonly actions: ActionRunner,
    private readonly isPluginDisabled: (pluginId: string) => boolean,
  ) {}

  async render(key: string, resourceId: string): Promise<ViewNode[]> {
    if (key === CORE_EDIT_VIEW) {
      throw new OneDeskError("not_implemented", "编辑视图由外壳按类型的 schema 生成，不经过视图渲染");
    }
    const resource = await this.resources.get(resourceId);
    if (!resource) throw notFound("资源");
    const entry = this.registry.viewEntry(key);
    if (!entry) {
      const owner = keyOwner(key);
      if (owner && this.isPluginDisabled(owner)) throw new OneDeskError("unavailable", "插件已停用，视图不可用", { hint: "在插件页启用后重试" });
      throw notFound(`视图 ${key} `);
    }
    // D60/D61: a view only shows on kinds of its own plugin that list it in KindDefinition.views.
    const kind = this.registry.kind(resource.kind);
    if (!kind) throw new OneDeskError("unavailable", `资源类型 ${resource.kind} 不可用，提供它的插件未启用或未安装`);
    if (kind.pluginId !== entry.pluginId || !kind.views.includes(entry.def.id)) {
      throw new OneDeskError("validation", `视图 ${key} 不适用于该类型的资源`);
    }

    const state: ViewState = { revision: resource.version + this.actions.revision(resourceId) };
    const lastResult = this.actions.lastResult(resourceId);
    if (lastResult) state.lastResult = lastResult;

    let tree: unknown;
    try {
      tree = await entry.def.render(resource, state);
    } catch (e) {
      if (isOneDeskError(e)) throw e;
      throw new OneDeskError("internal", `视图渲染失败：${errorMessage(e)}`, { cause: e });
    }
    const parsed = ViewTreeSchema.safeParse(tree);
    if (!parsed.success) throw new OneDeskError("validation", `视图内容不正确：${zodMessage(parsed.error)}`);
    return Array.isArray(parsed.data) ? parsed.data : [parsed.data];
  }
}
