/**
 * Aurora-parity Wave 1 — runTestValidation self-fix loop (validator.ts).
 * The test-runner primitives + CLI fix are mocked so we exercise ONLY the loop
 * orchestration: run → pass | (fail → CLI fix → re-run) → pass/exhaust, plus the
 * skip paths (no command / disabled). Real in-memory DB for the event + FK path.
 */

import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/brain/validation/test-runner.js', () => ({
  detectTestCommand: vi.fn(),
  runTestCommandConstrained: vi.fn(),
  DEFAULT_TEST_PROFILE: { timeoutMs: 1000, networkOff: true },
}));
vi.mock('../../src/executors/cli.js', () => ({ runCliTask: vi.fn().mockResolvedValue('fix done') }));

import { initDb } from '../../src/db/client.js';
import { insertWorkflow } from '../../src/db/persist.js';
import { runTestValidation } from '../../src/brain/validator.js';
import { detectTestCommand, runTestCommandConstrained } from '../../src/brain/validation/test-runner.js';
import { runCliTask } from '../../src/executors/cli.js';
import type { Workflow } from '../../src/types/index.js';
import type { DetectedProject } from '../../src/brain/projectDetector.js';

const PROJECT: DetectedProject = { type: 'typescript', rootDir: '/tmp/fake-proj' };

function pass() { return { ran: true, passed: true, command: 'pnpm test', output: '', failureSummary: '', timedOut: false, exitCode: 0 }; }
function fail() { return { ran: true, passed: false, command: 'pnpm test', output: 'AssertionError: 1 !== 2', failureSummary: 'AssertionError: 1 !== 2', timedOut: false, exitCode: 1 }; }

let db: Database.Database;
beforeEach(() => {
  vi.clearAllMocks();
  delete process.env['DISABLE_TEST_VALIDATION'];
  db = initDb(':memory:');
  const wf: Workflow = {
    id: 'wf-test', workspace: 'internal', objective: 'build at /tmp/fake-proj', pattern_id: null,
    status: 'executing', started_at: Date.now(), completed_at: null, created_at: Date.now(),
    created_by: 'test', estimated_cost_usd: null, actual_cost_usd: null, max_total_cost_usd: null,
    max_duration_seconds: null, metadata: null,
  } as Workflow;
  insertWorkflow(db, wf);
});
afterEach(() => { db.close(); });

function wf(): Workflow {
  return { id: 'wf-test', workspace: 'internal' } as Workflow;
}

describe('runTestValidation', () => {
  it('passes on attempt 1 without spawning a fix', async () => {
    vi.mocked(detectTestCommand).mockReturnValue('pnpm test');
    vi.mocked(runTestCommandConstrained).mockResolvedValueOnce(pass());

    const r = await runTestValidation(db, wf(), PROJECT, { maxAttempts: 2, perAttemptTimeoutMs: 500 });
    expect(r.ran).toBe(true);
    expect(r.passed).toBe(true);
    expect(r.attempts).toBe(1);
    expect(runCliTask).not.toHaveBeenCalled();
  });

  it('fails, hands the failure to the CLI fix, then passes on re-run', async () => {
    vi.mocked(detectTestCommand).mockReturnValue('pnpm test');
    vi.mocked(runTestCommandConstrained).mockResolvedValueOnce(fail()).mockResolvedValueOnce(pass());

    const r = await runTestValidation(db, wf(), PROJECT, { maxAttempts: 2, perAttemptTimeoutMs: 500 });
    expect(r.passed).toBe(true);
    expect(r.attempts).toBe(2);
    expect(runCliTask).toHaveBeenCalledTimes(1);
    // the fix prompt carries the parsed failure
    const promptTask = vi.mocked(runCliTask).mock.calls[0]![0] as { name: string };
    expect(promptTask.name).toMatch(/AssertionError/);
  });

  it('exhausts and returns failed when tests never pass (no fix after the last attempt)', async () => {
    vi.mocked(detectTestCommand).mockReturnValue('pnpm test');
    vi.mocked(runTestCommandConstrained).mockResolvedValue(fail());

    const r = await runTestValidation(db, wf(), PROJECT, { maxAttempts: 2, perAttemptTimeoutMs: 500 });
    expect(r.passed).toBe(false);
    expect(r.attempts).toBe(2);
    expect(r.summary).toMatch(/AssertionError/);
    expect(runCliTask).toHaveBeenCalledTimes(1); // fix only between attempts, not after the last
  });

  it('skips (ran=false, passed=true) when no test command is detected', async () => {
    vi.mocked(detectTestCommand).mockReturnValue(null);
    const r = await runTestValidation(db, wf(), PROJECT);
    expect(r.ran).toBe(false);
    expect(r.passed).toBe(true);
    expect(runTestCommandConstrained).not.toHaveBeenCalled();
    expect(runCliTask).not.toHaveBeenCalled();
  });

  it('skips when DISABLE_TEST_VALIDATION=true', async () => {
    process.env['DISABLE_TEST_VALIDATION'] = 'true';
    vi.mocked(detectTestCommand).mockReturnValue('pnpm test');
    const r = await runTestValidation(db, wf(), PROJECT);
    expect(r.ran).toBe(false);
    expect(r.passed).toBe(true);
    expect(runTestCommandConstrained).not.toHaveBeenCalled();
  });
});
