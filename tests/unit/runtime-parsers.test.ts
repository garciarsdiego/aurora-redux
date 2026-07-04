import { describe, expect, it } from 'vitest';

import {
  normalizeRuntimeJsonLine,
  normalizeTailEvents,
} from '../../src/runtime/parsers.js';

describe('runtime event normalization', () => {
  it('normalizes Claude stream-json assistant text and tool calls', () => {
    const events = normalizeRuntimeJsonLine(
      'cli:claude-code',
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'ok' },
            { type: 'tool_use', id: 'tool_1', name: 'Write', input: { file_path: 'src/app.ts' } },
          ],
        },
      }),
    );

    expect(events.map((event) => event.type)).toEqual(['assistant.message', 'tool.call.started']);
    expect(events[1]).toMatchObject({ toolName: 'Write', toolCallId: 'tool_1' });
  });

  it('normalizes Codex JSONL function-call events', () => {
    const events = normalizeRuntimeJsonLine(
      'cli:codex',
      JSON.stringify({
        ts: 1778170568361,
        payload: {
          type: 'function_call',
          name: 'shell',
          arguments: JSON.stringify({ command: 'pnpm test' }),
        },
      }),
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'tool.call.started',
      executorId: 'cli:codex',
      toolName: 'shell',
      toolInput: { command: 'pnpm test' },
    });
  });

  it('normalizes text fallback parser events for Gemini and OpenCode', () => {
    const gemini = normalizeTailEvents('cli:gemini', [
      { ts: 1, kind: 'message', role: 'assistant', text: 'Gemini result' },
    ]);
    const opencode = normalizeTailEvents('cli:opencode', [
      { ts: 2, kind: 'meta', text: 'stderr: warning' },
    ]);

    expect(gemini[0]).toMatchObject({ type: 'assistant.message', text: 'Gemini result' });
    expect(opencode[0]).toMatchObject({ type: 'runtime.meta', text: 'stderr: warning' });
  });

  it('returns structured parser errors for malformed JSON without leaking secrets', () => {
    const events = normalizeRuntimeJsonLine('cli:codex', 'not-json sk-runtime-secret-value');

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('runtime.error');
    expect(JSON.stringify(events)).not.toContain('sk-runtime-secret-value');
    expect(JSON.stringify(events)).toContain('***REDACTED***');
  });
});
