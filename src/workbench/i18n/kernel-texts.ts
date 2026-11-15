/**
 * Words for what the kernel names by id (D262, D219): its own commands, trees and types arrive as
 * plain ids (`node.rename`, `resources`, `core:group`) and error codes carry no text. Unknown ids
 * are shown as they are. Plugin text never lives here: it comes as a Label.
 */
import type { Locale } from "../protocol/types";

type Table = Record<string, string>;

export const KERNEL_LABELS: Record<Locale, Table> = {
  "en-US": {
    "node.open": "Open",
    "node.rename": "Rename",
    "node.newGroup": "New group",
    "node.delete": "Delete",
    "plugin.grantFolder": "Grant a folder…",
    resources: "Resources",
    "core:group": "Group",
  },
  "zh-CN": {
    "node.open": "打开",
    "node.rename": "重命名",
    "node.newGroup": "新建分组",
    "node.delete": "删除",
    "plugin.grantFolder": "授权文件夹…",
    resources: "资源",
    "core:group": "分组",
  },
};

export const KERNEL_ERRORS: Record<Locale, Table> = {
  "en-US": {
    versionMismatch: "The app and the workspace service use different protocol versions.",
    unknownMethod: "The workspace service does not know “{method}”.",
    invalidParams: "The request was malformed.",
    notFound: "It no longer exists.",
    conflict: "This was changed elsewhere after you opened it. Reload to see the new value; your edits are still here.",
    denied: "Not allowed.",
    invalid: "That is not allowed here.",
    unsupported: "Not available yet.",
    pluginError: "The plugin failed to produce this page.",
    pluginTimeout: "The plugin took too long to answer.",
    workerGone: "The workspace service stopped and is restarting. Try again in a moment.",
    internal: "Something went wrong inside the workspace service.",
  },
  "zh-CN": {
    versionMismatch: "应用与工作区服务的协议版本不一致。",
    unknownMethod: "工作区服务不认识“{method}”。",
    invalidParams: "请求格式不对。",
    notFound: "它已经不存在了。",
    conflict: "你打开之后，这里被别处改过了。重新加载可以看到新的值；你的修改还保留着。",
    denied: "不允许。",
    invalid: "这里不允许这样做。",
    unsupported: "暂未提供。",
    pluginError: "插件没能生成这个页面。",
    pluginTimeout: "插件响应太慢。",
    workerGone: "工作区服务已停止，正在重启，请稍后再试。",
    internal: "工作区服务内部出错。",
  },
};

export function interpolate(text: string, vars: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => vars[name] ?? whole);
}
