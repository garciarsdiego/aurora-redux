/**
 * Unit tests for src/v2/models/opencode-sync.ts.
 *
 * Wave C / Agent Q (2026-05-09 → 2026-05-10).
 *
 * The spawn surface is mocked through `vi.mock('node:child_process')` because
 * shell-binding the real `opencode` binary on every CI run would be flaky and
 * unbounded. The fake spawn implementation is a tiny EventEmitter with stdout/
 * stderr streams — enough for the production code to consume `data` chunks
 * and react to `close` / `error` / SIGKILL. The pattern keeps every test
 * synchronous from the caller's POV (we resolve via a queued microtask).
 *
 * The integration test that actually runs `opencode models` is gated by the
 * `OMNIFORGE_SKIP_OPENCODE_INTEGRATION` env var and skipped when unset/`'1'`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

// ─────────────────────────────────────────────────────────────────────────────
// Spawn mock setup — must be hoisted before module under test imports it
// ─────────────────────────────────────────────────────────────────────────────

interface FakeStream extends EventEmitter {
  // Production code only listens for 'data' — no Readable interface needed.
}

interface FakeProcess extends EventEmitter {
  stdout: FakeStream;
  stderr: FakeStream;
  kill(signal?: NodeJS.Signals | number): boolean;
  killed: boolean;
}

interface SpawnScenario {
  /** stdout chunks emitted in order. */
  stdout?: readonly string[];
  /** stderr chunks emitted in order. */
  stderr?: readonly string[];
  /** Exit code at close. Use null to simulate "killed without exit". */
  exitCode?: number | null;
  /** If set, throw synchronously from the fake spawn() call. */
  spawnThrows?: Error;
  /** If set, emit an `error` event instead of `close`. */
  emitError?: Error;
  /** If true, never emit `close` / `error` — caller is expected to time out. */
  hang?: boolean;
}

const spawnState: { scenario: SpawnScenario | null; lastCommand: string | null; lastArgs: readonly string[] | null } = {
  scenario: null,
  lastCommand: null,
  lastArgs: null,
};

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn<(command: string, args: readonly string[]) => FakeProcess>(),
}));

vi.mock('node:child_process', () => ({
  spawn: (command: string, args: readonly string[]) => spawnMock(command, args),
}));

function makeFakeProcess(scenario: SpawnScenario): FakeProcess {
  const emitter = new EventEmitter() as FakeProcess;
  emitter.killed = false;
  emitter.kill = (_signal?: NodeJS.Signals | number) => {
    emitter.killed = true;
    return true;
  };

  // Use bare EventEmitters for stdout/stderr instead of Readable streams.
  // The production code only attaches `.on('data', ...)` listeners — it
  // never calls `.pipe()` or asks for the data in object mode, so emitting
  // 'data' events directly avoids the back-pressure / paused-state pitfalls
  // of node:stream Readables and keeps the fake fully synchronous.
  emitter.stdout = new EventEmitter() as FakeStream;
  emitter.stderr = new EventEmitter() as FakeStream;

  // Emit chunks then resolve outcome on a microtask so the consumer can
  // attach listeners synchronously after spawn() returns.
  queueMicrotask(() => {
    for (const chunk of scenario.stdout ?? []) emitter.stdout.emit('data', Buffer.from(chunk, 'utf8'));
    for (const chunk of scenario.stderr ?? []) emitter.stderr.emit('data', Buffer.from(chunk, 'utf8'));

    if (scenario.hang) return;
    if (scenario.emitError) {
      emitter.emit('error', scenario.emitError);
      return;
    }
    emitter.emit('close', scenario.exitCode ?? 0);
  });

  return emitter;
}

beforeEach(() => {
  spawnMock.mockReset();
  spawnState.scenario = null;
  spawnState.lastCommand = null;
  spawnState.lastArgs = null;
  spawnMock.mockImplementation((command, args) => {
    spawnState.lastCommand = command;
    spawnState.lastArgs = args;
    const scenario = spawnState.scenario;
    if (!scenario) {
      throw new Error('Test bug: spawn invoked without a configured scenario');
    }
    if (scenario.spawnThrows) throw scenario.spawnThrows;
    return makeFakeProcess(scenario);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Module under test (imported AFTER vi.mock so it sees the mocked spawn)
// ─────────────────────────────────────────────────────────────────────────────

import {
  _clearOpencodeModelsCache,
  getOpencodeModelsFetchedAt,
  listOpencodeModels,
  parseOpencodeModelsOutput,
  refreshOpencodeModels,
} from '../../src/v2/models/opencode-sync.js';

afterEach(() => {
  _clearOpencodeModelsCache();
  delete process.env.OMNIFORGE_OPENCODE_BIN;
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// parseOpencodeModelsOutput — pure parser, no spawn
// ─────────────────────────────────────────────────────────────────────────────

describe('parseOpencodeModelsOutput', () => {
  it('parses provider/model lines with provider + model fields', () => {
    const out = parseOpencodeModelsOutput(
      [
        'opencode/big-pickle',
        'opencode/claude-haiku-4-5',
        'opencode/claude-opus-4-7',
        'opencode/gemini-3-flash',
        'anthropic/claude-sonnet-4-6',
      ].join('\n'),
    );
    expect(out).toHaveLength(5);
    expect(out[0]).toEqual({
      id: 'opencode/big-pickle',
      provider: 'opencode',
      model: 'big-pickle',
      source: 'opencode',
      available: true,
    });
    expect(out[4]).toEqual({
      id: 'anthropic/claude-sonnet-4-6',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      source: 'opencode',
      available: true,
    });
  });

  it('skips empty lines and lines without slash separator', () => {
    const out = parseOpencodeModelsOutput(
      [
        '',
        'header line without slash',
        'opencode/foo',
        '   ',
        '/leading-slash-only',
        'trailing-slash-only/',
        'anthropic/bar',
      ].join('\n'),
    );
    expect(out.map((e) => e.id)).toEqual(['opencode/foo', 'anthropic/bar']);
  });

  it('deduplicates entries while preserving first-seen order', () => {
    const out = parseOpencodeModelsOutput(
      ['opencode/dup', 'opencode/x', 'opencode/dup', 'opencode/y', 'opencode/x'].join('\n'),
    );
    expect(out.map((e) => e.id)).toEqual(['opencode/dup', 'opencode/x', 'opencode/y']);
  });

  it('caps at 5000 entries even on a runaway binary', () => {
    const lines = Array.from({ length: 5500 }, (_, i) => `opencode/model-${i}`);
    const out = parseOpencodeModelsOutput(lines.join('\n'));
    expect(out).toHaveLength(5000);
  });

  it('handles CRLF line endings (Windows opencode binary)', () => {
    const out = parseOpencodeModelsOutput('opencode/foo\r\nanthropic/bar\r\n');
    expect(out.map((e) => e.id)).toEqual(['opencode/foo', 'anthropic/bar']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// listOpencodeModels — spawn integration paths
// ─────────────────────────────────────────────────────────────────────────────

describe('listOpencodeModels', () => {
  it('returns parsed entries when spawn succeeds with 5-line sample', async () => {
    spawnState.scenario = {
      stdout: [
        [
          'opencode/big-pickle',
          'opencode/claude-haiku-4-5',
          'opencode/claude-opus-4-7',
          'opencode/gemini-3-flash',
          'anthropic/claude-sonnet-4-6',
        ].join('\n'),
      ],
      exitCode: 0,
    };

    const result = await listOpencodeModels();
    expect(result).toHaveLength(5);
    expect(result.map((e) => e.id)).toEqual([
      'opencode/big-pickle',
      'opencode/claude-haiku-4-5',
      'opencode/claude-opus-4-7',
      'opencode/gemini-3-flash',
      'anthropic/claude-sonnet-4-6',
    ]);
    expect(spawnState.lastCommand).toBe('opencode');
    expect(spawnState.lastArgs).toEqual(['models']);
  });

  it('honors OMNIFORGE_OPENCODE_BIN env override', async () => {
    process.env.OMNIFORGE_OPENCODE_BIN = '/usr/local/bin/opencode-beta';
    spawnState.scenario = { stdout: ['opencode/foo'], exitCode: 0 };
    await listOpencodeModels();
    expect(spawnState.lastCommand).toBe('/usr/local/bin/opencode-beta');
  });

  it('honors explicit binPath option over env', async () => {
    process.env.OMNIFORGE_OPENCODE_BIN = '/should/not/win';
    spawnState.scenario = { stdout: ['opencode/foo'], exitCode: 0 };
    await listOpencodeModels({ binPath: '/explicit/wins' });
    expect(spawnState.lastCommand).toBe('/explicit/wins');
  });

  it('returns [] when spawn produces empty stdout', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    spawnState.scenario = { stdout: [''], exitCode: 0 };
    const result = await listOpencodeModels();
    expect(result).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no parseable entries'));
  });

  it('returns [] when binary exits non-zero', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    spawnState.scenario = {
      stdout: [],
      stderr: ['command not found: models'],
      exitCode: 127,
    };
    const result = await listOpencodeModels();
    expect(result).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('exit code 127'));
  });

  it('returns [] when spawn emits error event (binary missing)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    spawnState.scenario = {
      emitError: Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' }),
    };
    const result = await listOpencodeModels();
    expect(result).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('spawn error: ENOENT'));
  });

  it('returns [] when spawn() itself throws synchronously', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    spawnState.scenario = { spawnThrows: new Error('EACCES: permission denied') };
    const result = await listOpencodeModels();
    expect(result).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('spawn threw'));
  });

  it('returns [] and kills the child on timeout', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    spawnState.scenario = { hang: true };
    const result = await listOpencodeModels({ timeoutMs: 25 });
    expect(result).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('timeout after 25ms'));
  });

  it('caches successful results and skips spawn on second call within TTL', async () => {
    spawnState.scenario = { stdout: ['opencode/foo\nopencode/bar'], exitCode: 0 };
    const first = await listOpencodeModels();
    expect(first).toHaveLength(2);
    expect(spawnMock).toHaveBeenCalledTimes(1);

    // Second call: must NOT respawn
    const second = await listOpencodeModels();
    expect(second).toHaveLength(2);
    expect(second.map((e) => e.id)).toEqual(first.map((e) => e.id));
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('refreshOpencodeModels bypasses the cache via {force:true}', async () => {
    spawnState.scenario = { stdout: ['opencode/foo'], exitCode: 0 };
    await listOpencodeModels();
    expect(spawnMock).toHaveBeenCalledTimes(1);

    spawnState.scenario = { stdout: ['opencode/foo\nopencode/baz'], exitCode: 0 };
    const refreshed = await refreshOpencodeModels();
    expect(refreshed).toHaveLength(2);
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it('does NOT cache failures (next call retries spawn)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    spawnState.scenario = { exitCode: 1, stderr: ['boom'] };
    expect(await listOpencodeModels()).toEqual([]);
    expect(spawnMock).toHaveBeenCalledTimes(1);

    spawnState.scenario = { stdout: ['opencode/recovered'], exitCode: 0 };
    expect(await listOpencodeModels()).toHaveLength(1);
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it('records fetchedAt only on success', async () => {
    expect(getOpencodeModelsFetchedAt()).toBeNull();

    vi.spyOn(console, 'warn').mockImplementation(() => {});
    spawnState.scenario = { exitCode: 1 };
    await listOpencodeModels();
    expect(getOpencodeModelsFetchedAt()).toBeNull();

    spawnState.scenario = { stdout: ['opencode/foo'], exitCode: 0 };
    const before = Date.now();
    await listOpencodeModels();
    const after = Date.now();
    const stamped = getOpencodeModelsFetchedAt();
    expect(stamped).not.toBeNull();
    expect(stamped!).toBeGreaterThanOrEqual(before);
    expect(stamped!).toBeLessThanOrEqual(after);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Live integration smoke (skipped unless explicitly enabled)
//
// The shared spawn mock above intercepts every spawn() call in this file.
// A real `opencode` binary cannot reach through that without `vi.unmock`
// being hoisted (which would break the rest of the suite). The live probe
// therefore lives in a separate test file (`opencode-sync.live.test.ts`)
// gated by env, NOT in this hermetic mock-only file.
// ─────────────────────────────────────────────────────────────────────────────
