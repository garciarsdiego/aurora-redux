// src/v2/advisors/shared/promptBuilder.ts
// Mirrors the PAL MCP Server section-separator style (═══ lines).

const SEPARATOR = '═'.repeat(60);

/**
 * Joins prompt sections with PAL-style ═══ separator lines.
 * Empty/whitespace-only parts are skipped.
 */
export function buildSystemPrompt(parts: string[]): string {
  return parts
    .filter((p) => p.trim().length > 0)
    .join(`\n${SEPARATOR}\n`);
}
