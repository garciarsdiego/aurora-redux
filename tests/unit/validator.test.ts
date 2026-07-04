import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Workflow } from '../../src/types/index.js';
import { initDb } from '../../src/db/client.js';
import {
  parseValidationOutput,
  runFinalValidation,
} from '../../src/brain/validator.js';
import type { DetectedProject } from '../../src/brain/projectDetector.js';

// D35 — regression tests for final validation step.

vi.mock('../../src/executors/cli.js', () => ({
  runCliTask: vi.fn(),
}));

function makeWorkflow(): Workflow {
  return {
    id: 'wf_test_001',
    workspace: '__test__',
    objective: 'do something at C:/tmp/project',
    pattern_id: null,
    status: 'executing',
    started_at: Date.now(),
    completed_at: null,
    created_at: Date.now(),
    created_by: null,
    estimated_cost_usd: null,
    actual_cost_usd: null,
    metadata: null,
  };
}

function makeProject(): DetectedProject {
  return { type: 'typescript', rootDir: 'C:/tmp/project' };
}

function eventTypes(db: ReturnType<typeof initDb>, wfId: string): string[] {
  return (
    db
      .prepare(
        'SELECT type FROM events WHERE workflow_id = ? ORDER BY timestamp',
      )
      .all(wfId) as Array<{ type: string }>
  ).map((r) => r.type);
}

describe('parseValidationOutput', () => {
  it('recognises VALIDATION OK on last line', () => {
    const r = parseValidationOutput('some noise\nmore logs\nVALIDATION OK');
    expect(r.passed).toBe(true);
    expect(r.summary).toBe('OK');
  });

  it('recognises VALIDATION FAILED with summary', () => {
    const r = parseValidationOutput(
      'tsc errors here\nVALIDATION FAILED: 3 type errors in src/auth',
    );
    expect(r.passed).toBe(false);
    expect(r.summary).toBe('3 type errors in src/auth');
  });

  it('handles VALIDATION FAILED without colon', () => {
    const r = parseValidationOutput('VALIDATION FAILED no details');
    expect(r.passed).toBe(false);
  });

  it('returns passed:false with explanation when no marker found', () => {
    const r = parseValidationOutput('just some output with no marker');
    expect(r.passed).toBe(false);
    expect(r.summary).toContain('did not emit');
  });

  it('picks the last marker when multiple present', () => {
    const r = parseValidationOutput(
      'VALIDATION FAILED: first attempt\nfixed it\nVALIDATION OK',
    );
    expect(r.passed).toBe(true);
  });
});

describe('runFinalValidation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns passed on first attempt when cli outputs VALIDATION OK', async () => {
    const { runCliTask } = await import('../../src/executors/cli.js');
    vi.mocked(runCliTask).mockResolvedValue('all good\nVALIDATION OK');

    const db = initDb(':memory:');
    const wf = makeWorkflow();
    // Insert workflow so FK constraints on events pass
    db.prepare(
      `INSERT INTO workflows (id, workspace, objective, pattern_id, status, started_at, completed_at, created_at, created_by, estimated_cost_usd, actual_cost_usd, metadata) VALUES (?, ?, ?, NULL, 'executing', ?, NULL, ?, NULL, NULL, NULL, NULL)`,
    ).run(wf.id, wf.workspace, wf.objective, wf.started_at, wf.created_at);

    const result = await runFinalValidation(db, wf, makeProject());

    expect(result.passed).toBe(true);
    expect(result.attempts).toBe(1);
    expect(vi.mocked(runCliTask)).toHaveBeenCalledTimes(1);

    const types = eventTypes(db, wf.id);
    expect(types).toContain('workflow_validation_started');
    expect(types).toContain('workflow_validation_passed');
    expect(types).not.toContain('workflow_validation_exhausted');

    db.close();
  });

  it('retries once and passes on attempt 2', async () => {
    const { runCliTask } = await import('../../src/executors/cli.js');
    vi.mocked(runCliTask)
      .mockResolvedValueOnce('errors\nVALIDATION FAILED: 2 errors')
      .mockResolvedValueOnce('fixed\nVALIDATION OK');

    const db = initDb(':memory:');
    const wf = makeWorkflow();
    db.prepare(
      `INSERT INTO workflows (id, workspace, objective, pattern_id, status, started_at, completed_at, created_at, created_by, estimated_cost_usd, actual_cost_usd, metadata) VALUES (?, ?, ?, NULL, 'executing', ?, NULL, ?, NULL, NULL, NULL, NULL)`,
    ).run(wf.id, wf.workspace, wf.objective, wf.started_at, wf.created_at);

    const result = await runFinalValidation(db, wf, makeProject(), {
      maxAttempts: 3,
    });

    expect(result.passed).toBe(true);
    expect(result.attempts).toBe(2);

    const types = eventTypes(db, wf.id);
    expect(types).toContain('workflow_validation_failed');
    expect(types).toContain('workflow_validation_passed');

    db.close();
  });

  it('exhausts attempts when cli keeps failing', async () => {
    const { runCliTask } = await import('../../src/executors/cli.js');
    vi.mocked(runCliTask).mockResolvedValue('still broken\nVALIDATION FAILED: 5 errors remain');

    const db = initDb(':memory:');
    const wf = makeWorkflow();
    db.prepare(
      `INSERT INTO workflows (id, workspace, objective, pattern_id, status, started_at, completed_at, created_at, created_by, estimated_cost_usd, actual_cost_usd, metadata) VALUES (?, ?, ?, NULL, 'executing', ?, NULL, ?, NULL, NULL, NULL, NULL)`,
    ).run(wf.id, wf.workspace, wf.objective, wf.started_at, wf.created_at);

    const result = await runFinalValidation(db, wf, makeProject(), {
      maxAttempts: 2,
    });

    expect(result.passed).toBe(false);
    expect(result.attempts).toBe(2);
    expect(result.summary).toContain('5 errors');

    const types = eventTypes(db, wf.id);
    expect(types).toContain('workflow_validation_exhausted');

    db.close();
  });

  it('skips gracefully for project type "other"', async () => {
    const db = initDb(':memory:');
    const wf = makeWorkflow();
    db.prepare(
      `INSERT INTO workflows (id, workspace, objective, pattern_id, status, started_at, completed_at, created_at, created_by, estimated_cost_usd, actual_cost_usd, metadata) VALUES (?, ?, ?, NULL, 'executing', ?, NULL, ?, NULL, NULL, NULL, NULL)`,
    ).run(wf.id, wf.workspace, wf.objective, wf.started_at, wf.created_at);

    const result = await runFinalValidation(db, wf, {
      type: 'other',
      rootDir: 'C:/tmp/project',
    });

    expect(result.passed).toBe(true); // skip counts as pass
    expect(result.attempts).toBe(0);
    expect(result.summary).toContain('skipped');

    const { runCliTask } = await import('../../src/executors/cli.js');
    expect(vi.mocked(runCliTask)).not.toHaveBeenCalled();

    const types = eventTypes(db, wf.id);
    expect(types).toContain('workflow_validation_skipped');

    db.close();
  });

  it('handles runCliTask rejection as a failed attempt', async () => {
    const { runCliTask } = await import('../../src/executors/cli.js');
    vi.mocked(runCliTask)
      .mockRejectedValueOnce(new Error('cli crashed'))
      .mockResolvedValueOnce('VALIDATION OK');

    const db = initDb(':memory:');
    const wf = makeWorkflow();
    db.prepare(
      `INSERT INTO workflows (id, workspace, objective, pattern_id, status, started_at, completed_at, created_at, created_by, estimated_cost_usd, actual_cost_usd, metadata) VALUES (?, ?, ?, NULL, 'executing', ?, NULL, ?, NULL, NULL, NULL, NULL)`,
    ).run(wf.id, wf.workspace, wf.objective, wf.started_at, wf.created_at);

    const result = await runFinalValidation(db, wf, makeProject(), {
      maxAttempts: 2,
    });

    expect(result.passed).toBe(true); // 2nd attempt succeeded
    expect(result.attempts).toBe(2);

    const types = eventTypes(db, wf.id);
    expect(types).toContain('workflow_validation_error');
    expect(types).toContain('workflow_validation_passed');

    db.close();
  });
});
