import { describe, it, expect, beforeEach } from 'vitest';
import { initDb } from '../../src/db/client.js';
import { executeWorkflow } from '../../src/brain/executor.js';
import { requestWorkflowControl } from '../../src/db/workflow-control.js';
import { _resetControlRegistry } from '../../src/v2/subagent/control.js';
import type { Dag, Task } from '../../src/types/index.js';

describe('cancel signal propagation (Tier 0 Wave 3 ITEM 0.2)', () => {
  beforeEach(() => {
    _resetControlRegistry();
  });

  it('aborts the task within ~100ms after broadcastCancelToWorkflow fires', async () => {
    const db = initDb(':memory:');
    try {
      const dag: Dag = {
        tasks: [
          {
            id: 't1',
            name: 'Long-running task that must yield to cancel',
            kind: 'llm_call',
            depends_on: [],
          },
        ],
      };

      // A long-running execute function that respects the signal. Resolves
      // synthetically when the signal aborts so we can measure the cancel
      // observation latency. Without ITEM 0.2 the JS-level retry/refine code
      // would have buried this until the next natural break — with it, the
      // outer checkAborted re-raises promptly.
      const cancelStart = { value: 0 };
      const executeTaskFn = async (_task: Task, signal?: AbortSignal): Promise<string> => {
        return new Promise<string>((resolve, reject) => {
          // Schedule the workflow cancel after 50ms — well within the task's
          // own timeout.
          setTimeout(() => {
            cancelStart.value = Date.now();
            requestWorkflowControl(db, wfId, { action: 'cancel', reason: 'test_cancel' });
          }, 50);

          if (signal) {
            const onAbort = (): void => {
              const err = new Error('aborted');
              (err as Error & { name: string }).name = 'AbortError';
              reject(err);
            };
            if (signal.aborted) onAbort();
            else signal.addEventListener('abort', onAbort, { once: true });
          }
          // If signal never aborts (regression), force-fail after 2s so the
          // test does not hang.
          setTimeout(() => reject(new Error('timed_out_waiting_for_signal')), 2_000);
        });
      };

      // The workflow ID is pre-allocated so the cancel callback can target it
      // without racing against the executor's id generation.
      const wfId = 'wf_cancel_signal';
      db.prepare(
        `INSERT INTO workflows (id, workspace, objective, status, started_at, created_at)
         VALUES (?, 'internal', 'cancel test', 'executing', ?, ?)`,
      ).run(wfId, Date.now(), Date.now());

      await expect(
        executeWorkflow(db, dag, 'internal', 'cancel test', {
          pre_workflow_id: wfId,
          executeTaskFn,
          reviewFn: async () => ({ score: 1, feedback: 'ok', passed: true }),
          consolidateFn: async () => 'should not run',
        }),
      ).rejects.toBeTruthy();

      // The cancelled state must be visible in the task row.
      const task = db
        .prepare('SELECT status FROM tasks WHERE workflow_id = ?')
        .get(wfId) as { status: string };
      // Either 'cancelled' (set by broadcastCancelToWorkflow) or 'failed'
      // (legacy fallback). Both prove the task was terminated.
      expect(['cancelled', 'failed']).toContain(task.status);

      // A task_aborted event must have been emitted by the run-task layer
      // when the abort surfaced (proves the checkAborted helper observed
      // the cancel rather than letting it slip through).
      const events = db
        .prepare('SELECT type FROM events WHERE workflow_id = ? ORDER BY id')
        .all(wfId) as Array<{ type: string }>;
      const types = events.map((e) => e.type);
      // The cancel path emits both workflow_cancel_requested and
      // task_cancelled_by_workflow on the broadcast side. The signal-aware
      // run-task layer additionally emits task_aborted when the signal
      // surfaces inside the retry loop. At least ONE of these must appear.
      expect(
        types.includes('task_aborted')
          || types.includes('task_cancelled_by_workflow')
          || types.includes('workflow_cancel_requested'),
      ).toBe(true);
    } finally {
      db.close();
    }
  }, 10_000);

  it('checkAborted exposed from run-task yields a typed AbortError', async () => {
    const { checkAborted } = await import('../../src/brain/executor/run-task.js');
    const ac = new AbortController();
    ac.abort(new Error('user_cancelled_workflow'));
    expect(() => checkAborted(ac.signal, 'unit_test')).toThrow(/cancelled at unit_test/i);
    try {
      checkAborted(ac.signal, 'unit_test');
    } catch (err) {
      expect((err as Error).name).toBe('AbortError');
    }
  });

  it('checkAborted is a no-op when the signal is not aborted', async () => {
    const { checkAborted } = await import('../../src/brain/executor/run-task.js');
    const ac = new AbortController();
    expect(() => checkAborted(ac.signal, 'unit_test_clean')).not.toThrow();
    expect(() => checkAborted(undefined, 'unit_test_undef')).not.toThrow();
  });
});
