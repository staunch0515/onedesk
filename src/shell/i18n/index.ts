import { zhCN, type MessageKey } from "./zh-CN";

export type { MessageKey };

/** Looks up a UI string and fills `{{name}}` placeholders. Unknown placeholders are left as written. */
export function t(key: MessageKey, vars?: Record<string, string | number>): string {
  const template: string = zhCN[key];
  if (!vars) return template;
  return template.replace(/\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match,
  );
}
