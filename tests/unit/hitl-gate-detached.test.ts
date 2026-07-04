/**
 * Aurora W4 — verify that the detached-daemon path emits a
 * `hitl_terminal_disabled_detached` event exactly once per workflow when
 * stdin is not a TTY. The HITL gate code at `src/brain/executor/hitl-gate.ts`
 * already correctly falls through to DB-poll-only when `process.stdin.isTTY`
 * is falsy — this test guards the UX hint that surfaces that fact to the
 * dashboard inbox.
 *
 * Strategy:
 *   - stub `process.stdin.isTTY` per-case
 *   - call `runHitlGate` with a `doHitl` that never resolves (so the CLI
 *     prompt cannot win even if the TTY branch were taken)
 *   - resolve the gate via direct DB write to unblock `pollGateUntilResolved`
 *   - assert event counts via the `events` table
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { initDb } from '../../src/db/client.js';
import {
  runHitlGate,
  _resetHitlDetachedEmittedFor,
} from '../../src/brain/executor/hitl-gate.js';
import { resolveHitlGate } from '../../src/db/persist.js';
import type { Task } from '../../src/types/index.js';

function makeDb(): Database.Database {
  return initDb(':memory:');
}

function insertWorkflowRow(db: Database.Database, wfId: string): void {
  db.prepare(
    `INSERT INTO workflows (id, workspace, objective, status, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(wfId, '__test__', 'detached daemon test', 'executing', Date.now());
}

function insertTaskRow(db: Database.Database, taskId: string, wfId: string): void {
  db.prepare(
    `INSERT INTO tasks (id, workflow_id, name, kind, status, created_at, hitl)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(taskId, wfId, 'gated task', 'llm_call', 'running', Date.now(), 1);
}

function makeTask(taskId: string, wfId: string): Task {
  return {
    id: taskId,
    workflow_id: wfId,
    name: 'gated task',
    kind: 'llm_call',
    input_json: null,
    output_json: null,
    status: 'running',
    depends_on: [],
    executor_hint: null,
    timeout_seconds: 60,
    max_retries: 0,
    retry_count: 0,
    retry_policy: 'none',
    started_at: Date.now(),
    completed_at: null,
    created_at: Date.now(),
    acceptance_criteria: null,
    refine_count: 0,
    max_refine: 0,
    refine_feedback: null,
    model: null,
    hitl: true,
  } as Task;
}

function countEvents(db: Database.Database, wfId: string, type: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM events WHERE workflow_id = ? AND type = ?')
    .get(wfId, type) as { n: number } | undefined;
  return row?.n ?? 0;
}

// doHitl that never resolves — forces the dbPromise branch to win.
const stubDoHitlNever = (): Promise<'approve' | 'reject'> =>
  new Promise(() => {
    /* never resolves */
  });

interface StdinTtyOverride {
  restore: () => void;
}

function overrideStdinIsTty(value: boolean | undefined): StdinTtyOverride {
  const original = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', {
    configurable: true,
    get: () => value,
  });
  return {
    restore: () => {
      if (original) {
        Object.defineProperty(process.stdin, 'isTTY', original);
      } else {
        // No descriptor before — delete the override.
        delete (process.stdin as unknown as { isTTY?: boolean }).isTTY;
      }
    },
  };
}

describe('runHitlGate detached-daemon UX (W4)', () => {
  let stdinOverride: StdinTtyOverride | undefined;

  beforeEach(() => {
    _resetHitlDetachedEmittedFor();
  });

  afterEach(() => {
    if (stdinOverride) {
      stdinOverride.restore();
      stdinOverride = undefined;
    }
  });

  it('emits the event payload with reason + resolution metadata for dashboard surfacing', async () => {
    // Contract pin — the dashboard inbox needs to render WHY the terminal
    // is disabled (reason: stdin_not_tty) and HOW the operator should
    // resolve it (resolution: dashboard_inbox_only). This guards the
    // observable payload shape from drift.
    stdinOverride = overrideStdinIsTty(undefined);

    const db = makeDb();
    const wfId = 'wf_payload_shape';
    insertWorkflowRow(db, wfId);

    const task = makeTask('task_payload', wfId);
    insertTaskRow(db, task.id, wfId);

    setTimeout(() => {
      const gate = db
        .prepare('SELECT id FROM hitl_gates WHERE workflow_id = ? ORDER BY created_at DESC LIMIT 1')
        .get(wfId) as { id: string } | undefined;
      if (gate) resolveHitlGate(db, gate.id, 'approved');
    }, 50);

    await runHitlGate(db, task, wfId, '__test__', 'payload test', false, stubDoHitlNever);

    const row = db
      .prepare(
        `SELECT payload_json, task_id FROM events
         WHERE workflow_id = ? AND type = 'hitl_terminal_disabled_detached'
         LIMIT 1`,
      )
      .get(wfId) as { payload_json: string; task_id: string | null } | undefined;
    expect(row).toBeDefined();
    expect(row!.task_id).toBe(task.id);
    const payload = JSON.parse(row!.payload_json) as Record<string, unknown>;
    expect(payload.reason).toBe('stdin_not_tty');
    expect(payload.resolution).toBe('dashboard_inbox_only');
  });

  it('emits hitl_terminal_disabled_detached exactly once across two gates on the same workflow', async () => {
    stdinOverride = overrideStdinIsTty(undefined);

    const db = makeDb();
    const wfId = 'wf_detached_dedupe';
    insertWorkflowRow(db, wfId);

    // First gate
    const taskA = makeTask('task_a', wfId);
    insertTaskRow(db, taskA.id, wfId);

    // Schedule gate-resolution shortly after runHitlGate starts polling.
    setTimeout(() => {
      const gate = db
        .prepare('SELECT id FROM hitl_gates WHERE workflow_id = ? ORDER BY created_at DESC LIMIT 1')
        .get(wfId) as { id: string } | undefined;
      if (gate) resolveHitlGate(db, gate.id, 'approved');
    }, 50);

    await runHitlGate(db, taskA, wfId, '__test__', 'detached dedupe test', false, stubDoHitlNever);

    // Second gate on the SAME workflow
    const taskB = makeTask('task_b', wfId);
    insertTaskRow(db, taskB.id, wfId);

    setTimeout(() => {
      const gate = db
        .prepare('SELECT id FROM hitl_gates WHERE workflow_id = ? ORDER BY created_at DESC LIMIT 1')
        .get(wfId) as { id: string } | undefined;
      if (gate) resolveHitlGate(db, gate.id, 'approved');
    }, 50);

    await runHitlGate(db, taskB, wfId, '__test__', 'detached dedupe test', false, stubDoHitlNever);

    expect(countEvents(db, wfId, 'hitl_terminal_disabled_detached')).toBe(1);
  });

  it('does NOT emit hitl_terminal_disabled_detached when stdin is a TTY', async () => {
    stdinOverride = overrideStdinIsTty(true);

    const db = makeDb();
    const wfId = 'wf_tty_no_event';
    insertWorkflowRow(db, wfId);

    const task = makeTask('task_tty', wfId);
    insertTaskRow(db, task.id, wfId);

    setTimeout(() => {
      const gate = db
        .prepare('SELECT id FROM hitl_gates WHERE workflow_id = ? ORDER BY created_at DESC LIMIT 1')
        .get(wfId) as { id: string } | undefined;
      if (gate) resolveHitlGate(db, gate.id, 'approved');
    }, 50);

    // CLI branch races doHitl (never-resolving) against the DB poll — the DB
    // poll wins because of the resolveHitlGate timer above.
    await runHitlGate(db, task, wfId, '__test__', 'tty test', false, stubDoHitlNever);

    expect(countEvents(db, wfId, 'hitl_terminal_disabled_detached')).toBe(0);
  });

  it('re-emits the event for the same workflow after a daemon-lifetime reset', async () => {
    // Contract from hitl-gate.ts:20-23 — the dedupe Set is keyed to the
    // daemon's process lifetime. When the daemon restarts (test mirror:
    // calling _resetHitlDetachedEmittedFor()) the same workflow should
    // surface the hint again on its next gate so the dashboard inbox keeps
    // accurate visibility. This guards against the dedupe set leaking
    // semantics across daemon restarts.
    stdinOverride = overrideStdinIsTty(undefined);

    const db = makeDb();
    const wfId = 'wf_lifetime_reset';
    insertWorkflowRow(db, wfId);

    const taskA = makeTask('task_lifetime_a', wfId);
    insertTaskRow(db, taskA.id, wfId);

    setTimeout(() => {
      const gate = db
        .prepare('SELECT id FROM hitl_gates WHERE workflow_id = ? ORDER BY created_at DESC LIMIT 1')
        .get(wfId) as { id: string } | undefined;
      if (gate) resolveHitlGate(db, gate.id, 'approved');
    }, 50);

    await runHitlGate(db, taskA, wfId, '__test__', 'lifetime test', false, stubDoHitlNever);
    expect(countEvents(db, wfId, 'hitl_terminal_disabled_detached')).toBe(1);

    // Simulate daemon restart — dedupe set is cleared.
    _resetHitlDetachedEmittedFor();

    const taskB = makeTask('task_lifetime_b', wfId);
    insertTaskRow(db, taskB.id, wfId);

    setTimeout(() => {
      const gate = db
        .prepare('SELECT id FROM hitl_gates WHERE workflow_id = ? ORDER BY created_at DESC LIMIT 1')
        .get(wfId) as { id: string } | undefined;
      if (gate) resolveHitlGate(db, gate.id, 'approved');
    }, 50);

    await runHitlGate(db, taskB, wfId, '__test__', 'lifetime test', false, stubDoHitlNever);
    // Total count is 2 now — one per daemon lifetime.
    expect(countEvents(db, wfId, 'hitl_terminal_disabled_detached')).toBe(2);
  });

  it('emits one event per workflow when two different workflows run detached', async () => {
    stdinOverride = overrideStdinIsTty(undefined);

    const db = makeDb();
    const wfA = 'wf_detached_a';
    const wfB = 'wf_detached_b';
    insertWorkflowRow(db, wfA);
    insertWorkflowRow(db, wfB);

    const taskA = makeTask('task_in_a', wfA);
    const taskB = makeTask('task_in_b', wfB);
    insertTaskRow(db, taskA.id, wfA);
    insertTaskRow(db, taskB.id, wfB);

    setTimeout(() => {
      const gate = db
        .prepare('SELECT id FROM hitl_gates WHERE workflow_id = ? ORDER BY created_at DESC LIMIT 1')
        .get(wfA) as { id: string } | undefined;
      if (gate) resolveHitlGate(db, gate.id, 'approved');
    }, 50);

    await runHitlGate(db, taskA, wfA, '__test__', 'wf a', false, stubDoHitlNever);

    setTimeout(() => {
      const gate = db
        .prepare('SELECT id FROM hitl_gates WHERE workflow_id = ? ORDER BY created_at DESC LIMIT 1')
        .get(wfB) as { id: string } | undefined;
      if (gate) resolveHitlGate(db, gate.id, 'approved');
    }, 50);

    await runHitlGate(db, taskB, wfB, '__test__', 'wf b', false, stubDoHitlNever);

    expect(countEvents(db, wfA, 'hitl_terminal_disabled_detached')).toBe(1);
    expect(countEvents(db, wfB, 'hitl_terminal_disabled_detached')).toBe(1);
  });
});
