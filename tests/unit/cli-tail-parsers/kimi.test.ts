import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import kimiParser from '../../../src/v2/cli-tail/parsers/kimi.js';

describe('kimi tail parser', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'omniforge-cli-tail-kimi-'));
  });

  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('happy path: transcript.jsonl with reasoning, tool_call, tool_result, and message', () => {
    const file = path.join(dir, 'transcript.jsonl');
    const lines = [
      JSON.stringify({ ts: 1_700_000_000_000, role: 'user', content: 'do the thing' }),
      JSON.stringify({ ts: 1_700_000_001_000, type: 'thinking', text: 'planning steps...' }),
      JSON.stringify({
        ts: 1_700_000_002_000,
        type: 'tool_call',
        name: 'WriteFile',
        args: { path: 'src/foo.ts', content: '...' },
      }),
      JSON.stringify({
        ts: 1_700_000_003_000,
        type: 'tool_result',
        output: 'wrote 42 bytes',
      }),
      JSON.stringify({ ts: 1_700_000_004_000, role: 'assistant', content: 'done.' }),
    ];
    writeFileSync(file, lines.join('\n'), 'utf8');

    const events = kimiParser.parse(file);
    expect(events).toHaveLength(5);
    expect(events[0]).toMatchObject({ kind: 'message', role: 'user', text: 'do the thing' });
    expect(events[1]).toMatchObject({ kind: 'reasoning', text: 'planning steps...' });
    expect(events[2]).toMatchObject({ kind: 'tool_call', toolName: 'WriteFile' });
    expect((events[2].toolInput as Record<string, unknown>)['path']).toBe('src/foo.ts');
    expect(events[3]).toMatchObject({ kind: 'tool_result', toolOutput: 'wrote 42 bytes' });
    expect(events[4]).toMatchObject({ kind: 'message', role: 'assistant', text: 'done.' });
  });

  it('partial chunk reassembly: directory contains multiple files merged in mtime order', async () => {
    // Two segments of a transcript written at different times.
    const first = path.join(dir, 'turn-01.jsonl');
    const second = path.join(dir, 'turn-02.jsonl');
    writeFileSync(first, JSON.stringify({ role: 'user', content: 'first turn' }), 'utf8');
    await new Promise((r) => setTimeout(r, 10));
    writeFileSync(second, JSON.stringify({ role: 'assistant', content: 'second turn' }), 'utf8');

    const events = kimiParser.parse(dir);
    expect(events).toHaveLength(2);
    expect(events[0].text).toBe('first turn');
    expect(events[1].text).toBe('second turn');
  });

  it('skips well-known sidecars (metadata.json) when parsing a directory', () => {
    writeFileSync(
      path.join(dir, 'metadata.json'),
      JSON.stringify({ workspace: 'foo', sessionId: 'bar' }),
      'utf8',
    );
    writeFileSync(
      path.join(dir, 'transcript.jsonl'),
      JSON.stringify({ role: 'user', content: 'hello' }),
      'utf8',
    );
    const events = kimiParser.parse(dir);
    expect(events).toHaveLength(1);
    expect(events[0].text).toBe('hello');
  });

  it('malformed line: NDJSON with one bad line falls back to plain text parse', () => {
    const file = path.join(dir, 'broken.jsonl');
    writeFileSync(
      file,
      '{"role":"user","content":"good"}\n{not valid json\n{"role":"assistant","content":"bye"}\n',
      'utf8',
    );

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const events = kimiParser.parse(file);
      // The all-or-nothing NDJSON path bails when it sees the bad line and
      // the parser falls back to plain-text. Either we get the full text as
      // one event, or partial events — both are acceptable; what matters is
      // we don't throw.
      expect(events.length).toBeGreaterThanOrEqual(1);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('warns and returns [] for non-existent input', () => {
    const ghost = path.join(dir, 'nope');
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const events = kimiParser.parse(ghost);
      expect(events).toEqual([]);
    } finally {
      stderrSpy.mockRestore();
    }
  });
});
