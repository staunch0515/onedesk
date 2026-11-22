/**
 * Round 19: the narrowest exception to the banned word `ai` for the kernel-side check (scripts/check-arch.mjs).
 * The word stays banned as a plugin name (`org.onedesk.ai`, the id segment, prose about the AI plugin). Only these literal forms
 * of the *operator* `ai` (D415/D448) are removed from a line before the ban is applied:
 *   - Rust code (outside string literals), .rs files only: the variant `Actor::Ai`, its definition line `Ai { client … }`, and the
 *     bare identifier `ai` (the action's `ai` declaration / the operator parameter) unless it is the tail of a dotted id (`onedesk.ai`);
 *   - string literals: `"ai"`, `"ai:" and "ai:{name}" and "ai:tool" (the run target of an aiTool)` (operator id / run source / tab id), `"--ai-client"` (worker flag), and the prose of the tool
 *     descriptions: "to AI", "for AI", "an AI action", "the AI actor";
 *   - whole-line comments in .sql files (`-- …`).
 * Anything else (`org.onedesk.ai`, `anthropic`, "AI provider", a kind id …) still fails.
 */
const PROSE = /\b(?:visible to AI|chose for AI|an AI action|the AI actor)\b/g;
// exactly "ai", "ai:" and the format form "ai:{name}" (a bare identifier in braces) — nothing may follow the colon but that
const STR_LITERALS = /"ai(?::(?:\{[a-z_]*\}|tool)?)?"|--ai-client\b/g;

export function stripAllowedAi(line, file) {
  if (file.endsWith(".sql")) return /^\s*--/.test(line) ? "" : line; // whole-line comments only
  if (!file.endsWith(".rs")) return line;
  // odd segments are inside "…" string literals (good enough for one line; escaped quotes do not occur in the allowed forms)
  const parts = line.replace(STR_LITERALS, (m) => (m.startsWith("--") ? "--client" : '""')).replace(PROSE, "").split('"');
  return parts
    .map((seg, i) =>
      i % 2 === 1
        ? seg
        : seg
            .replace(/Actor::Ai\b/g, "Actor")
            .replace(/^\s*Ai \{ client\b/, "Variant { client")
            .replace(/(?<!onedesk\.)\bai\b/g, "operator"),
    )
    .join('"');
}
