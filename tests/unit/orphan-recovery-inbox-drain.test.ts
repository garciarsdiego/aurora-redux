// Sprint 5.6 (D-H2.066, F-REL-4): orphan recovery drains stale mailbox.
//
// Sprint 3.6 added cancelPendingForTask + dequeueFor calls to recoverOrphan
// when action='restart' so a restarted subagent doesn't inherit messages
// from the failed prior attempt. This test exercises that drain.

import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { initDb } from '../../src/db/client.js';
import { recoverOrphan } from '../../src/v2/subagent/orphan-recovery.js';
import { enqueue } from '../../src/v2/subagent/outbox.js';
import { ORPHAN_CEILING_MS } from '../../src/v2/subagent/types.js';

function makeDb(): Database.Database { return initDb(':memory:'); }

function insertWorkflow(db: Database.Database, wfId: string): void {
  db.prepare(
    `INSERT INTO workflows (id, workspace, objective, status, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(wfId, 'internal', 'orphan test', 'executing', Date.now());
}

function insertTask(db: Database.Database, taskId: string, wfId: string, status = 'running'): void {
  db.prepare(
    `INSERT INTO tasks (id, workflow_id, name, kind, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(taskId, wfId, 'Orphan Task', 'llm_call', status, Date.now());
}

function insertOrphanedRun(db: Database.Database, runId: string, taskId: string, wfId: string): void {
  // started_at past the orphan ceiling so this row is officially an orphan.
  const stale = Date.now() - ORPHAN_CEILING_MS - 60_000;
  db.prepare(
    `INSERT INTO subagent_runs
       (run_id, task_id, workflow_id, depth, task_text, status, created_at, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(runId, taskId, wfId, 0, 'work', 'running', stale, stale);
}

describe('orphan recovery — mailbox drain (Sprint 3.6, F-REL-4)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
  });

  it('restart drains pending outbox messages from the prior attempt', () => {
    insertWorkflow(db, 'wf_orphan');
    insertTask(db, 'tk_orphan', 'wf_orphan');
    insertOrphanedRun(db, 'sa_dead', 'tk_orphan', 'wf_orphan');

    // Seed pending messages FROM tk_orphan (prior attempt's outputs)
    insertTask(db, 'tk_other', 'wf_orphan');
    const a = enqueue(db, {
      workflowId: 'wf_orphan',
      fromTaskId: 'tk_orphan',
      toTaskId: 'tk_other',
      type: 'announcement',
      payload: { topic: 'topic-a', summary: 'discovered A' },
    });
    expect(a.ok).toBe(true);
    const b = enqueue(db, {
      workflowId: 'wf_orphan',
      fromTaskId: 'tk_orphan',
      toTaskId: null, // broadcast
      type: 'announcement',
      payload: { topic: 'topic-b', summary: 'discovered B' },
    });
    expect(b.ok).toBe(true);

    // Pre-condition: 2 pending messages exist
    const pendingBefore = db.prepare(
      `SELECT COUNT(*) AS c FROM subagent_messages WHERE from_task_id = ? AND status = 'pending'`,
    ).get('tk_orphan') as { c: number };
    expect(pendingBefore.c).toBe(2);

    // Recover with action=restart
    const changed = recoverOrphan(db, 'sa_dead', 'restart');
    expect(changed).toBe(true);

    // Post: outbox messages from the orphan task are cancelled
    const pendingAfter = db.prepare(
      `SELECT COUNT(*) AS c FROM subagent_messages WHERE from_task_id = ? AND status = 'pending'`,
    ).get('tk_orphan') as { c: number };
    expect(pendingAfter.c).toBe(0);

    const cancelledAfter = db.prepare(
      `SELECT COUNT(*) AS c FROM subagent_messages WHERE from_task_id = ? AND status = 'cancelled'`,
    ).get('tk_orphan') as { c: number };
    expect(cancelledAfter.c).toBe(2);

    // Subagent run was reset to pending with NULL started_at
    const runRow = db.prepare(
      `SELECT status, started_at FROM subagent_runs WHERE run_id = ?`,
    ).get('sa_dead') as { status: string; started_at: number | null };
    expect(runRow.status).toBe('pending');
    expect(runRow.started_at).toBeNull();

    // Event emitted with mailbox_drained payload
    const evRow = db.prepare(
      `SELECT payload_json FROM events WHERE task_id = ? AND type = 'subagent_orphan_restarted'`,
    ).get('tk_orphan') as { payload_json: string };
    const payload = JSON.parse(evRow.payload_json);
    expect(payload.run_id).toBe('sa_dead');
    expect(payload.mailbox_drained).toBeDefined();
    expect(payload.mailbox_drained.outbox_cancelled).toBe(2);

    db.close();
  });

  it('restart with empty mailbox emits event with zero counts (does not crash)', () => {
    insertWorkflow(db, 'wf_clean');
    insertTask(db, 'tk_clean', 'wf_clean');
    insertOrphanedRun(db, 'sa_clean', 'tk_clean', 'wf_clean');

    const changed = recoverOrphan(db, 'sa_clean', 'restart');
    expect(changed).toBe(true);

    const evRow = db.prepare(
      `SELECT payload_json FROM events WHERE task_id = ? AND type = 'subagent_orphan_restarted'`,
    ).get('tk_clean') as { payload_json: string };
    const payload = JSON.parse(evRow.payload_json);
    expect(payload.mailbox_drained.outbox_cancelled).toBe(0);
    expect(payload.mailbox_drained.inbox_dequeued).toBe(0);

    db.close();
  });

  it('action=fail does NOT drain mailbox (only restart needs it)', () => {
    insertWorkflow(db, 'wf_fail');
    insertTask(db, 'tk_fail', 'wf_fail');
    insertOrphanedRun(db, 'sa_fail', 'tk_fail', 'wf_fail');

    insertTask(db, 'tk_recv', 'wf_fail');
    enqueue(db, {
      workflowId: 'wf_fail',
      fromTaskId: 'tk_fail',
      toTaskId: 'tk_recv',
      type: 'announcement',
      payload: { topic: 'leftover', summary: 'still pending' },
    });

    const changed = recoverOrphan(db, 'sa_fail', 'fail');
    expect(changed).toBe(true);

    // Mailbox NOT drained for fail action — message remains pending.
    const pending = db.prepare(
      `SELECT COUNT(*) AS c FROM subagent_messages WHERE from_task_id = ? AND status = 'pending'`,
    ).get('tk_fail') as { c: number };
    expect(pending.c).toBe(1);

    db.close();
  });
});
