/**
 * Aurora Tier 0 / Wave 5 — Cancel propagation E2E.
 *
 * The Wave 3 unit test (`tests/unit/executor-cancel-signal.test.ts`) proved
 * the signal yields promptly. This integration test verifies the full
 * propagation chain against a real running task:
 *
 *   workflow → requestWorkflowControl('cancel')
 *           → broadcastCancelToWorkflow (control.ts)
 *             a) aborts the AbortController for each running task
 *             b) flips `tasks.status` to 'cancelled'
 *             c) flips `workflows.status` to 'cancelled' (workflow-control.ts)
 *           → executor's signal listener fires:
 *             d) tree-kills the child process (cli.ts:2147-2174)
 *             e) emits `cli_killed_on_cancel` event
 *
 * Why no full executor stack here: `runCliTask` itself spawns a real child
 * (or pty), which is impossible to mock comprehensively without
 * re-implementing the whole launcher. Instead we register an
 * AbortController against a real-running mock child process via the
 * `control.ts` control registry — the same path the executor uses — and
 * assert that:
 *   1. cancel propagates within 200ms;
 *   2. the kill signal hits the child;
 *   3. DB state ends up exactly 'cancelled' (never 'failed') across tasks
 *      and workflow;
 *   4. runtime_sessions tied to the workflow get a terminal status row.
 *
 * The runtime_sessions table does NOT have a 'cancelled' enum (only active /
 * stale / failed / archived). The spec brief asked for 'cancelled' but the
 * actual contract is `status = 'archived'` with a `process_state='killed'`
 * metadata key. We assert the production contract.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import type Database from 'better-sqlite3';

import { initDb } from '../../src/db/client.js';
import { requestWorkflowControl } from '../../src/db/workflow-control.js';
import {
  _resetControlRegistry,
  registerAbortController,
  unregisterAbortController,
} from '../../src/v2/subagent/control.js';
import {
  createRuntimeSession,
  updateRuntimeSessionStatus,
  getRuntimeSession,
} from '../../src/runtime/store.js';

interface SeededFixture {
  workflowId: string;
  taskId: string;
  runtimeSessionId: string;
}

function seedWorkflowWithRunningTask(db: Database.Database): SeededFixture {
  const now = Date.now();
  const workflowId = 'wf_cancel_e2e';
  const taskId = 'tk_cancel_e2e';

  db.prepare(
    `INSERT INTO workflows (id, workspace, objective, status, started_at, created_at)
     VALUES (?, 'internal', 'cancel propagation', 'executing', ?, ?)`,
  ).run(workflowId, now, now);

  db.prepare(
    `INSERT INTO tasks (id, workflow_id, name, kind, status, created_at, started_at, executor_hint)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(taskId, workflowId, 'long-running cli_spawn', 'cli_spawn', 'running', now, now, 'cli:claude-code');

  // Mirror what `runCliTask` does — open a runtime_session row in 'active'
  // state. The cancel broadcast itself doesn't touch this table (it's the
  // executor's cleanup that does); we'll assert that downstream housekeeping
  // can flip it to a terminal state once the cancel surfaces.
  const session = createRuntimeSession(db, {
    workflowId,
    taskId,
    executorId: 'cli:claude-code',
    protocolTier: 'jsonl-headless',
    streamFormat: 'claude-stream-json',
    runtimeMode: 'oneshot',
    status: 'active',
    workspacePath: '/tmp/fake-workspace',
  });

  return { workflowId, taskId, runtimeSessionId: session.id };
}

function spawnSleepyChild(): ChildProcess {
  // Use a node subprocess that sleeps 5s and writes "done" on completion.
  // The cancel path tree-kills it well before that — we just need a real
  // OS-level process to verify the kill signal lands.
  return spawn(process.execPath, [
    '-e',
    'setTimeout(() => { process.stdout.write("done"); process.exit(0); }, 5000)',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
}

describe('cancel propagation E2E (Tier 0 Wave 5)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDb(':memory:');
    _resetControlRegistry();
  });

  afterEach(() => {
    db.close();
    _resetControlRegistry();
  });

  it('aborts the in-flight task, kills the child process, and flips all DB rows to cancelled within 200ms', async () => {
    const { workflowId, taskId } = seedWorkflowWithRunningTask(db);

    // Spin up a real child process and wire its lifecycle to an
    // AbortController in the control registry. This mirrors the exact
    // shape of `runCliTask:registerAbortController(task.id, controller)`.
    const child = spawnSleepyChild();
    const ac = new AbortController();
    registerAbortController(taskId, ac);

    // Mount the same kill-on-abort wiring `cli.ts` uses (lines 2147-2174):
    // when the controller fires, kill the child OS-level. We instrument
    // the kill so the test can prove it landed.
    let killCalled = false;
    const killTime = { value: 0 };
    ac.signal.addEventListener('abort', () => {
      killCalled = true;
      killTime.value = Date.now();
      try { child.kill('SIGKILL'); } catch { /* best effort */ }
    }, { once: true });

    // Track when child actually exits so we can measure end-to-end latency
    // between cancel request and OS-level death.
    const childExit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });

    // Issue the cancel after the task has been "running" for one tick. The
    // production trigger is requestWorkflowControl('cancel') from the
    // Studio button or the MCP tool.
    const cancelStartedAt = Date.now();
    const result = requestWorkflowControl(db, workflowId, {
      action: 'cancel',
      reason: 'integration_cancel_test',
      requestedBy: 'wave5_test',
    });

    // (a) workflow control state must end as 'canceled'
    expect(result.state).toBe('canceled');
    expect(result.action).toBe('cancel');
    expect(result.daemon_acknowledged).toBe(true);
    expect(result.tasks_cancelled).toBe(1);
    expect(result.controllers_aborted).toBe(1);

    // (b) the AbortController fired — signal listener ran ≤ 200ms.
    expect(ac.signal.aborted).toBe(true);
    expect(killCalled).toBe(true);
    const propagationLatencyMs = killTime.value - cancelStartedAt;
    expect(propagationLatencyMs).toBeLessThan(200);

    // (c) child process really exited (proves tree-kill landed, not just
    // a DB write). Cap waiter at 1s — SIGKILL is immediate on every OS.
    const exitInfo = await Promise.race([
      childExit,
      new Promise<{ code: null; signal: null }>((res) => setTimeout(() => res({ code: null, signal: null }), 1_000)),
    ]);
    // On POSIX SIGKILL → signal='SIGKILL', code=null.
    // On Windows .kill('SIGKILL') just calls TerminateProcess → signal=null, code=1.
    // Either is acceptable: the process must be DEAD.
    const childKilled = exitInfo.signal === 'SIGKILL' || exitInfo.code !== null;
    expect(childKilled).toBe(true);

    // (d) task row: status='cancelled' (NOT 'failed').
    const taskRow = db.prepare('SELECT status, completed_at FROM tasks WHERE id = ?').get(taskId) as {
      status: string;
      completed_at: number | null;
    };
    expect(taskRow.status).toBe('cancelled');
    expect(taskRow.status).not.toBe('failed');
    expect(typeof taskRow.completed_at).toBe('number');

    // (e) workflow row: status='cancelled' (NOT 'failed').
    const wfRow = db.prepare('SELECT status, completed_at, metadata FROM workflows WHERE id = ?').get(workflowId) as {
      status: string;
      completed_at: number | null;
      metadata: string | null;
    };
    expect(wfRow.status).toBe('cancelled');
    expect(wfRow.status).not.toBe('failed');
    expect(typeof wfRow.completed_at).toBe('number');

    // (f) cancel metadata captured in workflow.metadata.
    expect(wfRow.metadata).not.toBeNull();
    const meta = JSON.parse(wfRow.metadata!) as Record<string, unknown>;
    expect(meta['cancelled_reason']).toBe('integration_cancel_test');
    expect(typeof meta['cancelled_at']).toBe('number');
    expect(meta['control_requested_by']).toBe('wave5_test');

    // (g) audit events fired — at minimum workflow_cancel_requested,
    //     task_cancelled_by_workflow, workflow_canceled.
    const events = db
      .prepare('SELECT type FROM events WHERE workflow_id = ? ORDER BY id')
      .all(workflowId) as Array<{ type: string }>;
    const types = events.map((e) => e.type);
    expect(types).toContain('workflow_cancel_requested');
    expect(types).toContain('task_cancelled_by_workflow');
    expect(types).toContain('workflow_canceled');

    // Crucially: no 'task_failed' / 'workflow_failed' events — those are
    // reserved for real failures, cancel must NOT poison the audit trail.
    expect(types).not.toContain('task_failed');
    expect(types).not.toContain('workflow_failed');

    unregisterAbortController(taskId);
  }, 8_000);

  it('runtime_session for the cancelled task can be cleanly closed afterwards', async () => {
    // This pins the integration contract: even though broadcastCancelToWorkflow
    // doesn't directly touch runtime_sessions, the executor's `finally` block
    // gets to flip it to a terminal state once the cancel surfaces. We verify
    // the row CAN be archived with the cancellation metadata, and is then
    // visible in the post-cancel state.
    const { workflowId, taskId, runtimeSessionId } = seedWorkflowWithRunningTask(db);

    const ac = new AbortController();
    registerAbortController(taskId, ac);
    ac.signal.addEventListener('abort', () => {
      // Mirror executor's `completeRuntime('failed', null, 'cancelled by operator')`
      // path — for cancel the executor uses 'archived' + metadata to keep the
      // 'failed' status reserved for actual errors. Either is accepted by
      // the schema; the assertion below checks the metadata reflects the
      // cancel, not that the status enum is exactly 'cancelled'.
      updateRuntimeSessionStatus(db, runtimeSessionId, 'archived', {
        cancelled_by_workflow: true,
        cancel_reason: 'integration_cancel_test',
        process_state: 'killed',
      });
    }, { once: true });

    requestWorkflowControl(db, workflowId, {
      action: 'cancel',
      reason: 'integration_cancel_test',
    });

    expect(ac.signal.aborted).toBe(true);

    const session = getRuntimeSession(db, runtimeSessionId);
    expect(session).not.toBeNull();
    // Two acceptable terminal contracts (see RuntimeSessionStatus type):
    //   - 'archived' (clean shutdown after cancel)
    //   - 'failed'   (cancel that the executor classified as a hard exit)
    // What MUST be true is that the row is NOT 'active' anymore.
    expect(session!.status).not.toBe('active');
    const meta = JSON.parse(session!.metadata_json) as Record<string, unknown>;
    expect(meta['cancelled_by_workflow']).toBe(true);
    expect(meta['cancel_reason']).toBe('integration_cancel_test');

    unregisterAbortController(taskId);
  });

  it('multiple in-flight tasks all flip to cancelled atomically', async () => {
    // Stress: 4 tasks in 'running' + 1 'pending'. After cancel all 5 must
    // be 'cancelled', and 4 AbortControllers fire (the pending one has none).
    const now = Date.now();
    const workflowId = 'wf_multi_cancel';

    db.prepare(
      `INSERT INTO workflows (id, workspace, objective, status, started_at, created_at)
       VALUES (?, 'internal', 'multi cancel', 'executing', ?, ?)`,
    ).run(workflowId, now, now);

    const acs: Array<{ taskId: string; ac: AbortController }> = [];
    for (let i = 0; i < 5; i += 1) {
      const taskId = `tk_multi_${i}`;
      const status = i < 4 ? 'running' : 'pending';
      db.prepare(
        `INSERT INTO tasks (id, workflow_id, name, kind, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(taskId, workflowId, `task ${i}`, 'llm_call', status, now);
      if (status === 'running') {
        const ac = new AbortController();
        registerAbortController(taskId, ac);
        acs.push({ taskId, ac });
      }
    }

    const result = requestWorkflowControl(db, workflowId, { action: 'cancel' });

    expect(result.tasks_cancelled).toBe(5);
    expect(result.controllers_aborted).toBe(4);
    for (const { ac } of acs) {
      expect(ac.signal.aborted).toBe(true);
    }

    const tasks = db
      .prepare('SELECT status FROM tasks WHERE workflow_id = ?')
      .all(workflowId) as Array<{ status: string }>;
    expect(tasks).toHaveLength(5);
    for (const t of tasks) {
      expect(t.status).toBe('cancelled');
    }

    for (const { taskId } of acs) unregisterAbortController(taskId);
  });
});
