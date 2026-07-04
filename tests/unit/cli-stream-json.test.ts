import { describe, it, expect } from 'vitest';
import {
  parseClaudeStreamJson,
  formatToolCallSummary,
  wrapClaudeOutput,
} from '../../src/executors/cli.js';

// Helper: serialise a list of stream-json events as Claude Code would
// (one JSON per line). Matches the real --output-format stream-json format.
function ndjson(events: Array<Record<string, unknown>>): string {
  return events.map(e => JSON.stringify(e)).join('\n');
}

describe('parseClaudeStreamJson', () => {
  it('extracts Agent tool_use events with subagent_type', () => {
    const stream = ndjson([
      { type: 'system', subtype: 'init' },
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'I will dispatch three subagents.' },
            {
              type: 'tool_use',
              id: 'a1',
              name: 'Agent',
              input: { subagent_type: 'Explore', description: 'map src/ structure', prompt: '...' },
            },
            {
              type: 'tool_use',
              id: 'a2',
              name: 'Agent',
              input: { subagent_type: 'code-reviewer', description: 'top 5 issues' },
            },
          ],
        },
      },
      {
        type: 'result',
        subtype: 'success',
        result: '## Synthesis\n- Map: ...\n- Review: ...',
        is_error: false,
      },
    ]);
    const parsed = parseClaudeStreamJson(stream);
    expect(parsed.toolCalls).toHaveLength(2);
    expect(parsed.toolCalls[0]?.name).toBe('Agent');
    expect(parsed.toolCalls[0]?.input['subagent_type']).toBe('Explore');
    expect(parsed.toolCalls[1]?.input['subagent_type']).toBe('code-reviewer');
    expect(parsed.finalText).toContain('## Synthesis');
    expect(parsed.isError).toBe(false);
  });

  it('extracts non-Agent tool_use events too (Read, Write, Bash, etc.)', () => {
    const stream = ndjson([
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: '1', name: 'Read', input: { file_path: '/a/b.ts' } },
            { type: 'tool_use', id: '2', name: 'Bash', input: { command: 'ls' } },
            { type: 'tool_use', id: '3', name: 'Write', input: { file_path: '/c.ts', content: '...' } },
          ],
        },
      },
      { type: 'result', subtype: 'success', result: 'done', is_error: false },
    ]);
    const parsed = parseClaudeStreamJson(stream);
    expect(parsed.toolCalls.map(t => t.name)).toEqual(['Read', 'Bash', 'Write']);
  });

  it('returns empty toolCalls and final text when there are zero tool_use events', () => {
    // This is exactly the failure mode that broke t1 in wf_9fcc6482 — Claude
    // produced text output without any subagent dispatches. The parser must
    // surface this faithfully so the reviewer can fail the H16 contract.
    const stream = ndjson([
      {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'Here is my synthesized report.' }],
        },
      },
      { type: 'result', subtype: 'success', result: 'Final report', is_error: false },
    ]);
    const parsed = parseClaudeStreamJson(stream);
    expect(parsed.toolCalls).toHaveLength(0);
    expect(parsed.finalText).toBe('Final report');
  });

  it('falls back to last assistant text when result event is absent', () => {
    const stream = ndjson([
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'first turn' }] },
      },
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'second turn (the final one)' }] },
      },
    ]);
    const parsed = parseClaudeStreamJson(stream);
    expect(parsed.finalText).toBe('second turn (the final one)');
  });

  it('skips non-JSON lines (info banners, blank lines)', () => {
    const stream = [
      'Welcome to Claude Code v1.x',
      '',
      JSON.stringify({ type: 'result', subtype: 'success', result: 'ok', is_error: false }),
      '',
    ].join('\n');
    const parsed = parseClaudeStreamJson(stream);
    expect(parsed.finalText).toBe('ok');
    expect(parsed.isError).toBe(false);
  });

  it('captures is_error and errorReason from result event', () => {
    const stream = ndjson([
      { type: 'result', subtype: 'error_max_turns', result: 'partial', is_error: true },
    ]);
    const parsed = parseClaudeStreamJson(stream);
    expect(parsed.isError).toBe(true);
    expect(parsed.errorReason).toBe('error_max_turns');
  });

  it('still surfaces tool calls when the run errored — auditability beats cleanliness', () => {
    const stream = ndjson([
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: '1', name: 'Agent', input: { subagent_type: 'Explore' } },
          ],
        },
      },
      { type: 'result', subtype: 'error_max_turns', result: '', is_error: true },
    ]);
    const parsed = parseClaudeStreamJson(stream);
    expect(parsed.toolCalls).toHaveLength(1);
    expect(parsed.isError).toBe(true);
  });

  it('handles empty input gracefully', () => {
    const parsed = parseClaudeStreamJson('');
    expect(parsed.toolCalls).toEqual([]);
    expect(parsed.finalText).toBe('');
    expect(parsed.isError).toBe(false);
  });
});

describe('formatToolCallSummary', () => {
  it('renders Agent calls with subagent_type and description', () => {
    const out = formatToolCallSummary([
      { name: 'Agent', input: { subagent_type: 'Explore', description: 'map src/' } },
      { name: 'Agent', input: { subagent_type: 'code-reviewer', description: 'find issues' } },
    ]);
    expect(out).toContain('Agent (subagent_type=Explore)');
    expect(out).toContain('"map src/"');
    expect(out).toContain('Agent (subagent_type=code-reviewer)');
  });

  it('renders non-Agent tools with input keys for compactness', () => {
    const out = formatToolCallSummary([
      { name: 'Read', input: { file_path: '/x' } },
      { name: 'Bash', input: { command: 'ls', timeout: 5000 } },
    ]);
    expect(out).toContain('- Read (file_path)');
    expect(out).toContain('- Bash (command,timeout)');
  });

  it('reports the "no calls" placeholder when empty', () => {
    expect(formatToolCallSummary([])).toBe('(no tool calls captured)');
  });
});

describe('wrapClaudeOutput', () => {
  it('produces the [[CLI_TOOL_CALLS]] / [[CLI_RESULT]] envelope', () => {
    const wrapped = wrapClaudeOutput({
      toolCalls: [{ name: 'Agent', input: { subagent_type: 'Explore' } }],
      finalText: 'final synthesis',
      isError: false,
      errorReason: null,
    });
    expect(wrapped.startsWith('[[CLI_TOOL_CALLS]]')).toBe(true);
    expect(wrapped).toContain('[[CLI_RESULT]]');
    expect(wrapped).toContain('Agent (subagent_type=Explore)');
    expect(wrapped).toContain('final synthesis');
  });

  it('annotates the header when CLI reported an error', () => {
    const wrapped = wrapClaudeOutput({
      toolCalls: [],
      finalText: '',
      isError: true,
      errorReason: 'error_max_turns',
    });
    expect(wrapped).toContain('is_error=true');
    expect(wrapped).toContain('subtype=error_max_turns');
  });

  it('substitutes "(empty result)" for blank final text so the reviewer sees something', () => {
    const wrapped = wrapClaudeOutput({
      toolCalls: [],
      finalText: '',
      isError: false,
      errorReason: null,
    });
    expect(wrapped).toContain('(empty result)');
  });
});
