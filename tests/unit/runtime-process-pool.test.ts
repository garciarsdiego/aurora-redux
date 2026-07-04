import { describe, expect, it } from 'vitest';

import { initDb } from '../../src/db/client.js';
import { buildWorkflowDebugLog } from '../../src/db/workflow-debug-log.js';
import {
  canResumeRuntimeSession,
  RuntimeProcessPool,
  RuntimePoolEscalationError,
  runtimeProcessPool,
  tryAcquireRuntimeSession,
} from '../../src/runtime/process-pool.js';

function insertWorkflow(db: ReturnType<typeof initDb>, workflowId: string): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO workflows
       (id, workspace, objective, status, started_at, completed_at, created_at, created_by)
     VALUES (?, 'internal', 'runtime pool smoke', 'executing', ?, NULL, ?, 'test')`,
  ).run(workflowId, now, now);
}

describe('RuntimeProcessPool', () => {
  it('persists conservative persistent session lifecycle metadata without starting a CLI by default', () => {
    const db = initDb(':memory:');
    insertWorkflow(db, 'wf_pool');
    const pool = new RuntimeProcessPool();

    const session = pool.startSession(db, {
      workflowId: 'wf_pool',
      executorId: 'cli:claude-code',
      protocolTier: 'jsonl-headless',
      streamFormat: 'claude-stream-json',
      workspacePath: 'C:/repo/app',
      profile: 'code',
      runMode: 'approved-run',
      nativeSessionId: 'claude-session-1',
      dryRun: true,
    });

    expect(session.runtime_mode).toBe('persistent');
    expect(session.status).toBe('active');
    expect(JSON.parse(session.metadata_json)).toMatchObject({
      profile: 'code',
      process_state: 'metadata-only',
    });
    expect(canResumeRuntimeSession(session, {
      executorId: 'cli:claude-code',
      workspacePath: 'C:/repo/app',
      profile: 'code',
      runMode: 'approved-run',
    })).toMatchObject({ canResume: true });
    expect(canResumeRuntimeSession(session, {
      executorId: 'cli:claude-code',
      workspacePath: 'C:/other/app',
      profile: 'code',
      runMode: 'approved-run',
    }).reason).toContain('workspace');

    const stale = pool.markStale(db, session.id, 'test stale')!;
    expect(stale.status).toBe('stale');
    expect(JSON.stringify(buildWorkflowDebugLog(db, 'wf_pool'))).toContain('test stale');

    const ended = pool.endSession(db, session.id, 'test end')!;
    expect(ended.status).toBe('archived');
    expect(JSON.parse(ended.metadata_json)).toMatchObject({
      process_state: 'dead',
      end_reason: 'test end',
    });

    db.close();
  });

  it('rejects autonomous persistent sessions without approved-run metadata', () => {
    const db = initDb(':memory:');
    insertWorkflow(db, 'wf_pool_autonomous');
    const pool = new RuntimeProcessPool();

    expect(() => pool.startSession(db, {
      workflowId: 'wf_pool_autonomous',
      executorId: 'cli:claude-code',
      protocolTier: 'jsonl-headless',
      streamFormat: 'claude-stream-json',
      profile: 'autonomous',
      runMode: 'dry-run',
      dryRun: true,
    })).toThrow(/approved-run/);

    db.close();
  });
});

describe('tryAcquireRuntimeSession (Wave 2.2 F2-4 gate helper)', () => {
  it('creates a metadata-only session and returns a handle with reused=false', async () => {
    const db = initDb(':memory:');
    insertWorkflow(db, 'wf_acquire_meta_only');

    // Note: taskId is intentionally omitted because the runtime_sessions schema
    // declares task_id as a foreign key into tasks(id). The production gate in
    // run-task.ts always passes a real task.id; in this isolated unit we keep
    // the row's task_id null to avoid materialising a full tasks fixture.
    const handle = await tryAcquireRuntimeSession(db, {
      workflowId: 'wf_acquire_meta_only',
      executorId: 'cli:claude-code',
      protocolTier: 'jsonl-headless',
      streamFormat: 'claude-stream-json',
      workspacePath: 'C:/repo/aurora',
      profile: 'code',
      runMode: 'dry-run',
      approvalStatus: 'not_required',
      auditStatus: 'recorded',
    });

    expect(handle).not.toBeNull();
    expect(handle!.reused).toBe(false);
    expect(handle!.profile).toBe('code');
    expect(handle!.runMode).toBe('dry-run');
    expect(handle!.workspacePath).toBe('C:/repo/aurora');
    expect(typeof handle!.sessionId).toBe('string');
    expect(handle!.sessionId.length).toBeGreaterThan(0);

    // Verify the row was actually persisted with metadata-only state.
    const row = db
      .prepare('SELECT runtime_mode, status, executor_id, metadata_json FROM runtime_sessions WHERE id = ?')
      .get(handle!.sessionId) as
        | { runtime_mode: string; status: string; executor_id: string; metadata_json: string }
        | undefined;
    expect(row).toBeDefined();
    expect(row!.runtime_mode).toBe('persistent');
    expect(row!.status).toBe('active');
    expect(row!.executor_id).toBe('cli:claude-code');
    expect(JSON.parse(row!.metadata_json)).toMatchObject({
      profile: 'code',
      process_state: 'metadata-only',
    });

    db.close();
  });

  it('throws RuntimePoolEscalationError when autonomous profile + dry-run mode', async () => {
    const db = initDb(':memory:');
    insertWorkflow(db, 'wf_acquire_escalation');

    await expect(
      tryAcquireRuntimeSession(db, {
        workflowId: 'wf_acquire_escalation',
        executorId: 'cli:claude-code',
        protocolTier: 'jsonl-headless',
        streamFormat: 'claude-stream-json',
        profile: 'autonomous',
        runMode: 'dry-run',
      }),
    ).rejects.toBeInstanceOf(RuntimePoolEscalationError);

    // No row should exist for the would-be session — the gate refused before
    // any write.
    const count = db
      .prepare(`SELECT COUNT(*) AS n FROM runtime_sessions WHERE workflow_id = ?`)
      .get('wf_acquire_escalation') as { n: number };
    expect(count.n).toBe(0);

    db.close();
  });

  it('returns null when the underlying pool throws a non-escalation error', async () => {
    const db = initDb(':memory:');
    insertWorkflow(db, 'wf_acquire_pool_failure');

    // Force the pool to throw by stubbing startSession to simulate a transient
    // pool failure. We restore the original at the end so other tests in the
    // file are unaffected.
    const originalStartSession = runtimeProcessPool.startSession.bind(runtimeProcessPool);
    runtimeProcessPool.startSession = (() => {
      throw new Error('simulated pool failure');
    }) as typeof runtimeProcessPool.startSession;

    try {
      const handle = await tryAcquireRuntimeSession(db, {
        workflowId: 'wf_acquire_pool_failure',
        executorId: 'cli:claude-code',
        protocolTier: 'jsonl-headless',
        streamFormat: 'claude-stream-json',
        workspacePath: 'C:/repo/aurora',
        profile: 'code',
        runMode: 'dry-run',
      });
      expect(handle).toBeNull();

      // No row persisted because startSession threw.
      const count = db
        .prepare(`SELECT COUNT(*) AS n FROM runtime_sessions WHERE workflow_id = ?`)
        .get('wf_acquire_pool_failure') as { n: number };
      expect(count.n).toBe(0);
    } finally {
      runtimeProcessPool.startSession = originalStartSession;
      db.close();
    }
  });
});

