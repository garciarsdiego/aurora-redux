import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import opencodeParser from '../../../src/v2/cli-tail/parsers/opencode.js';

// ---------------------------------------------------------------------------
// Helpers — synthesise ACP frames per opencode's wire shape captured 2026-05-10
// ---------------------------------------------------------------------------

function acpUpdate(sessionId: string, update: Record<string, unknown>): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    method: 'session/update',
    params: { sessionId, update },
  });
}

function acpResponse(id: number, result: Record<string, unknown>): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

const SESSION_ID = 'ses_1ef938da0ffeVgxZz70JZrloKI';

describe('opencode tail parser', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'omniforge-cli-tail-opencode-'));
  });

  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  // -------------------------------------------------------------------------
  // ACP — informational (skipped) subtypes
  // -------------------------------------------------------------------------

  it('ACP: available_commands_update yields no TailEvents (informational)', () => {
    const file = path.join(dir, 'session.jsonl');
    writeFileSync(
      file,
      acpUpdate(SESSION_ID, {
        sessionUpdate: 'available_commands_update',
        availableCommands: [
          { name: 'init', description: 'guided AGENTS.md setup' },
          { name: 'help', description: 'show help' },
        ],
      }),
      'utf8',
    );

    const events = opencodeParser.parse(file);
    expect(events).toEqual([]);
  });

  it('ACP: usage_update yields no TailEvents (informational)', () => {
    const file = path.join(dir, 'session.jsonl');
    writeFileSync(
      file,
      acpUpdate(SESSION_ID, {
        sessionUpdate: 'usage_update',
        used: 0,
        size: 200000,
        cost: { amount: 0, currency: 'USD' },
      }),
      'utf8',
    );

    const events = opencodeParser.parse(file);
    expect(events).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // ACP — message streaming
  // -------------------------------------------------------------------------

  it('ACP: agent_message_chunk emits message event with role=assistant (text field)', () => {
    const file = path.join(dir, 'session.jsonl');
    writeFileSync(
      file,
      acpUpdate(SESSION_ID, {
        sessionUpdate: 'agent_message_chunk',
        text: 'Hello from the model',
      }),
      'utf8',
    );

    const events = opencodeParser.parse(file);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'message',
      role: 'assistant',
      text: 'Hello from the model',
    });
  });

  it('ACP: agent_message_chunk extracts text from content[] block array', () => {
    const file = path.join(dir, 'session.jsonl');
    writeFileSync(
      file,
      acpUpdate(SESSION_ID, {
        sessionUpdate: 'agent_message_chunk',
        content: [
          { type: 'text', text: 'streamed ' },
          { type: 'text', text: 'reply' },
        ],
      }),
      'utf8',
    );

    const events = opencodeParser.parse(file);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'message',
      role: 'assistant',
      text: 'streamed reply',
    });
  });

  // -------------------------------------------------------------------------
  // ACP — reasoning streaming
  // -------------------------------------------------------------------------

  it('ACP: agent_thought_chunk emits reasoning event', () => {
    const file = path.join(dir, 'session.jsonl');
    writeFileSync(
      file,
      acpUpdate(SESSION_ID, {
        sessionUpdate: 'agent_thought_chunk',
        text: 'Thinking about the problem...',
      }),
      'utf8',
    );

    const events = opencodeParser.parse(file);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'reasoning',
      text: 'Thinking about the problem...',
    });
  });

  // -------------------------------------------------------------------------
  // ACP — tool lifecycle
  // -------------------------------------------------------------------------

  it('ACP: tool_call (started) emits tool_call event with name + input', () => {
    const file = path.join(dir, 'session.jsonl');
    writeFileSync(
      file,
      acpUpdate(SESSION_ID, {
        sessionUpdate: 'tool_call',
        tool: {
          name: 'apply_patch',
          arguments: { hunks: 1, path: 'src/foo.ts' },
        },
      }),
      'utf8',
    );

    const events = opencodeParser.parse(file);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'tool_call', toolName: 'apply_patch' });
    expect((events[0].toolInput as Record<string, unknown>)['path']).toBe('src/foo.ts');
  });

  it('ACP: tool_call with name+arguments at top level (no nested tool wrapper)', () => {
    const file = path.join(dir, 'session.jsonl');
    writeFileSync(
      file,
      acpUpdate(SESSION_ID, {
        sessionUpdate: 'tool_call',
        name: 'read',
        arguments: { path: 'README.md' },
      }),
      'utf8',
    );

    const events = opencodeParser.parse(file);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'tool_call', toolName: 'read' });
  });

  it('ACP: tool_call_result emits tool_result event with output', () => {
    const file = path.join(dir, 'session.jsonl');
    writeFileSync(
      file,
      acpUpdate(SESSION_ID, {
        sessionUpdate: 'tool_call_result',
        output: 'patch applied successfully',
      }),
      'utf8',
    );

    const events = opencodeParser.parse(file);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'tool_result',
      toolOutput: 'patch applied successfully',
    });
  });

  // -------------------------------------------------------------------------
  // ACP — plan + session lifecycle
  // -------------------------------------------------------------------------

  it('ACP: plan emits meta event with summary text', () => {
    const file = path.join(dir, 'session.jsonl');
    writeFileSync(
      file,
      acpUpdate(SESSION_ID, {
        sessionUpdate: 'plan',
        summary: 'Refactor auth module then update tests',
      }),
      'utf8',
    );

    const events = opencodeParser.parse(file);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('meta');
    expect(events[0].text).toContain('Refactor auth module');
  });

  it('ACP: session_cancelled emits meta marker', () => {
    const file = path.join(dir, 'session.jsonl');
    writeFileSync(file, acpUpdate(SESSION_ID, { sessionUpdate: 'session_cancelled' }), 'utf8');

    const events = opencodeParser.parse(file);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('meta');
    expect(events[0].text).toContain('session_cancelled');
  });

  // -------------------------------------------------------------------------
  // ACP — unknown subtype fallback
  // -------------------------------------------------------------------------

  it('ACP: unknown sessionUpdate falls back to message + warns once', () => {
    const file = path.join(dir, 'session.jsonl');
    writeFileSync(
      file,
      acpUpdate(SESSION_ID, {
        sessionUpdate: 'mysterious_new_subtype',
        someField: 'someValue',
      }),
      'utf8',
    );

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const events = opencodeParser.parse(file);
      expect(events).toHaveLength(1);
      expect(events[0].kind).toBe('message');
      expect(events[0].text).toContain('mysterious_new_subtype');
    } finally {
      stderrSpy.mockRestore();
    }
  });

  // -------------------------------------------------------------------------
  // ACP — frame filtering
  // -------------------------------------------------------------------------

  it('ACP: response frames (no method) are silently skipped', () => {
    const file = path.join(dir, 'session.jsonl');
    const lines = [
      acpResponse(1, { protocolVersion: 1 }),
      acpResponse(2, { sessionId: SESSION_ID, _meta: {} }),
      acpUpdate(SESSION_ID, { sessionUpdate: 'agent_message_chunk', text: 'real content' }),
      acpResponse(3, { stopReason: 'end_turn' }),
    ];
    writeFileSync(file, lines.join('\n'), 'utf8');

    const events = opencodeParser.parse(file);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'message', text: 'real content' });
  });

  it('ACP: mixed informational + content stream yields only content TailEvents', () => {
    const file = path.join(dir, 'session.jsonl');
    const lines = [
      acpUpdate(SESSION_ID, {
        sessionUpdate: 'available_commands_update',
        availableCommands: [{ name: 'init', description: 'guided' }],
      }),
      acpUpdate(SESSION_ID, {
        sessionUpdate: 'usage_update',
        used: 100,
        size: 200000,
      }),
      acpUpdate(SESSION_ID, {
        sessionUpdate: 'agent_message_chunk',
        text: 'first chunk ',
      }),
      acpUpdate(SESSION_ID, {
        sessionUpdate: 'agent_message_chunk',
        text: 'second chunk',
      }),
      acpUpdate(SESSION_ID, { sessionUpdate: 'session_cancelled' }),
    ];
    writeFileSync(file, lines.join('\n'), 'utf8');

    const events = opencodeParser.parse(file);
    // 2 chunks + 1 session_cancelled meta = 3
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({ kind: 'message', text: 'first chunk ' });
    expect(events[1]).toMatchObject({ kind: 'message', text: 'second chunk' });
    expect(events[2]).toMatchObject({ kind: 'meta' });
  });

  // -------------------------------------------------------------------------
  // Legacy fallback paths (pre-ACP files must still work)
  // -------------------------------------------------------------------------

  it('legacy NDJSON: messages and tool activity still parse', () => {
    const file = path.join(dir, 'session.jsonl');
    const lines = [
      JSON.stringify({ ts: 1, role: 'user', text: 'refactor this' }),
      JSON.stringify({ ts: 2, role: 'assistant', text: 'starting...' }),
      JSON.stringify({ ts: 3, type: 'tool_call', name: 'apply_patch', args: { hunks: 1 } }),
      JSON.stringify({ ts: 4, type: 'tool_result', output: 'patch applied' }),
    ];
    writeFileSync(file, lines.join('\n'), 'utf8');

    const events = opencodeParser.parse(file);
    expect(events).toHaveLength(4);
    expect(events[0]).toMatchObject({ kind: 'message', role: 'user', text: 'refactor this' });
    expect(events[1]).toMatchObject({ kind: 'message', role: 'assistant' });
    expect(events[2]).toMatchObject({ kind: 'tool_call', toolName: 'apply_patch' });
    expect(events[3]).toMatchObject({ kind: 'tool_result', toolOutput: 'patch applied' });
  });

  it('legacy: directory mode merges multiple files in mtime order', async () => {
    const a = path.join(dir, '01.jsonl');
    const b = path.join(dir, '02.jsonl');
    writeFileSync(a, JSON.stringify({ role: 'user', content: 'A' }), 'utf8');
    await new Promise((r) => setTimeout(r, 10));
    writeFileSync(b, JSON.stringify({ role: 'assistant', content: 'B' }), 'utf8');

    const events = opencodeParser.parse(dir);
    expect(events).toHaveLength(2);
    expect(events[0].text).toBe('A');
    expect(events[1].text).toBe('B');
  });

  it('legacy malformed NDJSON: bad line still yields events without throwing', () => {
    const file = path.join(dir, 'broken.jsonl');
    writeFileSync(
      file,
      '{"role":"user","text":"alpha"}\nNOT JSON\n{"role":"assistant","text":"beta"}\n',
      'utf8',
    );

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const events = opencodeParser.parse(file);
      expect(events.length).toBeGreaterThanOrEqual(1);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('plain-text fallback: file with no JSON content becomes a single message event', () => {
    const file = path.join(dir, 'plain.log');
    writeFileSync(file, 'just some plain stdout text\nfrom an opencode run', 'utf8');
    const events = opencodeParser.parse(file);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'message' });
    expect(events[0].text).toContain('just some plain stdout');
  });

  it('returns [] for missing input', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const events = opencodeParser.parse(path.join(dir, 'absent'));
      expect(events).toEqual([]);
    } finally {
      stderrSpy.mockRestore();
    }
  });
});
