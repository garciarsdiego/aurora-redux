import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import claudeParser from '../../../src/v2/cli-tail/parsers/claude.js';

function ndjson(events: Array<Record<string, unknown>>): string {
  return events.map((e) => JSON.stringify(e)).join('\n');
}

describe('claude tail parser', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'omniforge-cli-tail-claude-'));
  });

  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('happy path: extracts user message, assistant text/thinking/tool_use, and tool_result', () => {
    const sessionFile = path.join(dir, 'session.jsonl');
    const ts = '2026-05-01T14:52:00.000Z';
    writeFileSync(
      sessionFile,
      ndjson([
        // Meta entries should be ignored.
        { type: 'queue-operation', operation: 'enqueue', timestamp: ts, sessionId: 's1' },
        { type: 'ai-title', aiTitle: 'A title', sessionId: 's1' },
        // User string-content message.
        {
          type: 'user',
          message: { role: 'user', content: 'Read pricing.ts and validate.' },
          timestamp: ts,
          sessionId: 's1',
        },
        // Assistant entry mixing thinking + tool_use.
        {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'Let me read the file first.' },
              { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/x' } },
            ],
          },
          timestamp: ts,
        },
        // User entry carrying a tool_result.
        {
          type: 'user',
          message: {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 't1', content: 'file contents here', is_error: false },
            ],
          },
          timestamp: ts,
        },
        // Assistant text turn.
        {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Final synthesis.' }],
          },
          timestamp: ts,
        },
      ]),
      'utf8',
    );

    const events = claudeParser.parse(sessionFile);

    // 1 user msg + (1 reasoning + 1 tool_call) + 1 tool_result + 1 assistant msg = 5
    expect(events).toHaveLength(5);

    expect(events[0]).toMatchObject({ kind: 'message', role: 'user' });
    expect(events[0].text).toContain('Read pricing.ts');

    expect(events[1]).toMatchObject({ kind: 'reasoning' });
    expect(events[1].text).toContain('Let me read the file');

    expect(events[2]).toMatchObject({
      kind: 'tool_call',
      toolName: 'Read',
    });
    expect((events[2].toolInput as Record<string, unknown>)['file_path']).toBe('/x');

    expect(events[3]).toMatchObject({ kind: 'tool_result' });
    expect(events[3].toolOutput).toBe('file contents here');

    expect(events[4]).toMatchObject({ kind: 'message', role: 'assistant' });
    expect(events[4].text).toBe('Final synthesis.');

    // Timestamps from ISO string converted to ms.
    for (const e of events) {
      expect(e.ts).toBe(Date.parse(ts));
    }
  });

  it('partial chunk reassembly: trailing newline / unfinished line is tolerated', () => {
    // Simulate a session log being written incrementally — last line only
    // partially present (no trailing newline yet). The parser must emit
    // events for the complete lines and silently drop the trailing fragment.
    const sessionFile = path.join(dir, 'partial.jsonl');
    const ts = '2026-05-01T14:52:00.000Z';

    const completeLine = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'turn one' }] },
      timestamp: ts,
    });
    const partialLine = '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"tur';

    // No trailing newline — write { complete }\n{ partial }
    writeFileSync(sessionFile, `${completeLine}\n${partialLine}`, 'utf8');

    // Capture stderr noise from the parser warning about the bad line.
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const events = claudeParser.parse(sessionFile);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ kind: 'message', role: 'assistant', text: 'turn one' });
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('malformed line: skips invalid JSON without throwing and keeps neighbours', () => {
    const sessionFile = path.join(dir, 'bad.jsonl');
    const ts = '2026-05-01T14:52:00.000Z';

    const goodFirst = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'hi' },
      timestamp: ts,
    });
    const goodLast = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'hello back' }] },
      timestamp: ts,
    });

    writeFileSync(
      sessionFile,
      `${goodFirst}\nthis is not json at all\n${goodLast}\n`,
      'utf8',
    );

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const events = claudeParser.parse(sessionFile);
      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({ kind: 'message', role: 'user', text: 'hi' });
      expect(events[1]).toMatchObject({ kind: 'message', role: 'assistant', text: 'hello back' });
      // Verify the malformed line tripped the warning.
      const warned = stderrSpy.mock.calls.some((call) =>
        String(call[0]).includes('malformed JSON'),
      );
      expect(warned).toBe(true);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('returns [] and warns when the file is unreadable', () => {
    const ghost = path.join(dir, 'does-not-exist.jsonl');
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const events = claudeParser.parse(ghost);
      expect(events).toEqual([]);
    } finally {
      stderrSpy.mockRestore();
    }
  });
});
