/**
 * Helpers for inspecting CLI tool-call traces.
 *
 * Worker.cli_spawn outputs include a `tool_calls` array reported by the CLI
 * harness. The reviewer + the worker's own postHook need to answer:
 *   - did the worker actually call Write/Edit?
 *   - which files were written?
 *   - did the worker only Read without ever writing?
 *
 * Centralising these checks keeps the matchers consistent across personas.
 */

export interface ToolCallTraceEntry {
  name: string;
  args_summary?: string;
  result_summary?: string;
}

/**
 * Names that count as "the worker actually wrote a file".
 * Covers Claude/Codex/Cursor/Kimi/Gemini/Opencode aliases — keep this list
 * inclusive since CLIs report tool names with slightly different casing or
 * synonyms (str_replace, patch, create_file).
 */
const WRITE_TOOL_NAMES = [
  'write',
  'edit',
  'multiedit',
  'str_replace',
  'patch',
  'apply_patch',
  'create_file',
  'modify_file',
  'overwrite_file',
  'file_write',
] as const;

const WRITE_TOOL_RE = new RegExp(`^(?:${WRITE_TOOL_NAMES.join('|')})$`, 'i');

export function isWriteTool(name: string): boolean {
  return WRITE_TOOL_RE.test(name);
}

export function hasWriteTool(trace: readonly ToolCallTraceEntry[] | undefined | null): boolean {
  if (!trace || trace.length === 0) return false;
  return trace.some((t) => isWriteTool(t.name));
}

export function listToolNames(trace: readonly ToolCallTraceEntry[] | undefined | null): string[] {
  if (!trace) return [];
  return trace.map((t) => t.name);
}

/**
 * Heuristic: does the acceptance criterion text imply that the worker MUST
 * write at least one file? We match on imperatives + file references; intent is
 * lenient (overdetect rather than miss). False positives here only force the
 * worker to call Write — that's almost always desirable for cli_spawn tasks.
 */
const REQUIRES_WRITE_RE = /\b(create|implement|write|modify|update|generate|produce|add)\b[^.]{0,80}\b(file|component|module|class|function|endpoint|route|page|migration|test|test\s+file|.tsx?|.rs|.py|.go)\b/i;

const FILE_PATH_RE = /(?:[\w./-]+\/)+[\w.-]+\.(?:tsx?|jsx?|html?|rs|py|go|java|kt|swift|sql|md|yaml|json|css|scss|tf|sh|bash)/i;

export function requiresWrite(acceptanceCriteria: string | null | undefined): boolean {
  if (!acceptanceCriteria) return false;
  if (REQUIRES_WRITE_RE.test(acceptanceCriteria)) return true;
  // Fallback: explicit file path mentioned along with "exists" / "contains" / "exports"
  return FILE_PATH_RE.test(acceptanceCriteria) && /\b(exists?|contains|exports?|defines?)\b/i.test(acceptanceCriteria);
}

/**
 * Best-effort extraction of file paths from acceptance criteria. Used by the
 * worker preHook to back up stale stubs from prior attempts before retry.
 */
export function extractFilePathsFromAcceptance(acceptanceCriteria: string): string[] {
  const matches = acceptanceCriteria.match(new RegExp(FILE_PATH_RE.source, 'gi'));
  return matches ? Array.from(new Set(matches.map((s) => s.trim()))) : [];
}
