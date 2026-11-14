/**
 * Search (D24): substring match over `search_text`, which the kernel writes with every resource.
 * Layout of search_text: `<name on one line>\n<description>\n<tags>\n<body strings>`, lower-cased with JS
 * toLowerCase (SQLite's lower() only handles ASCII). Because the name is always the first line, a term whose
 * first occurrence is before the first line break is a name hit.
 */

function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    if (value) out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
  } else if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) collectStrings(item, out);
  }
}

export function buildSearchText(resource: { name: string; description: string; tags: string[]; body: Record<string, unknown> }): string {
  const bodyStrings: string[] = [];
  collectStrings(resource.body, bodyStrings);
  const nameLine = resource.name.replace(/\s+/g, " ");
  return [nameLine, resource.description, resource.tags.join(" "), ...bodyStrings].join("\n").toLowerCase();
}

/** Whitespace-separated, lower-cased, de-duplicated terms. */
export function searchTerms(text: string): string[] {
  return [...new Set(text.toLowerCase().split(/\s+/).filter(Boolean))];
}

/** WHERE fragment + ORDER BY score expression for the given terms (terms must be non-empty). */
export function searchSql(terms: string[]): { where: string; whereParams: string[]; score: string; scoreParams: string[] } {
  const where = terms.map(() => "instr(search_text, ?) > 0").join(" AND ");
  // Rows already contain every term, so "first occurrence before the first line break" = name hit.
  const score = terms.map(() => "(instr(search_text, ?) < instr(search_text, char(10)))").join(" + ");
  return { where, whereParams: terms, score, scoreParams: terms };
}
