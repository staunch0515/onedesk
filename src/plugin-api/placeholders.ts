/**
 * The single placeholder syntax for OneDesk templates: `{{name}}` (D08).
 * Shared by the host and plugins so syntax cannot drift.
 */

const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
/** Anything that looks like a placeholder attempt in another syntax or malformed. */
const FOREIGN_SYNTAX: Array<{ re: RegExp; reason: string }> = [
  { re: /(^|[^$\w])\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/g, reason: "不支持 $name / ${name}，请写成 {{name}}" },
  { re: /(^|[\s(,=])(?<!:):[A-Za-z_][A-Za-z0-9_]*\b/g, reason: "不支持 :name，请写成 {{name}}" },
  { re: /\{\{(?!\s*[A-Za-z_][A-Za-z0-9_]*\s*\}\})/g, reason: "占位符格式不正确，应为 {{name}}" },
];

/** Names referenced by `{{name}}` placeholders, in order of first appearance. */
export function extractPlaceholders(template: string): string[] {
  const names: string[] = [];
  for (const m of template.matchAll(PLACEHOLDER)) {
    const name = m[1]!;
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

/** Problems in a template: foreign syntaxes and malformed placeholders. Errs on the side of rejecting. */
export function lintPlaceholders(template: string): string[] {
  const problems = new Set<string>();
  for (const { re, reason } of FOREIGN_SYNTAX) {
    if (new RegExp(re.source, re.flags).test(template)) problems.add(reason);
  }
  return [...problems];
}

/** Replace `{{name}}` with values; throws listing every missing name. */
export function fillPlaceholders(template: string, values: Record<string, unknown>): string {
  const missing = extractPlaceholders(template).filter((n) => values[n] === undefined || values[n] === null);
  if (missing.length) throw new Error(`缺少参数：${missing.join("、")}`);
  return template.replace(PLACEHOLDER, (_, name: string) => String(values[name]));
}
