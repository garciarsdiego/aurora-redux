import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import cursorParser from '../../../src/v2/cli-tail/parsers/cursor.js';

describe('cursor tail parser', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'omniforge-cli-tail-cursor-'));
  });

  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('happy path: messages.json with chat history', () => {
    const file = path.join(dir, 'messages.json');
    const doc = {
      messages: [
        { role: 'user', content: 'add a CLI flag', ts: 1_700_000_000_000 },
        { role: 'assistant', content: 'sure, editing now', ts: 1_700_000_001_000 },
        {
          role: 'assistant',
          type: 'tool_use',
          name: 'edit_file',
          args: { path: 'src/cli.ts' },
          ts: 1_700_000_002_000,
        },
      ],
    };
    writeFileSync(file, JSON.stringify(doc), 'utf8');

    const events = cursorParser.parse(file);
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({ kind: 'message', role: 'user', text: 'add a CLI flag' });
    expect(events[1]).toMatchObject({ kind: 'message', role: 'assistant' });
    expect(events[2]).toMatchObject({ kind: 'tool_call', toolName: 'edit_file' });
    expect((events[2].toolInput as Record<string, unknown>)['path']).toBe('src/cli.ts');
  });

  it('partial chunk reassembly: directory mode reads jsonl + json files', async () => {
    // Cursor's chat dir may contain both an event log and a chat history doc.
    const eventsLog = path.join(dir, 'events.jsonl');
    const chatHistory = path.join(dir, 'chat.json');

    writeFileSync(
      eventsLog,
      [
        JSON.stringify({ ts: 1, type: 'message', role: 'user', text: 'first' }),
        JSON.stringify({ ts: 2, type: 'assistant_text', text: 'reply' }),
      ].join('\n'),
      'utf8',
    );
    await new Promise((r) => setTimeout(r, 10));
    writeFileSync(
      chatHistory,
      JSON.stringify({ messages: [{ role: 'user', content: 'second' }] }),
      'utf8',
    );

    const events = cursorParser.parse(dir);
    expect(events.length).toBe(3);
    // mtime order: eventsLog first (older), chatHistory second.
    expect(events[0].text).toBe('first');
    expect(events[1].text).toBe('reply');
    expect(events[2].text).toBe('second');
  });

  it('malformed line: NDJSON with garbage falls back to text parsing without throwing', () => {
    const file = path.join(dir, 'corrupt.jsonl');
    writeFileSync(
      file,
      '{"type":"message","role":"user","text":"ok"}\nGARBAGE LINE\n',
      'utf8',
    );

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const events = cursorParser.parse(file);
      // Plain-text fallback or partial NDJSON — either is fine, just don't throw.
      expect(events.length).toBeGreaterThanOrEqual(1);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('returns [] and warns for missing inputs', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const events = cursorParser.parse(path.join(dir, 'no-such'));
      expect(events).toEqual([]);
    } finally {
      stderrSpy.mockRestore();
    }
  });
});
