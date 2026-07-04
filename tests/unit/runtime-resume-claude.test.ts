import { describe, expect, it } from 'vitest';

import { initDb } from '../../src/db/client.js';
import {
  canResumeRuntimeSession,
  RuntimeProcessPool,
} from '../../src/runtime/process-pool.js';
import {
  appendRuntimeStreamEvent,
  createRuntimeSession,
  getRuntimeSession,
  heartbeatRuntimeSession,
  startRuntimeTurn,
  updateRuntimeSessionStatus,
  type RuntimeSessionRow,
} from '../../src/runtime/store.js';

/**
 * Mock-based coverage for the persistent runtime session lifecycle of the
 * Claude executor (cli:claude-code). No real Claude CLI is spawned — these
 * tests exercise the store + process-pool helpers against an in-memory SQLite
 * the same way the existing runtime-process-pool.test.ts and
 * runtime-store.test.ts suites do.
 *
 * NOTE on the redaction case from the F2-3 plan: tests/unit/runtime-events-redaction.test.ts
 * already pins both layers (events.ts redactRuntimeValue + store.ts json() wrapper)
 * for stream events. We therefore omit a duplicate redaction test here and limit
 * ourselves to a no-leak assertion inside the lifecycle test.
 */

const CLAUDE_EXECUTOR = 'cli:claude-code';
const CLAUDE_WORKSPACE = 'C:/repo/aurora';

function insertWorkflow(db: ReturnType<typeof initDb>, workflowId: string): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO workflows
       (id, workspace, objective, status, started_at, completed_at, created_at, created_by)
     VALUES (?, 'internal', 'runtime resume claude smoke', 'executing', ?, NULL, ?, 'test')`,
  ).run(workflowId, now, now);
}

function startClaudeSession(
  db: ReturnType<typeof initDb>,
  workflowId: string,
  overrides: Partial<{ workspacePath: string; nativeSessionId: string | null }> = {},
): RuntimeSessionRow {
  const pool = new RuntimeProcessPool();
  return pool.startSession(db, {
    workflowId,
    executorId: CLAUDE_EXECUTOR,
    protocolTier: 'jsonl-headless',
    streamFormat: 'claude-stream-json',
    workspacePath: overrides.workspacePath ?? CLAUDE_WORKSPACE,
    profile: 'code',
    runMode: 'approved-run',
    nativeSessionId: overrides.nativeSessionId ?? 'claude-native-session-1',
    dryRun: true,
  });
}

describe('runtime persistent session lifecycle (cli:claude-code)', () => {
  it('create -> heartbeat -> end transitions status and refreshes last_heartbeat_at without leaking secrets', async () => {
    const db = initDb(':memory:');
    insertWorkflow(db, 'wf_resume_lifecycle');

    const initial = createRuntimeSession(db, {
      workflowId: 'wf_resume_lifecycle',
      executorId: CLAUDE_EXECUTOR,
      protocolTier: 'jsonl-headless',
      streamFormat: 'claude-stream-json',
      runtimeMode: 'persistent',
      workspacePath: CLAUDE_WORKSPACE,
      runMode: 'approved-run',
      approvalStatus: 'approved',
      nativeSessionId: 'claude-native-session-lifecycle',
      metadata: {
        profile: 'code',
        process_state: 'live',
        last_heartbeat_at: Date.now() - 5000,
      },
    });

    expect(initial.status).toBe('active');
    expect(initial.runtime_mode).toBe('persistent');
    const initialMetadata = JSON.parse(initial.metadata_json) as Record<string, unknown>;
    const initialHeartbeat = Number(initialMetadata.last_heartbeat_at);
    expect(Number.isFinite(initialHeartbeat)).toBe(true);

    // Persist a stream event whose payload contains an obvious secret to make
    // sure the lifecycle helpers do not bypass the store-side redaction wrapper.
    const turn = startRuntimeTurn(db, {
      sessionId: initial.id,
      workflowId: 'wf_resume_lifecycle',
      attempt: 1,
      promptSummary: 'lifecycle-probe',
    });
    appendRuntimeStreamEvent(db, {
      sessionId: initial.id,
      turnId: turn.id,
      workflowId: 'wf_resume_lifecycle',
      event: {
        type: 'assistant.message',
        ts: Date.now(),
        executorId: CLAUDE_EXECUTOR,
        text: 'connected with Bearer eyJabc123def456ghi789jklmnopq token',
      },
    });

    // Wait one millisecond so the heartbeat timestamp is strictly greater.
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
    const beat = heartbeatRuntimeSession(db, initial.id);
    expect(beat).not.toBeNull();
    const beatMetadata = JSON.parse(beat!.metadata_json) as Record<string, unknown>;
    const beatHeartbeat = Number(beatMetadata.last_heartbeat_at);
    expect(beatHeartbeat).toBeGreaterThan(initialHeartbeat);
    expect(beat!.status).toBe('active');

    const ended = updateRuntimeSessionStatus(db, initial.id, 'archived', {
      process_state: 'dead',
      end_reason: 'lifecycle-test-end',
      ended_at: Date.now(),
    });
    expect(ended).not.toBeNull();
    expect(ended!.status).toBe('archived');
    const endedMetadata = JSON.parse(ended!.metadata_json) as Record<string, unknown>;
    expect(endedMetadata).toMatchObject({
      process_state: 'dead',
      end_reason: 'lifecycle-test-end',
    });

    // No leaked secrets in the persisted session metadata or stream event rows.
    const sessionRow = getRuntimeSession(db, initial.id);
    expect(sessionRow).not.toBeNull();
    expect(sessionRow!.metadata_json).not.toContain('eyJabc123def456ghi789jklmnopq');
    const persistedEvent = db
      .prepare(`SELECT event_json FROM runtime_stream_events WHERE session_id = ?`)
      .get(initial.id) as { event_json: string } | undefined;
    expect(persistedEvent).toBeDefined();
    expect(persistedEvent!.event_json).not.toContain('eyJabc123def456ghi789jklmnopq');
    expect(persistedEvent!.event_json).toContain('***REDACTED***');

    db.close();
  });

  it('canResumeRuntimeSession returns true when executor, workspace, profile, and run mode match', () => {
    const db = initDb(':memory:');
    insertWorkflow(db, 'wf_resume_match');

    const session = startClaudeSession(db, 'wf_resume_match');
    const decision = canResumeRuntimeSession(session, {
      executorId: CLAUDE_EXECUTOR,
      workspacePath: CLAUDE_WORKSPACE,
      profile: 'code',
      runMode: 'approved-run',
    });

    expect(decision.canResume).toBe(true);
    expect(decision.reason).toContain('match');

    db.close();
  });

  it('canResumeRuntimeSession returns false on executor mismatch, workspace mismatch, or non-active status', () => {
    const db = initDb(':memory:');
    insertWorkflow(db, 'wf_resume_mismatch');

    const session = startClaudeSession(db, 'wf_resume_mismatch');

    const executorMismatch = canResumeRuntimeSession(session, {
      executorId: 'cli:codex',
      workspacePath: CLAUDE_WORKSPACE,
      profile: 'code',
      runMode: 'approved-run',
    });
    expect(executorMismatch.canResume).toBe(false);
    expect(executorMismatch.reason).toContain('executor mismatch');

    const workspaceMismatch = canResumeRuntimeSession(session, {
      executorId: CLAUDE_EXECUTOR,
      workspacePath: 'C:/repo/other-project',
      profile: 'code',
      runMode: 'approved-run',
    });
    expect(workspaceMismatch.canResume).toBe(false);
    expect(workspaceMismatch.reason).toContain('workspace');

    // Failed status is not 'active' so resume must be refused regardless of
    // executor/workspace matching.
    const failed = updateRuntimeSessionStatus(db, session.id, 'failed', {
      failure_reason: 'simulated executor crash',
    });
    expect(failed).not.toBeNull();
    const failedDecision = canResumeRuntimeSession(failed!, {
      executorId: CLAUDE_EXECUTOR,
      workspacePath: CLAUDE_WORKSPACE,
      profile: 'code',
      runMode: 'approved-run',
    });
    expect(failedDecision.canResume).toBe(false);
    expect(failedDecision.reason).toContain('status');

    db.close();
  });

  it('a stale session is not resumable; explicit recovery (status -> active + heartbeat refresh) restores resumability', async () => {
    const db = initDb(':memory:');
    insertWorkflow(db, 'wf_resume_stale_recovery');

    const session = startClaudeSession(db, 'wf_resume_stale_recovery');

    // Simulate a heartbeat that landed roughly ten minutes ago and let the
    // pool transition the session into the stale state. canResumeRuntimeSession
    // must refuse stale sessions even though executor and workspace still match.
    const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
    const stalePatch = updateRuntimeSessionStatus(db, session.id, 'active', {
      last_heartbeat_at: tenMinutesAgo,
    });
    expect(stalePatch).not.toBeNull();

    const pool = new RuntimeProcessPool();
    const stale = pool.markStale(db, session.id, 'heartbeat timeout (10 minutes)');
    expect(stale).not.toBeNull();
    expect(stale!.status).toBe('stale');

    const refusedAfterStale = canResumeRuntimeSession(stale!, {
      executorId: CLAUDE_EXECUTOR,
      workspacePath: CLAUDE_WORKSPACE,
      profile: 'code',
      runMode: 'approved-run',
    });
    expect(refusedAfterStale.canResume).toBe(false);
    expect(refusedAfterStale.reason).toContain('status');

    // Explicit recovery: caller flips status back to active AND refreshes the
    // heartbeat. canResumeRuntimeSession must once again accept the session.
    const recoveredStatus = updateRuntimeSessionStatus(db, session.id, 'active', {
      process_state: 'live',
      recovered_from: 'stale',
      recovered_at: Date.now(),
    });
    expect(recoveredStatus).not.toBeNull();
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
    const recovered = heartbeatRuntimeSession(db, session.id);
    expect(recovered).not.toBeNull();
    expect(recovered!.status).toBe('active');
    const recoveredMetadata = JSON.parse(recovered!.metadata_json) as Record<string, unknown>;
    expect(Number(recoveredMetadata.last_heartbeat_at)).toBeGreaterThan(tenMinutesAgo);

    const allowedAgain = canResumeRuntimeSession(recovered!, {
      executorId: CLAUDE_EXECUTOR,
      workspacePath: CLAUDE_WORKSPACE,
      profile: 'code',
      runMode: 'approved-run',
    });
    expect(allowedAgain.canResume).toBe(true);
    expect(allowedAgain.reason).toContain('match');

    db.close();
  });
});
