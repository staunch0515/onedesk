/**
 * A fake plugin (`org.test.sample`, kind `sample`) for kernel and shell tests. It exists only in tests and is not
 * one of the built-in plugins; it exercises every part of the public plugin API.
 */
import { OneDeskError } from "../../plugin-api";
import type { ActionDefinition, HostApi, KindDefinition, ManifestInput, PluginModule, ViewDefinition } from "../../plugin-api";
import type { PluginSource } from "../contracts";
import { pluginSource } from "./index";

export const SAMPLE_ID = "org.test.sample";
export const SAMPLE_KIND = "sample";

export function sampleManifest(overrides: Partial<ManifestInput> = {}): ManifestInput {
  return {
    id: SAMPLE_ID,
    name: "示例",
    version: "1.0.0",
    apiVersion: "1",
    provides: { kinds: [SAMPLE_KIND], actions: ["echo", "fail", "slow", "wrong", "fill", "hello"], views: ["summary", "broken"] },
    requires: { network: ["api.example.com", "*.example.org"], secrets: ["sample_token"], plugins: [] },
    settings: [{ name: "greeting", label: "问候语", type: "text", default: "你好" }],
    ...overrides,
  };
}

export const sampleKind: KindDefinition = {
  id: SAMPLE_KIND,
  name: "示例",
  icon: "box",
  schema: [
    { name: "url", label: "网址", type: "url", required: true },
    { name: "note", label: "备注", type: "longtext" },
    { name: "count", label: "数量", type: "number" },
    { name: "flag", label: "开关", type: "boolean" },
    { name: "mode", label: "模式", type: "select", options: [{ value: "a", label: "甲" }, { value: "b", label: "乙" }] },
    { name: "ref", label: "引用", type: "reference" },
    { name: "params", label: "参数", type: "parameter" },
  ],
  defaultAction: "echo",
  views: ["summary", "broken"],
  describe: (resource) => ({ summary: resource.name, usage: "测试用" }),
  validate: (body) => (body.note === "bad" ? { note: "备注不能是 bad" } : {}),
};

export interface SamplePlugin {
  source: PluginSource;
  module: PluginModule;
  /** The HostApi passed to the latest `activate` call. */
  host(): HostApi;
  activations: number;
  deactivations: number;
  /** Resolves the pending `slow` action (if any). */
  releaseSlow(): void;
}

export function createSamplePlugin(
  options: {
    manifest?: Partial<ManifestInput>;
    origin?: PluginSource["origin"];
    /** Replace the default registrations. */
    activate?: (host: HostApi) => void | Promise<void>;
  } = {},
): SamplePlugin {
  let current: HostApi | undefined;
  let release: (() => void) | undefined;

  const actions: ActionDefinition[] = [
    {
      id: "echo",
      label: "回显",
      kinds: [SAMPLE_KIND],
      input: [{ name: "text", label: "文本", type: "text", required: true }, { name: "suffix", label: "后缀", type: "text", default: "!" }],
      output: "text",
      run: (context, input) => ({ type: "text", text: `${context.resource?.name}:${String(input.text)}${String(input.suffix)}` }),
    },
    {
      id: "fail",
      label: "失败",
      kinds: [SAMPLE_KIND],
      output: "none",
      run: (_context, input) => {
        if (input.plain) throw new Error("普通错误");
        throw new OneDeskError("unavailable", "服务不可用", { hint: "稍后重试" });
      },
    },
    {
      id: "slow",
      label: "慢动作",
      kinds: [SAMPLE_KIND],
      output: "none",
      run: () =>
        new Promise((resolve) => {
          release = () => resolve({ type: "none", message: "完成" });
        }),
    },
    { id: "wrong", label: "类型不符", kinds: [SAMPLE_KIND], output: "text", run: () => ({ type: "link", href: "https://example.com" }) },
    {
      id: "fill",
      label: "填充",
      kinds: [SAMPLE_KIND],
      input: { fromField: "params" },
      output: "text",
      run: (_context, input) => ({ type: "text", text: JSON.stringify(input) }),
    },
    { id: "hello", label: "问候", output: "text", run: () => ({ type: "text", text: "你好" }) },
  ];
  const views: ViewDefinition[] = [
    {
      id: "summary",
      label: "概览",
      render: (resource, state) => [
        { type: "text", text: `${resource.name} r${state.revision}` },
        { type: "form", fields: [{ label: "上次结果", value: state.lastResult?.status ?? null }] },
      ],
    },
    {
      id: "broken",
      label: "坏视图",
      render: (resource) => {
        if (resource.name === "抛错") throw new Error("渲染出错");
        return { type: "link", href: "javascript:alert(1)" } as never;
      },
    },
  ];

  const plugin: SamplePlugin = {
    source: undefined as unknown as PluginSource,
    module: {
      async activate(host) {
        current = host;
        plugin.activations += 1;
        if (options.activate) return options.activate(host);
        host.resources.registerKind(sampleKind);
        for (const action of actions) host.actions.register(action);
        for (const view of views) host.ui.registerView(view);
        host.ui.registerMenuItem({ id: "hello", label: "问候", action: "hello" });
      },
      deactivate() {
        plugin.deactivations += 1;
      },
    },
    host() {
      if (!current) throw new Error("示例插件还没有激活");
      return current;
    },
    activations: 0,
    deactivations: 0,
    releaseSlow() {
      release?.();
    },
  };
  plugin.source = pluginSource(sampleManifest(options.manifest), plugin.module, { origin: options.origin ?? "builtin" });
  return plugin;
}
