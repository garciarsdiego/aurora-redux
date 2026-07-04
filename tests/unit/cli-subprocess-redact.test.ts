/**
 * Tier-0 Wave 4 (0.15) — subprocess output redaction.
 *
 * The spawn surface in `src/executors/cli.ts` captures stdout/stderr from CLI
 * agents (Claude Code, Codex, Gemini, Kimi, Cursor, Kilo, OpenCode). Captured
 * output flows into:
 *   1. `opts.onEvent` `task_streaming_chunk` events (REPL UI + dashboard SSE).
 *   2. `runCliTask`'s resolved string → `task.output_json` (DB).
 *   3. `runtime_stream_events` (already redacted at the store layer, but the
 *      executor MUST redact at the source so the SSE/event-broker path is
 *      also covered).
 *   4. Error messages composed from `stderr` tails.
 *
 * Before this hardening, a subprocess that accidentally echoed an env var
 * (API key, bearer token, JWT) would land verbatim in events + logs. This
 * test pins the patched insertion points: `emitChunk`, the final-`out`
 * redaction in the close handler, and the stderr-tail composition on both
 * is_error and non-zero-exit paths.
 *
 * The redactor itself (`applySecretPatterns` + `SECRET_PATTERNS`) is unit-
 * tested separately in `tests/unit/redact.test.ts` and `runtime-events-
 * redaction.test.ts`. Here we only verify the executor wires it correctly.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

import type { Task } from '../../src/types/index.js';
import type { WorkflowProgressEvent } from '../../src/brain/executor/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Spawn mock — hoisted so the module under test sees it on import
// ─────────────────────────────────────────────────────────────────────────────

interface FakeStream extends EventEmitter {
  // Production code only attaches `.on('data', …)` and never pipes / pauses,
  // so a bare EventEmitter is sufficient.
}

interface FakeProcess extends EventEmitter {
  stdout: FakeStream;
  stderr: FakeStream;
  stdin: { write: (chunk: string, enc?: BufferEncoding) => void; end: () => void };
  kill(signal?: NodeJS.Signals | number): boolean;
  killed: boolean;
  pid?: number;
}

interface SpawnScenario {
  stdout?: readonly string[];
  stderr?: readonly string[];
  exitCode?: number | null;
}

const spawnState: { scenario: SpawnScenario | null } = { scenario: null };

const { spawnMock, spawnSyncMock } = vi.hoisted(() => ({
  spawnMock: vi.fn<(command: string, args: readonly string[]) => FakeProcess>(),
  // spawnSync is used by `pickLatestVersion`/`querySemver` and the probe path.
  // We answer with a benign no-version result so the bin resolver falls back
  // to whatever the test sets via CLI_*_BIN.
  spawnSyncMock: vi.fn(() => ({
    error: undefined,
    status: 0,
    stdout: Buffer.from(''),
    stderr: Buffer.from(''),
    signal: null,
    pid: 0,
    output: [null, Buffer.from(''), Buffer.from('')],
  })),
}));

vi.mock('node:child_process', () => ({
  spawn: (command: string, args: readonly string[]) => spawnMock(command, args),
  spawnSync: (...args: unknown[]) => spawnSyncMock(...(args as Parameters<typeof spawnSyncMock>)),
}));

function makeFakeProcess(scenario: SpawnScenario): FakeProcess {
  const emitter = new EventEmitter() as FakeProcess;
  emitter.killed = false;
  emitter.pid = 12345;
  emitter.kill = (_signal?: NodeJS.Signals | number) => {
    emitter.killed = true;
    return true;
  };
  emitter.stdout = new EventEmitter() as FakeStream;
  emitter.stderr = new EventEmitter() as FakeStream;
  // child.stdin.write / .end are called unconditionally by runCliTask.
  emitter.stdin = { write: () => {}, end: () => {} };

  // Emit chunks then close on a microtask so the production code can attach
  // listeners synchronously after spawn() returns.
  queueMicrotask(() => {
    for (const chunk of scenario.stdout ?? []) {
      emitter.stdout.emit('data', Buffer.from(chunk, 'utf8'));
    }
    for (const chunk of scenario.stderr ?? []) {
      emitter.stderr.emit('data', Buffer.from(chunk, 'utf8'));
    }
    emitter.emit('close', scenario.exitCode ?? 0);
  });

  return emitter;
}

beforeEach(() => {
  spawnMock.mockReset();
  spawnState.scenario = null;
  spawnMock.mockImplementation(() => {
    const scenario = spawnState.scenario;
    if (!scenario) throw new Error('Test bug: spawn invoked without a configured scenario');
    return makeFakeProcess(scenario);
  });
  // Force the bin resolver to pick a path that bypasses Windows .cmd shim
  // unwrapping (the unwrap only fires for `.cmd` / `.bat` paths). `process.
  // execPath` always exists and is never a shim, so `resolveSpawnTarget`
  // returns a single direct-spawn candidate and our mocked spawn is invoked
  // straight away.
  process.env.CLI_CLAUDE_BIN = process.execPath;
  // Pin stream-json off — we want the raw-text resolution path so the test
  // can assert against the final `out` string directly without a parser
  // wrapping it in `[[CLI_TOOL_CALLS]]`.
  process.env.CLI_OUTPUT_FORMAT = 'text';
  // Disable safe-mode toggles so resolveCliSpec emits the standard arg shape.
  delete process.env.CLI_SAFE_MODE;
});

afterEach(() => {
  delete process.env.CLI_CLAUDE_BIN;
  delete process.env.CLI_OUTPUT_FORMAT;
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// Module under test — imported AFTER vi.mock so it sees the mocked spawn
// ─────────────────────────────────────────────────────────────────────────────

import { runCliTask } from '../../src/executors/cli.js';

// ─────────────────────────────────────────────────────────────────────────────
// Task fixture — minimal shape that satisfies runCliTask without requiring
// a real workspace dir, decomposer hint, or DB-backed runtime context.
// ─────────────────────────────────────────────────────────────────────────────

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task_test',
    workflow_id: 'wf_test',
    name: 'redaction probe',
    kind: 'cli_spawn',
    input_json: null,
    output_json: null,
    status: 'pending',
    depends_on: [],
    executor_hint: 'cli:claude-code',
    timeout_seconds: 60,
    max_retries: 0,
    retry_count: 0,
    retry_policy: 'exponential',
    started_at: null,
    completed_at: null,
    created_at: Date.now(),
    acceptance_criteria: null,
    refine_count: 0,
    max_refine: 0,
    refine_feedback: null,
    model: null,
    hitl: false,
    ...overrides,
  } as Task;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

const REDACTED = '***REDACTED***';
// Each fixture uses a value the patterns set in `src/v2/security/patterns.ts`
// matches. We pick three categories whose regex shapes are distinctive enough
// that the test cannot pass by accident on non-redacted output.
const SECRET_OPENAI_STYLE = 'sk-test1234567890abcdefghijklmnop';
const SECRET_GITHUB_PAT = 'ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const SECRET_BEARER = 'Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature_abc123def456';

describe('cli.ts subprocess redaction (Tier-0 Wave 4 / 0.15)', () => {
  it('redacts known secret shapes in the final resolved output', async () => {
    spawnState.scenario = {
      stdout: [`Synthesis result\nAPI key leaked: ${SECRET_OPENAI_STYLE}\nDone.`],
      exitCode: 0,
    };

    const result = await runCliTask(makeTask());

    expect(result).not.toContain(SECRET_OPENAI_STYLE);
    expect(result).toContain(REDACTED);
    expect(result).toContain('Synthesis result');
    expect(result).toContain('Done.');
  });

  it('redacts secrets in task_streaming_chunk events emitted via opts.onEvent', async () => {
    const events: WorkflowProgressEvent[] = [];
    spawnState.scenario = {
      stdout: [`leak: ${SECRET_GITHUB_PAT} mid-stream\n`],
      exitCode: 0,
    };

    await runCliTask(makeTask(), undefined, {
      onEvent: (e) => { events.push(e); },
    });

    const chunkEvents = events.filter((e) => e.type === 'task_streaming_chunk');
    expect(chunkEvents.length).toBeGreaterThan(0);
    const allChunkText = chunkEvents
      .map((e) => String((e.payload as Record<string, unknown>).chunk ?? ''))
      .join('');
    expect(allChunkText).not.toContain(SECRET_GITHUB_PAT);
    expect(allChunkText).toContain(REDACTED);
    expect(allChunkText).toContain('leak:');
    expect(allChunkText).toContain('mid-stream');
  });

  it('redacts bearer tokens in stderr-tail when the CLI exits non-zero', async () => {
    spawnState.scenario = {
      stdout: [],
      stderr: [`auth failed for header Authorization: ${SECRET_BEARER}\n`],
      exitCode: 1,
    };

    await expect(runCliTask(makeTask())).rejects.toThrow(/CLI .+ failed \(exit 1\)/);

    try {
      await runCliTask(makeTask());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).not.toContain(SECRET_BEARER);
      // The bearer_token pattern matches the entire `Bearer …` substring; the
      // authorization_header pattern matches `Authorization: …`. The redacted
      // string must contain the canonical placeholder somewhere in the tail.
      expect(message).toContain(REDACTED);
    }
  });

  it('passes non-secret output through unchanged (no false positives on plain prose)', async () => {
    const plainOutput = [
      'Step 1 — read the file.',
      'Step 2 — apply the patch.',
      'Numbers: 1234567890, identifiers: foo_bar_baz.',
      'Lorem ipsum dolor sit amet, consectetur adipiscing elit.',
      'Done in 12s.',
    ].join('\n');
    spawnState.scenario = {
      stdout: [plainOutput],
      exitCode: 0,
    };

    const result = await runCliTask(makeTask());
    expect(result).not.toContain(REDACTED);
    expect(result).toContain('Step 1 — read the file.');
    expect(result).toContain('Done in 12s.');
  });

  it('redacts secrets that arrive across multiple chunks once joined into the final buffer', async () => {
    // emitChunk's per-chunk redaction uses \b word boundaries — a secret split
    // mid-string survives the chunk-level pass but MUST be caught by the
    // final-buffer redaction before resolve() returns the concatenated `out`.
    const split1 = `prefix sk-test`;
    const split2 = `1234567890abcdefghij suffix`; // joined → `sk-test1234567890abcdefghij` matches the openai pattern
    spawnState.scenario = {
      stdout: [split1, split2],
      exitCode: 0,
    };

    const result = await runCliTask(makeTask());
    // The joined buffer contains a complete sk- token; the canonical redaction
    // pass MUST scrub it from the final returned string.
    expect(result).not.toMatch(/sk-test1234567890abcdefghij/);
    expect(result).toContain(REDACTED);
  });
});
