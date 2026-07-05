/**
 * Fase A / Wave 2 — verifies that the single LLM chokepoint now lets
 * codex-cli/* consume image attachments through the CLI path instead of
 * rejecting every CLI model before dispatch. The actual Codex binary is not
 * spawned; child_process.spawn is mocked at the module boundary.
 */
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('callOmnirouteWithUsage — CLI image attachments', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock('node:child_process');
  });

  afterEach(() => {
    delete process.env.CLI_CODEX_BIN;
    vi.doUnmock('node:child_process');
    vi.unstubAllGlobals();
  });

  it('routes codex-cli images to the CLI invoker instead of failing before dispatch', async () => {
    const imagePath = join(tmpdir(), 'omniroute-codex-image.png');
    const capturedPrompts: string[] = [];

    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:child_process')>();
      return {
        ...actual,
        spawn: vi.fn(() => {
          const child = new EventEmitter() as EventEmitter & {
            stdout: EventEmitter;
            stderr: EventEmitter;
            stdin: EventEmitter & {
              write: (chunk: string) => void;
              end: () => void;
            };
            kill: () => void;
            pid: number;
          };
          child.pid = 456;
          child.stdout = new EventEmitter();
          child.stderr = new EventEmitter();
          child.stdin = Object.assign(new EventEmitter(), {
            write: (chunk: string) => { capturedPrompts.push(chunk); },
            end: () => {
              queueMicrotask(() => {
                child.stdout.emit('data', Buffer.from('codex\nvisual-ok\ntokens used\n1\n'));
                child.emit('close', 0);
              });
            },
          });
          child.kill = vi.fn();
          return child;
        }),
      };
    });
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
    process.env.CLI_CODEX_BIN = process.execPath;

    const { callOmnirouteWithUsage } = await import('../../src/utils/omniroute-call.js');
    const result = await callOmnirouteWithUsage({
      systemPrompt: 'system',
      userPrompt: 'user',
      model: 'codex-cli/gpt-5.5',
      images: [{ path: imagePath, label: 'rendered screenshot' }],
    });

    expect(result.content).toBe('visual-ok');
    expect(mockFetch).not.toHaveBeenCalled();
    expect(capturedPrompts).toHaveLength(1);
    expect(capturedPrompts[0]).toContain(imagePath);
    expect(capturedPrompts[0]).toContain('rendered screenshot');
  });
});
