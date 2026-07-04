import { describe, expect, it } from 'vitest';

import {
  geminiParsedToClaudeShape,
  parseGeminiStreamJson,
} from '../../src/executors/cli.js';
import { getRuntimeExecutorCapability } from '../../src/runtime/capabilities.js';

// Wave 2 Agent H — Task 8A.2 IMPL.
//
// Tests pin the parser + capability surface against the real captured shape
// of gemini-cli 0.41.2 (`gemini --yolo --output-format stream-json -p ...`).
// Sample lives in _artifacts/runtime-resume-harness/gemini-stream-json-sample.txt.
//
// These tests intentionally use mock NDJSON strings rather than spawning the
// real CLI: vitest CI must stay hermetic, and the sample-driven shape covers
// the contract.

describe('parseGeminiStreamJson', () => {
  it('extracts session_id from init, concatenates assistant deltas, and surfaces tool_use calls', () => {
    const stdout = [
      // Banner that gemini 0.41.2 prints to stdout BEFORE the NDJSON. Parser
      // must skip non-JSON lines.
      'YOLO mode is enabled. All tool calls will be automatically approved.',
      'Ripgrep is not available. Falling back to GrepTool.',
      JSON.stringify({
        type: 'init',
        timestamp: '2026-05-10T04:18:51.728Z',
        session_id: '22222222-2222-3333-4444-555555555555',
        model: 'gemini-3-flash-preview',
      }),
      JSON.stringify({
        type: 'message',
        timestamp: '2026-05-10T04:18:51.729Z',
        role: 'user',
        content: 'list files in current directory using a tool call',
      }),
      JSON.stringify({
        type: 'tool_use',
        timestamp: '2026-05-10T04:18:53.235Z',
        tool_name: 'list_directory',
        tool_id: 'list_directory_1778386733234_0',
        parameters: { dir_path: '.' },
      }),
      JSON.stringify({
        type: 'tool_result',
        timestamp: '2026-05-10T04:18:53.326Z',
        tool_id: 'list_directory_1778386733234_0',
        status: 'success',
        output: 'Directory is empty.',
      }),
      JSON.stringify({
        type: 'message',
        timestamp: '2026-05-10T04:18:54.700Z',
        role: 'assistant',
        content: 'The current directory ',
        delta: true,
      }),
      JSON.stringify({
        type: 'message',
        timestamp: '2026-05-10T04:18:54.710Z',
        role: 'assistant',
        content: 'is empty.',
        delta: true,
      }),
      JSON.stringify({
        type: 'result',
        timestamp: '2026-05-10T04:18:54.827Z',
        status: 'success',
        stats: { total_tokens: 43064, tool_calls: 1 },
      }),
    ].join('\n');

    const parsed = parseGeminiStreamJson(stdout);

    expect(parsed.sessionId).toBe('22222222-2222-3333-4444-555555555555');
    expect(parsed.finalText).toBe('The current directory is empty.');
    expect(parsed.toolCalls).toEqual([
      { name: 'list_directory', input: { dir_path: '.' } },
    ]);
    expect(parsed.isError).toBe(false);
    expect(parsed.errorReason).toBeNull();
    expect(parsed.unknownTypes).toEqual([]);
  });

  it('falls back to null sessionId when init is absent and surfaces non-success result as error', () => {
    const stdout = [
      JSON.stringify({
        type: 'message',
        role: 'assistant',
        content: 'Partial answer before crash.',
      }),
      JSON.stringify({
        type: 'result',
        status: 'error',
        stats: {},
      }),
    ].join('\n');

    const parsed = parseGeminiStreamJson(stdout);

    expect(parsed.sessionId).toBeNull();
    expect(parsed.finalText).toBe('Partial answer before crash.');
    expect(parsed.isError).toBe(true);
    expect(parsed.errorReason).toBe('error');
    // Caller (harness) is responsible for falling back to the explicit
    // --session-id UUID when sessionId is null. The parser does not invent
    // an id.
  });

  it('tracks unknown event types instead of throwing on schema additions', () => {
    const stdout = [
      JSON.stringify({ type: 'init', session_id: 'abc' }),
      JSON.stringify({ type: 'experimental_metric', payload: { x: 1 } }),
      JSON.stringify({ type: 'reasoning_trace', summary: 'thinking...' }),
      JSON.stringify({ type: 'result', status: 'success' }),
    ].join('\n');

    const parsed = parseGeminiStreamJson(stdout);

    expect(parsed.sessionId).toBe('abc');
    expect(parsed.unknownTypes).toEqual(
      expect.arrayContaining(['experimental_metric', 'reasoning_trace']),
    );
    expect(parsed.isError).toBe(false);
  });

  it('adapter geminiParsedToClaudeShape drops gemini-only fields and matches Claude shape', () => {
    const parsed = parseGeminiStreamJson(
      [
        JSON.stringify({ type: 'init', session_id: 'sess-1' }),
        JSON.stringify({ type: 'message', role: 'assistant', content: 'hi' }),
        JSON.stringify({ type: 'tool_use', tool_name: 'WriteFile', parameters: { path: 'a.ts' } }),
        JSON.stringify({ type: 'result', status: 'success' }),
      ].join('\n'),
    );
    const adapted = geminiParsedToClaudeShape(parsed);

    expect(adapted).toEqual({
      toolCalls: [{ name: 'WriteFile', input: { path: 'a.ts' } }],
      finalText: 'hi',
      isError: false,
      errorReason: null,
    });
    expect(Object.keys(adapted)).not.toContain('sessionId');
    expect(Object.keys(adapted)).not.toContain('unknownTypes');
  });
});

describe('runtime capability registration for gemini stream-json', () => {
  it('exposes the experimental jsonl-headless tier without disturbing text-pty-fallback or acp-stdio', () => {
    const gemini = getRuntimeExecutorCapability('cli:gemini');
    expect(gemini).toBeDefined();

    // Default protocol must remain text-pty-fallback (Wave 2 plan: opt-in
    // only, defaultProtocolTier MUST NOT change in this slice).
    expect(gemini?.defaultProtocolTier).toBe('text-pty-fallback');

    const tiers = gemini?.protocols.map((p) => p.tier) ?? [];
    expect(tiers).toEqual(expect.arrayContaining([
      'text-pty-fallback',
      'jsonl-headless',
      'acp-stdio',
    ]));

    const jsonl = gemini?.protocols.find((p) => p.tier === 'jsonl-headless');
    expect(jsonl?.status).toBe('experimental');
    expect(jsonl?.streamFormat).toBe('gemini-stream-json');
    expect(jsonl?.promptDelivery).toBe('arg');
    expect(jsonl?.supports).toMatchObject({
      resume: true,
      explicitSessionId: true,
      toolEvents: true,
      structuredOutput: true,
    });

    // ACP tier remains planned (Phase 8C — must not be touched here).
    const acp = gemini?.protocols.find((p) => p.tier === 'acp-stdio');
    expect(acp?.status).toBe('planned');
  });
});
