/**
 * Action runner (D56): every run has a runId, can be cancelled, and always resolves to an ActionResult —
 * unknown action, disabled plugin, invalid input, plugin exception and wrong output type are error results.
 */
import { ActionOutputSchema, OneDeskError, ParameterDefSchema } from "../plugin-api";
import type { ActionContext, ActionOutput, ActionResult, FieldDef, InvocationSource, Resource } from "../plugin-api";
import type { Kernel } from "./contracts";
import type { EventBus } from "./events";
import { applyDefaults, validateFields } from "./fields";
import { keyOwner } from "./registry";
import type { Registry } from "./registry";
import type { ResourceStore } from "./resources";
import { isPlainObject, toErrorInfo, zodMessage } from "./util";
import type { Runtime } from "./util";

interface Running {
  runId: string;
  key: string;
  pluginId: string;
  resourceId?: string;
  startedAt: string;
  controller: AbortController;
}

export interface RunArgs {
  resourceId?: string;
  input?: Record<string, unknown>;
  source?: InvocationSource;
}

export class ActionRunner {
  private readonly active = new Map<string, Running>();
  private readonly last = new Map<string, ActionResult>();
  /** Per-resource counter bumped whenever its last action result changes (feeds ViewState.revision). */
  private readonly revisions = new Map<string, number>();

  constructor(
    private readonly runtime: Runtime,
    private readonly events: EventBus,
    private readonly registry: Registry,
    private readonly resources: ResourceStore,
    private readonly context: Kernel["context"],
    /** True when the plugin is known (loaded) but not active. */
    private readonly isPluginDisabled: (pluginId: string) => boolean,
    /** Kinds a plugin may read (D10/D60): its own + those of `requires.plugins`. */
    private readonly readableKinds: (pluginId: string) => string[],
  ) {}

  inputFields(key: string, resource?: Resource): FieldDef[] {
    const input = this.registry.actionEntry(key)?.def.input;
    if (!input) return [];
    if (Array.isArray(input)) return input;
    const raw = resource?.body[input.fromField];
    if (!Array.isArray(raw)) return [];
    const fields: FieldDef[] = [];
    for (const item of raw) {
      const parsed = ParameterDefSchema.safeParse(item);
      if (!parsed.success) continue;
      const p = parsed.data;
      const field: FieldDef = { name: p.name, label: p.label || p.name, type: "text" };
      // A parameter with a default can always be filled, so only default-less required ones are required.
      if (p.required === true && p.default === undefined) field.required = true;
      if (p.default !== undefined) field.default = p.default;
      fields.push(field);
    }
    return fields;
  }

  lastResult(resourceId: string): ActionResult | undefined {
    return this.last.get(resourceId);
  }

  revision(resourceId: string): number {
    return this.revisions.get(resourceId) ?? 0;
  }

  running(): Array<{ runId: string; key: string; resourceId?: string; startedAt: string }> {
    return [...this.active.values()].map((r) => {
      const item: { runId: string; key: string; resourceId?: string; startedAt: string } = { runId: r.runId, key: r.key, startedAt: r.startedAt };
      if (r.resourceId !== undefined) item.resourceId = r.resourceId;
      return item;
    });
  }

  cancel(runId: string): void {
    this.active.get(runId)?.controller.abort(new OneDeskError("unavailable", "已取消"));
  }

  /** Aborts every running action of a plugin (called when it is disabled or uninstalled). */
  abortPlugin(pluginId: string): void {
    for (const run of this.active.values()) {
      if (run.pluginId === pluginId) run.controller.abort(new OneDeskError("unavailable", "插件已停用，动作已取消"));
    }
  }

  async run(key: string, args: RunArgs = {}): Promise<ActionResult> {
    const runId = this.runtime.randomId();
    const startedMs = this.runtime.now().getTime();
    const resourceId = args.resourceId;

    const finish = (status: ActionResult["status"], extra: { output?: ActionOutput; error?: ActionResult["error"] }): ActionResult => {
      const finished = this.runtime.now();
      const result: ActionResult = {
        runId,
        status,
        durationMs: Math.max(0, finished.getTime() - startedMs),
        action: key,
        finishedAt: finished.toISOString(),
        ...extra,
      };
      if (resourceId !== undefined) {
        result.resourceId = resourceId;
        this.last.set(resourceId, result);
        this.revisions.set(resourceId, this.revision(resourceId) + 1);
      }
      this.events.emit({ type: "action.completed", result });
      return result;
    };
    const fail = (e: unknown): ActionResult => finish("error", { error: toErrorInfo(e) });

    try {
      const entry = this.registry.actionEntry(key);
      if (!entry) {
        const owner = keyOwner(key);
        if (owner && this.isPluginDisabled(owner)) return fail(new OneDeskError("unavailable", "插件已停用，动作不可用", { hint: "在插件页启用后重试" }));
        return fail(new OneDeskError("not_found", `动作 ${key} 不存在`));
      }
      const def = entry.def;
      const kinds = def.kinds ?? [];

      let resource: Resource | undefined;
      if (resourceId !== undefined) {
        resource = (await this.resources.get(resourceId)) ?? undefined;
        if (!resource) return fail(new OneDeskError("not_found", "资源不存在"));
      }
      if (kinds.length > 0) {
        if (!resource) return fail(new OneDeskError("validation", "这个动作需要在资源上运行"));
        if (!kinds.includes(resource.kind)) return fail(new OneDeskError("validation", "这个动作不适用于该类型的资源"));
      } else if (resource && !this.readableKinds(entry.pluginId).includes(resource.kind)) {
        // D10: a global action receives the resource in its context, so its plugin must be allowed to read it.
        return fail(new OneDeskError("permission", `插件 ${entry.pluginId} 无权读取类型 ${resource.kind} 的资源`));
      }

      const rawInput = args.input ?? {};
      if (!isPlainObject(rawInput)) return fail(new OneDeskError("validation", "动作输入必须是对象"));
      const fields = this.inputFields(key, resource);
      const input = applyDefaults(fields, rawInput);
      const fieldErrors = validateFields(fields, input);
      if (Object.keys(fieldErrors).length) {
        return fail(new OneDeskError("validation", Object.values(fieldErrors).join("；"), { fields: fieldErrors }));
      }

      const controller = new AbortController();
      const run: Running = { runId, key, pluginId: entry.pluginId, startedAt: new Date(startedMs).toISOString(), controller };
      if (resourceId !== undefined) run.resourceId = resourceId;
      this.active.set(runId, run);
      const started: { type: "action.started"; runId: string; key: string; resourceId?: string } = { type: "action.started", runId, key };
      if (resourceId !== undefined) started.resourceId = resourceId;
      this.events.emit(started);

      const context: ActionContext = {
        workspace: this.context.workspace,
        user: this.context.user,
        source: args.source ?? "manual",
        signal: controller.signal,
      };
      if (resource) context.resource = resource;

      const ABORTED = Symbol("aborted");
      let raw: unknown;
      try {
        const aborted = new Promise<typeof ABORTED>((resolve) => {
          controller.signal.addEventListener("abort", () => resolve(ABORTED), { once: true });
        });
        // Start the plugin code in a microtask so a synchronous `run` cannot block the caller.
        const work = Promise.resolve().then(() => def.run(context, input));
        // If the run is abandoned after an abort, its late rejection must not become an unhandled rejection.
        work.catch(() => undefined);
        raw = await Promise.race([work, aborted]);
      } catch (e) {
        if (controller.signal.aborted) raw = ABORTED;
        else return fail(e);
      } finally {
        this.active.delete(runId);
      }
      if (raw === ABORTED || controller.signal.aborted) {
        const reason: unknown = controller.signal.reason;
        return finish("cancelled", { error: { code: "unavailable", message: reason instanceof Error ? reason.message : "已取消" } });
      }

      const parsed = ActionOutputSchema.safeParse(raw ?? { type: "none" });
      if (!parsed.success) return fail(new OneDeskError("validation", `动作输出格式不正确：${zodMessage(parsed.error)}`));
      const output = parsed.data;
      if (output.type !== "none" && output.type !== def.output) {
        return fail(new OneDeskError("validation", `动作输出类型与声明不符：声明 ${def.output}，实际 ${output.type}`));
      }
      return finish("success", { output });
    } catch (e) {
      this.active.delete(runId);
      return fail(e);
    }
  }
}
