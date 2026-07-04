// =============================================================================
// jsonl-parser.ts — stream-json / NDJSON parsers shared across CLIs.
//
// Scope:
//   • `parseClaudeStreamJson`            — Claude Code's
//     `--output-format stream-json --verbose` shape (assistant/result events).
//   • `parseGeminiStreamJson`            — Gemini 0.41.2's shape
//     (init/message/tool_use/tool_result/result events). Wave 2 Agent H.
//   • `geminiParsedToClaudeShape`        — convert Gemini parse → Claude
//     parse so wrapClaudeOutput stays unchanged downstream.
//   • `formatToolCallSummary` / `wrapClaudeOutput` — render parser output
//     into the `[[CLI_TOOL_CALLS]]` / `[[CLI_RESULT]]` envelope the reviewer
//     LLM expects.
//
// IMPORTANT — preserve EVERY load-bearing comment block. The Gemini parser
// comment chain (event-shape verified against the captured fixture, banner-
// line guard, missing-init fallback) is a contract test in commentary form;
// removing it makes future schema drift hard to debug.
// =============================================================================

import type { ParsedClaudeOutput, ParsedGeminiOutput, ToolCallRecord } from './types.js';

/**
 * Parse Claude Code's `--output-format stream-json --verbose` NDJSON stream.
 *
 * Defensive against:
 *  - partial / truncated lines (kept atomic per `\n`)
 *  - non-JSON lines (skipped silently — Claude Code occasionally emits a
 *    leading info banner before the JSON stream when the binary is wrapped
 *    in cmd.exe)
 *  - missing `result` event (falls back to last assistant text block)
 *
 * Tool calls are surfaced even on error so the reviewer can see what the CLI
 * attempted before failing.
 */
export function parseClaudeStreamJson(stdout: string): ParsedClaudeOutput {
  const toolCalls: ToolCallRecord[] = [];
  let finalText = '';
  let isError = false;
  let errorReason: string | null = null;
  let lastAssistantText = '';

  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof event !== 'object' || event === null) continue;
    const ev = event as Record<string, unknown>;

    if (ev['type'] === 'assistant') {
      const message = ev['message'] as Record<string, unknown> | undefined;
      const content = message?.['content'];
      if (Array.isArray(content)) {
        let textForThisTurn = '';
        for (const block of content) {
          if (typeof block !== 'object' || block === null) continue;
          const b = block as Record<string, unknown>;
          if (b['type'] === 'tool_use' && typeof b['name'] === 'string') {
            const input = (b['input'] as Record<string, unknown> | undefined) ?? {};
            toolCalls.push({ name: b['name'], input });
          } else if (b['type'] === 'text' && typeof b['text'] === 'string') {
            textForThisTurn += b['text'];
          }
        }
        if (textForThisTurn) lastAssistantText = textForThisTurn;
      }
    } else if (ev['type'] === 'result') {
      if (typeof ev['result'] === 'string') finalText = ev['result'];
      if (ev['is_error'] === true) isError = true;
      if (typeof ev['subtype'] === 'string' && ev['subtype'] !== 'success') {
        errorReason = String(ev['subtype']);
      }
    }
  }

  if (!finalText) finalText = lastAssistantText;
  return { toolCalls, finalText, isError, errorReason };
}

/**
 * Render a human-readable summary of tool calls. Format is intentionally
 * line-based so the reviewer LLM can pattern-match (e.g. "count Agent
 * invocations", "verify subagent_type contains X").
 */
export function formatToolCallSummary(calls: ToolCallRecord[]): string {
  if (calls.length === 0) return '(no tool calls captured)';
  const lines: string[] = [];
  for (const tc of calls) {
    if (tc.name === 'Agent') {
      const sub = String(tc.input['subagent_type'] ?? 'general-purpose');
      const desc = String(tc.input['description'] ?? '').slice(0, 100);
      lines.push(`- Agent (subagent_type=${sub})${desc ? `: "${desc}"` : ''}`);
    } else {
      // Compact one-line form for non-Agent tools to keep the header short.
      // We only need to PROVE work happened, not log every parameter.
      const keys = Object.keys(tc.input).slice(0, 3).join(',');
      lines.push(`- ${tc.name}${keys ? ` (${keys})` : ''}`);
    }
  }
  return lines.join('\n');
}

export function parseGeminiStreamJson(stdout: string): ParsedGeminiOutput {
  const toolCalls: ToolCallRecord[] = [];
  const unknownTypes = new Set<string>();
  let sessionId: string | null = null;
  let finalText = '';
  let isError = false;
  let errorReason: string | null = null;
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    // Cheap guard: skip banner lines without spending JSON.parse on them.
    if (!trimmed || trimmed[0] !== '{') continue;
    let event: unknown;
    try { event = JSON.parse(trimmed); } catch { continue; }
    if (typeof event !== 'object' || event === null) continue;
    const ev = event as Record<string, unknown>;
    const type = ev['type'];
    if (type === 'init') {
      if (typeof ev['session_id'] === 'string') sessionId = ev['session_id'];
    } else if (type === 'message') {
      // Gemini emits assistant text as multiple delta events. Concatenate
      // every assistant message.content into finalText. (Skip role=user —
      // that's the echo of our prompt.)
      if (ev['role'] === 'assistant' && typeof ev['content'] === 'string') {
        finalText += ev['content'];
      }
    } else if (type === 'tool_use') {
      const name = typeof ev['tool_name'] === 'string' ? ev['tool_name'] : 'unknown';
      const params = ev['parameters'];
      const input = (params !== null && typeof params === 'object')
        ? params as Record<string, unknown>
        : {};
      toolCalls.push({ name, input });
    } else if (type === 'tool_result') {
      // Observed but not surfaced in the Claude-shape adapter — the reviewer
      // gets the tool_call summary; stdout echo of the result is enough.
    } else if (type === 'result') {
      if (typeof ev['status'] === 'string' && ev['status'] !== 'success') {
        isError = true;
        errorReason = String(ev['status']);
      }
    } else if (typeof type === 'string') {
      unknownTypes.add(type);
    }
  }
  return {
    sessionId,
    finalText: finalText.trim(),
    toolCalls,
    isError,
    errorReason,
    unknownTypes: [...unknownTypes],
  };
}

/**
 * Adapter: shape the Gemini parsed result like Claude's so downstream
 * wrapClaudeOutput keeps working unchanged. Used by runCliTask when
 * cliId === 'gemini' and stream-json is enabled.
 *
 * The output deliberately drops Gemini-specific fields (sessionId,
 * unknownTypes) — those flow back to the runtime store via separate
 * appendRuntime calls, not the wrapped reviewer payload.
 */
export function geminiParsedToClaudeShape(parsed: ParsedGeminiOutput): ParsedClaudeOutput {
  return {
    toolCalls: parsed.toolCalls,
    finalText: parsed.finalText,
    isError: parsed.isError,
    errorReason: parsed.errorReason,
  };
}

/**
 * Wrap a parsed Claude Code result as the string the rest of the system
 * expects. Header is self-documenting so the reviewer LLM understands what
 * the [[CLI_TOOL_CALLS]] section means without prompt changes.
 */
export function wrapClaudeOutput(parsed: ParsedClaudeOutput): string {
  const summary = formatToolCallSummary(parsed.toolCalls);
  const body = parsed.finalText || '(empty result)';
  const header = parsed.isError
    ? `[[CLI_TOOL_CALLS]] (CLI reported is_error=true${parsed.errorReason ? `, subtype=${parsed.errorReason}` : ''})`
    : '[[CLI_TOOL_CALLS]]';
  return `${header}\n${summary}\n[[CLI_RESULT]]\n${body}`;
}
