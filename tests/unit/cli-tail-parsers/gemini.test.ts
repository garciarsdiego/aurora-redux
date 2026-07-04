import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import geminiParser from '../../../src/v2/cli-tail/parsers/gemini.js';

describe('gemini tail parser', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'omniforge-cli-tail-gemini-'));
  });

  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('happy path: NDJSON file with messages and tool_calls', () => {
    const file = path.join(dir, 'events.jsonl');
    const ts = 1_730_000_000_000;
    const lines = [
      JSON.stringify({ ts, role: 'user', text: 'list files' }),
      JSON.stringify({ ts: ts + 1000, role: 'assistant', text: 'sure, running ls' }),
      JSON.stringify({ ts: ts + 2000, type: 'tool_call', name: 'shell', args: { cmd: 'ls' } }),
      JSON.stringify({ ts: ts + 3000, type: 'tool_result', output: 'a.ts\nb.ts' }),
    ];
    writeFileSync(file, lines.join('\n'), 'utf8');

    const events = geminiParser.parse(file);
    expect(events).toHaveLength(4);
    expect(events[0]).toMatchObject({ kind: 'message', role: 'user', text: 'list files' });
    expect(events[1]).toMatchObject({ kind: 'message', role: 'assistant', text: 'sure, running ls' });
    expect(events[2]).toMatchObject({ kind: 'tool_call', toolName: 'shell' });
    expect((events[2].toolInput as Record<string, unknown>)['cmd']).toBe('ls');
    expect(events[3]).toMatchObject({ kind: 'tool_result', toolOutput: 'a.ts\nb.ts' });
  });

  it('partial chunk reassembly: directory mode walks multiple files in mtime order', async () => {
    // Simulate gemini writing two segment files inside a single history dir.
    const oldFile = path.join(dir, '01-first.jsonl');
    const newFile = path.join(dir, '02-second.jsonl');
    writeFileSync(
      oldFile,
      JSON.stringify({ role: 'user', text: 'older message' }),
      'utf8',
    );
    // Force the second file's mtime to be later.
    await new Promise((resolve) => setTimeout(resolve, 10));
    writeFileSync(
      newFile,
      JSON.stringify({ role: 'assistant', text: 'newer message' }),
      'utf8',
    );

    const events = geminiParser.parse(dir);
    expect(events).toHaveLength(2);
    expect(events[0].text).toBe('older message');
    expect(events[1].text).toBe('newer message');
  });

  it('happy path (single document): chat.json with messages array', () => {
    const file = path.join(dir, 'chat.json');
    const doc = {
      messages: [
        { role: 'user', parts: [{ text: 'multimodal ' }, { text: 'parts' }] },
        { role: 'assistant', text: 'understood' },
      ],
    };
    writeFileSync(file, JSON.stringify(doc), 'utf8');
    const events = geminiParser.parse(file);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ role: 'user', text: 'multimodal parts' });
    expect(events[1]).toMatchObject({ role: 'assistant', text: 'understood' });
  });

  it('malformed line in NDJSON: triggers fallback to single-document parsing or text', () => {
    // When NDJSON parsing fails partway, the parser should still return events
    // (via the plain-text fallback path) rather than throw.
    const file = path.join(dir, 'corrupt.jsonl');
    writeFileSync(file, '{"role":"user","text":"good"}\nthis is broken\n', 'utf8');

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const events = geminiParser.parse(file);
      // Either NDJSON parsing recovers the good line, or plain-text fallback
      // emits a single message containing the whole file. Both are acceptable.
      expect(events.length).toBeGreaterThanOrEqual(1);
      // No throw means resilience worked.
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('warns and returns [] when the directory is empty', () => {
    const empty = path.join(dir, 'empty-dir');
    mkdirSync(empty);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const events = geminiParser.parse(empty);
      expect(events).toEqual([]);
    } finally {
      stderrSpy.mockRestore();
    }
  });
});
