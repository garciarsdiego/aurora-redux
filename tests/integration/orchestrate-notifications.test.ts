/**
 * WIRE-04 — notification WRITE side, end-to-end through executeWorkflow.
 *
 * Before this wiring, src/mcp/notification-service.ts exposed
 * notifyWorkflowCompleted / notifyWorkflowFailed / notifyGatePending but NOTHING
 * called them, so the dashboard bell / inbox panel read a `notifications` table
 * that was never written. This test proves the orchestrator now writes a
 * `workflow_completed` notification row when a workflow finishes successfully.
 *
 * Setup mirrors tests/integration/orchestrate-deterministic-state.test.ts:
 *   - vi.hoisted + vi.mock omniroute  (keep the run offline)
 *   - stub review + consolidate       (deterministic, self-contained)
 *
 * NOTE on the DB seam: the notification service opens its OWN connection via
 * initDb(getDbPath()) rather than the `db` passed to executeWorkflow. To make
 * both connections point at the same SQLite file, the test sets process.env.
 * DB_PATH to a temp file and uses that same path for executeWorkflow's db.
 * better-sqlite3 commits each statement synchronously and WAL lets the second
 * connection see committed rows, so the notification is visible after the
 * fire-and-forget promise flushes.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Stub Omniroute BEFORE importing the executor that pulls it transitively.
const omnirouteMock = vi.hoisted(() => ({
  callOmniroute: vi.fn(),
  callOmnirouteWithUsage: vi.fn(),
}));
vi.mock('../../src/utils/omniroute-call.js', () => omnirouteMock);

import { initDb } from '../../src/db/client.js';
import { executeWorkflow } from '../../src/brain/executor.js';
import type { Dag, ReviewResult, Task } from '../../src/types/index.js';

const stubConsolidate = async (): Promise<string> => 'stub consolidated output';
const stubReview = async (): Promise<ReviewResult> => ({ score: 1, feedback: 'ok', passed: true });

interface NotificationRow {
  id: string;
  type: string;
  workflow_id: string | null;
  title: string;
}

/**
 * The completion notification is dispatched fire-and-forget (the orchestrator
 * does NOT await it). Poll the table for a short window so the async
 * createNotification microtask chain has time to commit its row.
 */
async function waitForNotification(
  dbPath: string,
  workflowId: string,
  type: string,
  timeoutMs = 2000,
): Promise<NotificationRow | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const probe = initDb(dbPath);
    try {
      const row = probe
        .prepare(
          `SELECT id, type, workflow_id, title FROM notifications
           WHERE workflow_id = ? AND type = ?`,
        )
        .get(workflowId, type) as NotificationRow | undefined;
      if (row) return row;
    } finally {
      probe.close();
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  return undefined;
}

describe('orchestrate notification write side (WIRE-04) — end-to-end', () => {
  let tmpDir: string;
  let dbPath: string;
  const prevDbPath = process.env.DB_PATH;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'omniforge-notif-'));
    dbPath = join(tmpDir, 'notif-test.db');
    process.env.DB_PATH = dbPath;

    omnirouteMock.callOmniroute.mockReset();
    omnirouteMock.callOmnirouteWithUsage.mockReset();
    omnirouteMock.callOmnirouteWithUsage.mockResolvedValue({
      content: 'done',
      usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
    });
    omnirouteMock.callOmniroute.mockResolvedValue('done');
  });

  afterEach(() => {
    if (prevDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = prevDbPath;
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Best-effort temp cleanup; WAL sidecar files may still be held briefly.
    }
  });

  it('writes a workflow_completed notification row when a workflow completes', async () => {
    const db = initDb(dbPath);

    const dag: Dag = {
      tasks: [
        {
          id: 't1',
          name: 'Say done',
          kind: 'print',
          depends_on: [],
          print_template: 'all done',
          output_key: 'final_answer',
          acceptance_criteria: 'prints a line',
        },
      ],
    } as unknown as Dag;

    const wf = await executeWorkflow(db, dag, 'internal', 'notify test objective', {
      autoApprove: true,
      quotaGuardMode: 'off',
      consolidateFn: stubConsolidate,
      reviewFn: stubReview,
    });
    expect(wf.status).toBe('completed');

    const row = await waitForNotification(dbPath, wf.id, 'workflow_completed');
    expect(row).toBeTruthy();
    expect(row?.type).toBe('workflow_completed');
    expect(row?.workflow_id).toBe(wf.id);
    expect(row?.title).toBe('Workflow completed');

    db.close();
  });

  it('records a failure reflection when the workflow fails (INTEL-05)', async () => {
    const db = initDb(dbPath);

    const dag: Dag = {
      tasks: [
        {
          id: 't1',
          name: 'Doomed task',
          kind: 'llm_call',
          depends_on: [],
          acceptance_criteria: 'should have produced output',
        },
      ],
    } as unknown as Dag;

    // Force a non-abort failure: the executor throws, so the workflow ends in
    // the executeWorkflow catch branch where INTEL-05 records a failure
    // reflection (previously dropped — only success reflections were written).
    await expect(
      executeWorkflow(db, dag, 'internal', 'a deliberately failing render objective', {
        autoApprove: true,
        quotaGuardMode: 'off',
        consolidateFn: stubConsolidate,
        reviewFn: stubReview,
        executeTaskFn: async (_task: Task): Promise<string> => {
          throw new Error('synthetic executor failure');
        },
      }),
    ).rejects.toThrow();

    // The reflection recorder uses objectiveShape(); confirm the failure row
    // landed with outcome='failure' and a failure-themed lesson.
    const probe = initDb(dbPath);
    try {
      const refl = probe
        .prepare(
          `SELECT outcome, lessons_learned FROM reflection_store
           WHERE objective = ? ORDER BY created_at DESC LIMIT 1`,
        )
        .get('a deliberately failing render objective') as
        | { outcome: string; lessons_learned: string }
        | undefined;
      expect(refl).toBeTruthy();
      expect(refl?.outcome).toBe('failure');
      expect(refl?.lessons_learned).toContain('Failed');
    } finally {
      probe.close();
    }

    db.close();
  });
});
