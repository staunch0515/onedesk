/**
 * The single placeholder syntax for OneDesk templates: `{{name}}` (D08).
 * Shared by the host and plugins so syntax cannot drift.
 * Note: no regex lookbehind here — it is a SyntaxError on macOS 11/12 WebKit.
 */

const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

export interface PlaceholderLint {
  /** Malformed `{{…}}` — the template cannot be filled correctly. Blocks saving. */
  errors: string[];
  /** Looks like a placeholder in another syntax (`$name`, `${name}`, `:name`); will NOT be replaced. Shown, not blocking. */
  warnings: string[];
}

/** Names referenced by `{{name}}` placeholders, in order of first appearance. */
export function extractPlaceholders(template: string): string[] {
  const names: string[] = [];
  for (const m of template.matchAll(PLACEHOLDER)) {
    const name = m[1]!;
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

/** Check a template. Errs on the side of flagging. */
export function lintPlaceholders(template: string): PlaceholderLint {
  const errors: string[] = [];
  const warnings: string[] = [];
  // Every `{{` must start a well-formed placeholder.
  const stripped = template.replace(PLACEHOLDER, "");
  if (stripped.includes("{{")) errors.push("占位符格式不正确，应为 {{name}}（名字由字母、数字、下划线组成，不以数字开头）");
  if (/(^|[^$\w])\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/.test(stripped)) warnings.push("$name / ${name} 不会被替换，参数请写成 {{name}}");
  if (/(^|[\s(,=]):[A-Za-z_][A-Za-z0-9_]*\b/.test(stripped)) warnings.push(":name 不会被替换，参数请写成 {{name}}");
  return { errors, warnings };
}

/** Replace `{{name}}` with values; throws listing every missing name. */
export function fillPlaceholders(template: string, values: Record<string, unknown>): string {
  const missing = extractPlaceholders(template).filter((n) => values[n] === undefined || values[n] === null);
  if (missing.length) throw new Error(`缺少参数：${missing.join("、")}`);
  return template.replace(PLACEHOLDER, (_, name: string) => String(values[name]));
}
