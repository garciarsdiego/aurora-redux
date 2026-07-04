/**
 * Tests for the post-2026-05-05 fix N2 (markdown-fence stripping in
 * worker_cli_spawn.postHook) and N1 (Gemini-only text prefix routing).
 *
 * The fence stripper is internal to worker_cli_spawn.ts (`stripMarkdownFences`)
 * and is exercised here through the persona's full postHook so the test
 * also locks in the surrounding behaviour: handoff parse, file checks,
 * etc. Mocks Omniroute to keep this offline.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const omnirouteMock = vi.hoisted(() => ({
  callOmniroute: vi.fn(),
  callOmnirouteWithUsage: vi.fn(),
}));
vi.mock('../../src/utils/omniroute-call.js', () => omnirouteMock);

const { WORKER_CLI_SPAWN_PERSONA } = await import('../../src/v2/agents/personas/worker_cli_spawn.js');
const { WORKER_CLI_SPAWN_PREFIX, WORKER_GEMINI_TEXT_PREFIX } = await import('../../src/v2/agents/prompts/prefixes.js');

const ctx = {
  retryCount: 0,
  workspaceDir: process.cwd(),
  emit: () => {},
  warn: () => {},
  log: () => {},
};

function baseInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    task_id: 't1',
    workflow_id: 'wf1',
    workspace: 'internal',
    cli: 'cli:claude-code' as const,
    model: 'cc/claude-sonnet-4-6',
    prompt: 'Generate a JSON array.',
    acceptance_criteria: 'JSON only.',
    workspace_dir: process.cwd(),
    retry_count: 0,
    timeout_seconds: 60,
    ...overrides,
  };
}

function baseOutput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    exit_code: 0,
    duration_ms: 100,
    tool_calls: [{ name: 'Write', input: { file_path: '/tmp/dummy', content: 'x' } }],
    files_written: [],
    files_modified: [],
    files_read: [],
    result_text: '',
    blocked: false,
    ...overrides,
  };
}

describe('worker_cli_spawn.postHook — markdown-fence stripping (N2)', () => {
  beforeEach(() => {
    omnirouteMock.callOmniroute.mockReset();
    omnirouteMock.callOmnirouteWithUsage.mockReset();
  });

  it('strips ```json fences from result_text', async () => {
    const wrapped = '```json\n[{"name":"Garen"},{"name":"Lux"}]\n```';
    const out = baseOutput({ result_text: wrapped });
    const result = await WORKER_CLI_SPAWN_PERSONA.postHook!(baseInput() as never, out as never, ctx as never);
    // Either a clean output or a structured rejection — what we care about is
    // that result_text no longer carries the fence wrapper.
    if (typeof result === 'object' && 'result_text' in (result as Record<string, unknown>)) {
      expect((result as { result_text: string }).result_text).toBe('[{"name":"Garen"},{"name":"Lux"}]');
    } else {
      // postHook may have rejected for unrelated reasons (no_trace etc.) —
      // but the in-place mutation of the output object is what we want to
      // verify here, and the persona keeps the same reference.
      expect(out['result_text']).toBe('[{"name":"Garen"},{"name":"Lux"}]');
    }
  });

  it('strips ``` (no language tag) fences', async () => {
    const out = baseOutput({ result_text: '```\nhello world\n```' });
    await WORKER_CLI_SPAWN_PERSONA.postHook!(baseInput() as never, out as never, ctx as never);
    expect((out as { result_text: string }).result_text).toBe('hello world');
  });

  it('leaves un-fenced text unchanged (idempotent)', async () => {
    const out = baseOutput({ result_text: 'plain text without fences' });
    await WORKER_CLI_SPAWN_PERSONA.postHook!(baseInput() as never, out as never, ctx as never);
    expect((out as { result_text: string }).result_text).toBe('plain text without fences');
  });

  it('preserves inner fences inside markdown bodies (only strips outermost)', async () => {
    // A markdown doc that ITSELF includes a code sample — must not collapse to one fence
    const text = '# Title\n\nHere is a snippet:\n\n```js\nconsole.log(1)\n```\n\nMore prose.';
    const out = baseOutput({ result_text: text });
    await WORKER_CLI_SPAWN_PERSONA.postHook!(baseInput() as never, out as never, ctx as never);
    // Outer fences absent → nothing to strip → unchanged
    expect((out as { result_text: string }).result_text).toBe(text);
  });

  it('handles empty result_text gracefully', async () => {
    const out = baseOutput({ result_text: '' });
    // Will hit the no_trace short-circuit but should not throw on stripping
    await expect(WORKER_CLI_SPAWN_PERSONA.postHook!(baseInput() as never, out as never, ctx as never)).resolves.toBeDefined();
  });
});

describe('worker_cli_spawn.preHook — Gemini text prefix routing (N1)', () => {
  beforeEach(() => {
    omnirouteMock.callOmniroute.mockReset();
    omnirouteMock.callOmnirouteWithUsage.mockReset();
  });

  it('uses WORKER_GEMINI_TEXT_PREFIX when cli is cli:gemini', async () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'worker-prefix-test-'));
    const input = baseInput({ cli: 'cli:gemini', workspace_dir: tmpDir, prompt: 'Original prompt body.' });
    const result = await WORKER_CLI_SPAWN_PERSONA.preHook!(input as never, ctx as never);
    const newInput = result as { prompt: string };
    expect(newInput.prompt.startsWith(WORKER_GEMINI_TEXT_PREFIX)).toBe(true);
    expect(newInput.prompt).toContain('Original prompt body.');
    // Gemini path should NOT carry the heavy CLI_SPAWN_PREFIX
    expect(newInput.prompt.startsWith(WORKER_CLI_SPAWN_PREFIX)).toBe(false);
    // Gemini path should NOT append HANDOFF_SCHEMA_SNIPPET (over-direction risk)
    expect(newInput.prompt).not.toContain('=== RESPONSE FORMAT (handoff schema) ===');
  });

  it('uses WORKER_CLI_SPAWN_PREFIX (full contract) for non-gemini CLIs', async () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'worker-prefix-test-'));
    for (const cli of ['cli:claude-code', 'cli:codex', 'cli:opencode', 'cli:kimi', 'cli:cursor'] as const) {
      const input = baseInput({ cli, workspace_dir: tmpDir, prompt: 'Body.' });
      const result = await WORKER_CLI_SPAWN_PERSONA.preHook!(input as never, ctx as never);
      const newInput = result as { prompt: string };
      expect(newInput.prompt.startsWith(WORKER_CLI_SPAWN_PREFIX)).toBe(true);
      expect(newInput.prompt).toContain('=== RESPONSE FORMAT (handoff schema) ===');
    }
  });

  it('is idempotent — running preHook twice does not double-prefix', async () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'worker-prefix-test-'));
    const input = baseInput({ cli: 'cli:gemini', workspace_dir: tmpDir, prompt: 'Body.' });
    const first = await WORKER_CLI_SPAWN_PERSONA.preHook!(input as never, ctx as never);
    const second = await WORKER_CLI_SPAWN_PERSONA.preHook!(first as never, ctx as never);
    const finalPrompt = (second as { prompt: string }).prompt;
    // Count occurrences of the prefix start tag — must be 1
    const matches = finalPrompt.split('=== TEXT-OUTPUT WORKER ===').length - 1;
    expect(matches).toBe(1);
  });
});
