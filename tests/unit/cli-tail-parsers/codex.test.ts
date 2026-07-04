import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import codexParser from '../../../src/v2/cli-tail/parsers/codex.js';

// codex.ts was already implemented before this task — these tests guard
// against regressions when the shared helpers it could later adopt change.

describe('codex tail parser', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'omniforge-cli-tail-codex-'));
  });

  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('happy path: rollout JSONL with message, reasoning, function_call, function_call_output', () => {
    const file = path.join(dir, 'rollout.jsonl');
    const ts = 1_700_000_000_000;
    const lines = [
      JSON.stringify({
        ts,
        payload: { type: 'message', role: 'user', content: 'do it' },
      }),
      JSON.stringify({
        ts: ts + 1,
        payload: { type: 'reasoning', summary: [{ text: 'thinking...' }] },
      }),
      JSON.stringify({
        ts: ts + 2,
        payload: {
          type: 'function_call',
          name: 'shell',
          arguments: '{"cmd":"ls"}',
        },
      }),
      JSON.stringify({
        ts: ts + 3,
        payload: { type: 'function_call_output', output: 'a.ts\nb.ts' },
      }),
    ];
    writeFileSync(file, lines.join('\n'), 'utf8');

    const events = codexParser.parse(file);
    expect(events).toHaveLength(4);
    expect(events[0]).toMatchObject({ kind: 'message', role: 'user', text: 'do it' });
    expect(events[1]).toMatchObject({ kind: 'reasoning', text: 'thinking...' });
    expect(events[2]).toMatchObject({ kind: 'tool_call', toolName: 'shell' });
    expect((events[2].toolInput as Record<string, unknown>)['cmd']).toBe('ls');
    expect(events[3]).toMatchObject({ kind: 'tool_result', toolOutput: 'a.ts\nb.ts' });
  });

  it('skips malformed lines without throwing', () => {
    const file = path.join(dir, 'mixed.jsonl');
    const good = JSON.stringify({
      ts: 1,
      payload: { type: 'message', role: 'assistant', content: 'ok' },
    });
    writeFileSync(file, `${good}\nthis is not json\n${good}\n`, 'utf8');

    const events = codexParser.parse(file);
    // Two good messages, one bad line skipped.
    expect(events).toHaveLength(2);
  });

  it('handles empty file gracefully', () => {
    const file = path.join(dir, 'empty.jsonl');
    writeFileSync(file, '', 'utf8');
    expect(codexParser.parse(file)).toEqual([]);
  });
});
